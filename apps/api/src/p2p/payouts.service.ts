import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { OrgPrincipal } from '@/auth/auth.types';
import { DeploymentsService } from '@/chain/deployments.service';
import { MarketReader } from '@/chain/market-reader.service';
import type { Tier } from '@/chain/networks';
import { ApiError, ErrorCode } from '@/common/api-error';
import { page, type Page } from '@/common/pagination';
import type { Prisma } from '@/generated/prisma/client';
import { AccountsService } from '@/p2p/accounts.service';
import { P2P_PAYOUT_SETTLE_WINDOW_SECONDS } from '@/p2p/domain/constants';
import { P2P_FINAL_STATUSES, type P2pOrderStatus } from '@/p2p/domain/order-status';
import type { CreatePayoutDto, QueryPayoutsDto } from '@/p2p/dto/charge.dto';
import type { PayoutBatchView } from '@/p2p/entities/charge.entity';
import { OrderOpener } from '@/p2p/order-opener.service';
import { OrdersService } from '@/p2p/orders.service';
import { QuotesService, checkRail, fiatUnitsOf, windowsFor } from '@/p2p/quotes.service';
import { tierOf } from '@/p2p/tier';
import { P2P_ORDER_SELECT, type P2pOrderRow } from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';
import { enqueueWebhooks, type Tx } from '@/webhooks/webhook-outbox';

/** An item no merchant could take when its batch was created. */
export interface P2pFailedPayoutItem {
  index: number;
  currency: string;
  fiatAmount: string;
  externalReference: string | null;
  reason: string;
}

function failedItemsOf(value: unknown): P2pFailedPayoutItem[] {
  return Array.isArray(value) ? (value as P2pFailedPayoutItem[]) : [];
}

const BATCH_SELECT = {
  id: true,
  tier: true,
  network: true,
  token: true,
  accountId: true,
  status: true,
  itemCount: true,
  failedItems: true,
  completedAt: true,
  createdAt: true,
} as const;

