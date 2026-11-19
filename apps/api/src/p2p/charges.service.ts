import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { OrgPrincipal } from '@/auth/auth.types';
import { DeploymentsService } from '@/chain/deployments.service';
import { MarketReader } from '@/chain/market-reader.service';
import type { Tier } from '@/chain/networks';
import { ApiError, ErrorCode } from '@/common/api-error';
import { page, type Page } from '@/common/pagination';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { AccountsService } from '@/p2p/accounts.service';
import { P2P_CURRENCIES, type P2pCurrency } from '@/p2p/domain/constants';
import { isUuid } from '@/p2p/domain/order-ref';
import { formatUnits } from '@/p2p/domain/pricing';
import type { CreateChargeDto, QueryChargesDto } from '@/p2p/dto/charge.dto';
import type { ChargeView } from '@/p2p/entities/charge.entity';
import { fiatUnitsOf } from '@/p2p/quotes.service';
import { tierOf } from '@/p2p/tier';
import { P2P_CHARGE_SELECT, toChargeView, type P2pChargeRow, type P2pOrderRow } from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';
import { enqueueWebhooks, type Tx } from '@/webhooks/webhook-outbox';

/** A charge with no `expiresAt` is payable for a day. */
const DEFAULT_CHARGE_TTL_MS = 24 * 60 * 60 * 1000;
/** And never for more than 30 days. */
const MAX_CHARGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Charges (collections): an amount of local money a client's customer pays
 * on the hosted page, as a purchase whose tokens go to one of the client's
 * registered wallets. The payer's keyless half is `CheckoutService`; this is
 * the client's (create, list, read, cancel) and the charge's own bookkeeping
 * when one of its orders completes.
 */
@Injectable()
export class ChargesService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly deployments: DeploymentsService,
    private readonly reader: MarketReader,
  ) {}

  private symbolOf(row: { tier: string; network: string; token: string }): string {
    const d = this.deployments.find(row.tier as Tier, row.network);
    return (
      d?.tokens.find((t) => t.address.toLowerCase() === row.token.toLowerCase())?.symbol ??
      row.token
    );
  }

  /** A charge as its creator reads it, with its payer page's URL. */
  view(row: P2pChargeRow): ChargeView {
    return toChargeView(row, this.symbolOf(row), this.config.p2p.checkoutUrl, new Date());
  }

  async create(org: OrgPrincipal, dto: CreateChargeDto): Promise<ChargeView> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const deployment = await this.reader.requireLive(tier, dto.network);
    const token = this.deployments.token(deployment, dto.token);
    const recipient = await this.accounts.ownedByRef(organizationId, tier, dto.recipient);
    const units = fiatUnitsOf(dto.currency, dto.fiatAmount);
    const now = Date.now();
    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : new Date(now + DEFAULT_CHARGE_TTL_MS);
    if (expiresAt.getTime() <= now || expiresAt.getTime() > now + MAX_CHARGE_TTL_MS) {
      throw ApiError.validation(['expiresAt must be in the future and at most 30 days away']);
    }
    const row = await this.prisma.p2pCharge.create({
      data: {
        id: randomUUID(),
        organizationId,
        tier,
        network: deployment.network,
        token: token.address,
        currency: dto.currency,
        fiatAmount: formatUnits(units, P2P_CURRENCIES[dto.currency as P2pCurrency].decimals),
        recipientAccountId: recipient.id,
        recipientAddress: recipient.address,
        payeeName: dto.payeeName.trim(),
        description: dto.description?.trim() || null,
        multiUse: dto.multiUse ?? false,
        expiresAt,
      },
      select: P2P_CHARGE_SELECT,
    });
    return this.view(row);
  }

  async list(org: OrgPrincipal, query: QueryChargesDto): Promise<Page<ChargeView>> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const where = { organizationId, tier };
    const [rows, total] = await Promise.all([
      this.prisma.p2pCharge.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_CHARGE_SELECT,
      }),
      this.prisma.p2pCharge.count({ where }),
    ]);
    return page(
      rows.map((r) => this.view(r)),
      total,
      query,
    );
  }

  private async owned(organizationId: string, tier: Tier, id: string) {
    const row = isUuid(id)
      ? await this.prisma.p2pCharge.findFirst({
          where: { id, organizationId, tier },
          select: P2P_CHARGE_SELECT,
        })
      : null;
    if (!row) throw ApiError.notFound(`P2P charge ${id} not found`);
    return row;
  }

  async get(org: OrgPrincipal, id: string): Promise<ChargeView> {
    const tier = tierOf(org, this.deployments);
    return this.view(await this.owned(org.organizationId, tier, id));
  }

  /**
   * Stops new orders on an open charge. An order already under way goes on:
   * its payer may have sent the money, and its completion still pays the
   * recipient (and is counted).
   */
  async cancel(org: OrgPrincipal, id: string): Promise<ChargeView> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const row = await this.owned(organizationId, tier, id);
    if (row.status !== 'open') {
      throw ApiError.conflict(
        ErrorCode.ChargeClosed,
        `P2P charge ${id} is ${row.status}: it can no longer be cancelled`,
      );
    }
    await this.prisma.p2pCharge.updateMany({
      where: { id: row.id, organizationId, tier, status: 'open' },
      data: { status: 'cancelled' },
    });
    return this.view(await this.owned(organizationId, tier, id));
  }

  /**
   * One of the charge's orders completed: count it, close a single-use charge
   * (a compare-and-swap on `open`, so a cancel racing it keeps `cancelled`)
   * and notify the client with `P2P_CHARGE_SUCCEEDED`, once per paying order.
   */
  async onOrderCompleted(tx: Tx, order: P2pOrderRow): Promise<void> {
    if (!order.chargeId) return;
    const charge = await tx.p2pCharge.update({
      where: { id: order.chargeId },
      data: { paidCount: { increment: 1 }, paidAt: new Date() },
      select: { ...P2P_CHARGE_SELECT, organizationId: true },
    });
    if (!charge.multiUse) {
      await tx.p2pCharge.updateMany({
        where: { id: charge.id, status: 'open' },
        data: { status: 'paid' },
      });
    }
    const now = await tx.p2pCharge.findUniqueOrThrow({
      where: { id: charge.id },
      select: P2P_CHARGE_SELECT,
    });
    await enqueueWebhooks(tx, [
      {
        organizationId: charge.organizationId,
        tier: charge.tier,
        type: 'P2P_CHARGE_SUCCEEDED',
        data: { ...this.view(now), orderId: order.id },
      },
    ]);
  }
}