/**
 * Payouts in local money from a client's balance in the contract. The client
 * registered the paying account, deposited tokens and authorised the matcher
 * (`setMatcher`, through `POST /v1/p2p/transactions`); each item is then
 * matched with a merchant that buys tokens and opened by the matcher on the
 * client's balance (the client sells, the merchant buys with a bond). The
 * merchant accepts, pays the beneficiary and marks the order paid; the client
 * releases it, or, if it allowed `autoSettle`, silence after six hours does.
 *
 * Items are opened one after another in the request; an item no merchant can
 * take right now is an order `failed` with its reason, never a hole in the
 * batch.
 */
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly deployments: DeploymentsService,
    private readonly reader: MarketReader,
    private readonly quotes: QuotesService,
    private readonly opener: OrderOpener,
    private readonly orders: OrdersService,
  ) {}

  async create(org: OrgPrincipal, dto: CreatePayoutDto): Promise<PayoutBatchView> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const account = dto.accountId
      ? await this.accounts.owned(organizationId, tier, dto.accountId)
      : await this.accounts.soleAccount(organizationId, tier, 'paying out');
    const deployment = await this.reader.requireLive(tier, dto.network);
    const token = this.deployments.token(deployment, dto.token);
    const items = dto.items.map((item, i) => {
      checkRail(item.rail, item.currency);
      return {
        item,
        fiatUnits: fiatUnitsOf(item.currency, item.fiatAmount),
        beneficiary: this.orders.checkBeneficiary(item.beneficiary, item.rail, item.currency),
        index: i,
      };
    });
    const matcher = this.deployments.matcherAddress();
    if (!matcher) {
      throw ApiError.unavailable(
        'The P2P market cannot open payouts on this deployment right now.',
        'P2P_MATCHER_PRIVATE_KEY is not set.',
      );
    }
    const [terms, protocol] = await Promise.all([
      this.reader.matcherTerms(deployment, account.address, matcher, true),
      this.quotes.openProtocol(deployment),
    ]);
    if (terms.maxPerOrder === 0n) {
      throw ApiError.badRequest(
        ErrorCode.InvalidState,
        'This account has not authorised the matcher on this network: send setMatcher first (POST /v1/p2p/transactions, action setMatcher).',
      );
    }
    const settleWindow = terms.autoSettle ? P2P_PAYOUT_SETTLE_WINDOW_SECONDS : 0;

    const batch = await this.prisma.p2pPayoutBatch.create({
      data: {
        organizationId,
        tier,
        network: deployment.network,
        token: token.address,
        accountId: account.id,
        sellerAddress: account.address,
        itemCount: items.length,
      },
      select: { id: true },
    });

    const failed: P2pFailedPayoutItem[] = [];
    const fail = (index: number, reason: string) => {
      const item = dto.items[index];
      failed.push({
        index,
        currency: item.currency,
        fiatAmount: item.fiatAmount,
        externalReference: item.externalReference?.trim() || null,
        reason,
      });
    };
    for (const { item, fiatUnits, beneficiary, index } of items) {
      const match = await this.quotes.match({
        deployment,
        token,
        side: 'SELL',
        currency: item.currency,
        rail: item.rail,
        fiatUnits,
        protocolFeeBps: protocol.feeBps,
        integratorFeeBps: 0,
        counterparty: account.address,
      });
      if (!match) {
        fail(index, 'no merchant could take it');
        continue;
      }
      if (match.amounts.grossTokens > terms.maxPerOrder) {
        fail(index, 'it is above the per-order cap this account set for the matcher');
        continue;
      }
      let written = false;
      try {
        const row = await this.opener.insert({
          id: randomUUID(),
          organizationId,
          kind: 'PAYOUT',
          deployment,
          token,
          match,
          currency: item.currency,
          rail: item.rail,
          sellerAddress: account.address,
          buyerAddress: match.account.address,
          openerAddress: matcher,
          windows: { ...windowsFor('SELL'), settleWindow },
          protocolFeeBps: protocol.feeBps,
          integratorFeeBps: 0,
          integratorAddress: null,
          payoutBatchId: batch.id,
          externalReference: item.externalReference?.trim() || null,
          beneficiary,
        });
        written = true;
        await this.opener.openViaMatcher(deployment, row);
      } catch (err) {
        // A merchant that filled up meanwhile (no order written), or an open
        // the opener already failed: either way the item did not open.
        this.logger.warn(`P2P payout batch ${batch.id}: item ${index} not opened: ${String(err)}`);
        if (!written) fail(index, 'no merchant could take it');
      }
    }
    if (failed.length > 0) {
      await this.prisma.p2pPayoutBatch.update({
        where: { id: batch.id },
        data: { failedItems: failed as unknown as Prisma.InputJsonValue },
      });
    }
    await this.prisma.$transaction((tx) => this.refresh(tx, batch.id));
    return this.view(organizationId, tier, batch.id);
  }

  async list(org: OrgPrincipal, query: QueryPayoutsDto): Promise<Page<PayoutBatchView>> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const where = { organizationId, tier };
    const [rows, total] = await Promise.all([
      this.prisma.p2pPayoutBatch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: BATCH_SELECT,
      }),
      this.prisma.p2pPayoutBatch.count({ where }),
    ]);
    return page(
      rows.map((r) => ({
        ...r,
        failedItems: failedItemsOf(r.failedItems),
        orders: [],
      })),
      total,
      query,
    );
  }

  async get(org: OrgPrincipal, id: string): Promise<PayoutBatchView> {
    const tier = tierOf(org, this.deployments);
    return this.view(org.organizationId, tier, id);
  }

  private async view(organizationId: string, tier: Tier, id: string): Promise<PayoutBatchView> {
    const batch = await this.prisma.p2pPayoutBatch.findFirst({
      where: { id, organizationId, tier },
      select: BATCH_SELECT,
    });
    if (!batch) throw ApiError.notFound(`P2P payout batch ${id} not found`);
    const orders = await this.prisma.p2pOrder.findMany({
      where: { payoutBatchId: id, organizationId, tier },
      orderBy: { createdAt: 'asc' },
      select: P2P_ORDER_SELECT,
    });
    return {
      ...batch,
      failedItems: failedItemsOf(batch.failedItems),
      orders: await Promise.all(orders.map((o) => this.orders.clientView(o, false))),
    };
  }

  /**
   * A batch is `processing` while any of its orders is live, then `completed`
   * (all completed), `failed` (none did) or `partially_completed`. Moves once
   * (compare-and-swap on `processing`) and notifies `P2P_PAYOUT_BATCH_COMPLETED`.
   */
  async refresh(tx: Tx, batchId: string): Promise<void> {
    const batch = await tx.p2pPayoutBatch.findUnique({
      where: { id: batchId },
      select: { ...BATCH_SELECT, organizationId: true },
    });
    if (!batch || batch.status !== 'processing') return;
    const orders = await tx.p2pOrder.findMany({
      where: { payoutBatchId: batchId },
      select: { status: true },
    });
    const ended = orders.filter((o) => P2P_FINAL_STATUSES.includes(o.status as P2pOrderStatus));
    const failedItems = failedItemsOf(batch.failedItems);
    if (ended.length + failedItems.length < batch.itemCount) return;
    const completed = ended.filter((o) => o.status === 'completed').length;
    const status =
      completed === batch.itemCount
        ? 'completed'
        : completed === 0
          ? 'failed'
          : 'partially_completed';
    const moved = await tx.p2pPayoutBatch.updateMany({
      where: { id: batchId, status: 'processing' },
      data: { status, completedAt: new Date() },
    });
    if (moved.count === 1) {
      await enqueueWebhooks(tx, [
        {
          organizationId: batch.organizationId,
          tier: batch.tier,
          type: 'P2P_PAYOUT_BATCH_COMPLETED',
          data: {
            id: batch.id,
            status,
            itemCount: batch.itemCount,
            completed,
            network: batch.network,
            token: batch.token,
            accountId: batch.accountId,
          },
        },
      ]);
    }
  }

  /** An order of a batch ended: the batch may have too. */
  async onOrderEnded(tx: Tx, order: P2pOrderRow): Promise<void> {
    if (order.payoutBatchId) await this.refresh(tx, order.payoutBatchId);
  }
}
