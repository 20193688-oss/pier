import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChainClient, type ChainLog } from '@/chain/chain-client.service';
import { DeploymentsService, type Deployment } from '@/chain/deployments.service';
import { decodeP2pMarketLog, P2P_EVENT_TOPICS, type P2pMarketEvent } from '@/chain/market-codec';
import { MarketReader } from '@/chain/market-reader.service';
import { sameAddress } from '@/common/evm';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import type { Prisma } from '@/generated/prisma/client';
import { JOB_LOCK_KEYS, ScheduledJob } from '@/jobs/scheduled-job';
import { ChargesService } from '@/p2p/charges.service';
import { P2P_INDEXER_MAX_CALLS, P2P_INDEXER_REREAD_BLOCKS } from '@/p2p/domain/constants';
import { openParamsOf } from '@/p2p/domain/order-ref';
import {
  cancellationStatus,
  medianSeconds,
  merchantAtFault,
  merchantLostDispute,
  openableFrom,
  P2P_EVENT_TRANSITIONS,
  P2P_MERCHANT_SIDE,
  type P2pOrderKind,
  type P2pOrderStatus,
} from '@/p2p/domain/order-status';
import { orderEvents, STATUS_EVENTS } from '@/p2p/p2p-events';
import { PayoutsService } from '@/p2p/payouts.service';
import { P2P_ORDER_SELECT, type P2pOrderRow } from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';
import { enqueueWebhooks, type Tx } from '@/webhooks/webhook-outbox';

/** The topics the indexer asks for; `MatcherSet` is read live, never stored. */
const INDEXED_TOPICS = [
  P2P_EVENT_TOPICS.OperatorSet,
  P2P_EVENT_TOPICS.OrderOpened,
  P2P_EVENT_TOPICS.OrderAccepted,
  P2P_EVENT_TOPICS.OrderPaid,
  P2P_EVENT_TOPICS.OrderReleased,
  P2P_EVENT_TOPICS.OrderCancelled,
  P2P_EVENT_TOPICS.OrderDisputed,
  P2P_EVENT_TOPICS.OrderResolved,
];

/** Recent completed orders a merchant's median release time is taken over. */
const MEDIAN_WINDOW = 50;

interface IndexedLog {
  event: P2pMarketEvent;
  block: bigint;
  txHash: string;
}

/** Logs in chain order: block, then index in the block. */
export function sortLogs(logs: readonly ChainLog[]): ChainLog[] {
  return [...logs].sort((a, b) => {
    const block = BigInt(a.blockNumber) - BigInt(b.blockNumber);
    if (block !== 0n) return block < 0n ? -1 : 1;
    return Number(BigInt(a.logIndex) - BigInt(b.logIndex));
  });
}

/**
 * Follows every P2PMarket deployment and moves our orders on what the chain
 * shows. Per deployment and tick: `eth_getLogs` from the cursor in ranges the
 * network's nodes accept (at most {@link P2P_INDEXER_MAX_CALLS}), only up to
 * `head - confirmations`, re-reading the last {@link P2P_INDEXER_REREAD_BLOCKS}
 * confirmed blocks every time. Every write is a compare-and-swap from the
 * statuses an event may move (`P2P_EVENT_TRANSITIONS`), committed in ONE
 * transaction with its webhook events and the charge / payout bookkeeping, so
 * a log read twice changes nothing and a stale one never moves an order back.
 *
 * An `OrderOpened` is ours only when its `ref` is one of our orders, from the
 * opener that order expects (the matcher, or the person selling), and every
 * field equals the order's; a sale's windows and integrator, which the event
 * does not carry, are read back with `getOrder`. A copy of our ref under
 * another opener is someone else's order and is ignored.
 */
@Injectable()
export class IndexerJob extends ScheduledJob {
  protected readonly logger = new Logger(IndexerJob.name);
  protected readonly lockKey = JOB_LOCK_KEYS.indexer;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly chain: ChainClient,
    private readonly reader: MarketReader,
    private readonly charges: ChargesService,
    private readonly payouts: PayoutsService,
  ) {
    super(prisma);
  }

  protected enabled(): boolean {
    return this.config.jobs.enabled && this.deployments.anyConfigured();
  }

  protected intervalMs(): number {
    return this.config.jobs.intervalMs;
  }

  protected override lockTimeoutMs(): number {
    return this.deployments.timeoutMs() * (P2P_INDEXER_MAX_CALLS * 3 + 20);
  }

  protected async run(): Promise<void> {
    for (const tier of ['live', 'test'] as const) {
      for (const d of await this.reader.liveDeployments(tier)) {
        try {
          await this.indexDeployment(d);
        } catch (err) {
          this.logger.warn(
            `${d.network}/${d.tier}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  /** One deployment's tick. */
  async indexDeployment(d: Deployment): Promise<void> {
    const key = { tier: d.tier, network: d.network, contract: d.contract };
    const cursor = await this.prisma.p2pChainCursor.findUnique({
      where: { tier_network_contract: key },
      select: { lastBlock: true },
    });
    const last = cursor?.lastBlock ?? d.deployBlock - 1n;
    const head = await this.chain.blockNumber(d);
    const safe = head - BigInt(d.confirmations);
    const reread = last + 1n - P2P_INDEXER_REREAD_BLOCKS;
    const from = reread > d.deployBlock ? reread : d.deployBlock;
    if (from > safe) return;
    const range = BigInt(d.logBlockRange);
    const ceiling = from + range * BigInt(P2P_INDEXER_MAX_CALLS) - 1n;
    const to = safe < ceiling ? safe : ceiling;

    const times = new Map<bigint, number>();
    for (let start = from; start <= to; start += range) {
      const end = start + range - 1n < to ? start + range - 1n : to;
      const logs = await this.chain.getLogs(d, INDEXED_TOPICS, start, end);
      for (const log of sortLogs(logs)) {
        const indexed = this.decode(d, log);
        if (indexed) await this.apply(d, indexed, times);
      }
      const reached = end > last ? end : last;
      await this.prisma.p2pChainCursor.upsert({
        where: { tier_network_contract: key },
        create: { ...key, lastBlock: reached },
        update: { lastBlock: reached },
      });
    }
  }

  private decode(d: Deployment, log: ChainLog): IndexedLog | null {
    if (log.removed || !sameAddress(log.address, d.contract)) return null;
    try {
      const event = decodeP2pMarketLog(log);
      return event ? { event, block: BigInt(log.blockNumber), txHash: log.transactionHash } : null;
    } catch (err) {
      this.logger.warn(
        `${d.network}/${d.tier}: log ${log.transactionHash}#${log.logIndex} not decoded: ${String(err)}`,
      );
      return null;
    }
  }

  private async blockTime(
    d: Deployment,
    block: bigint,
    times: Map<bigint, number>,
  ): Promise<number> {
    const cached = times.get(block);
    if (cached !== undefined) return cached;
    const at = (await this.chain.blockTimestamp(d, block)) ?? Math.floor(Date.now() / 1000);
    times.set(block, at);
    return at;
  }

  private byChainId(d: Deployment, id: bigint): Promise<P2pOrderRow | null> {
    return this.prisma.p2pOrder.findUnique({
      where: {
        tier_network_contract_onchainId: {
          tier: d.tier,
          network: d.network,
          contract: d.contract,
          onchainId: id.toString(),
        },
      },
      select: P2P_ORDER_SELECT,
    });
  }

  private async apply(d: Deployment, log: IndexedLog, times: Map<bigint, number>): Promise<void> {
    const { event } = log;
    switch (event.name) {
      case 'OperatorSet':
        return this.operatorSet(d, event);
      case 'MatcherSet':
        return;
      case 'OrderOpened':
        return this.opened(d, event, log, times);
      default:
        break;
    }
    const row = await this.byChainId(d, event.id);
    if (!row) return;
    const at = await this.blockTime(d, log.block, times);
    const when = new Date(at * 1000);
    switch (event.name) {
      case 'OrderAccepted':
        if (row.status === 'awaiting_payment' && !row.paymentDeadline) {
          await this.prisma.p2pOrder.updateMany({
            where: { id: row.id, paymentDeadline: null },
            data: { paymentDeadline: new Date(event.paymentDeadline * 1000) },
          });
          return;
        }
        await this.move(row, 'OrderAccepted', {
          chainStatus: 'Active',
          paymentDeadline: new Date(event.paymentDeadline * 1000),
          acceptTxHash: log.txHash,
        });
        return;
      case 'OrderPaid':
        await this.move(row, 'OrderPaid', {
          chainStatus: 'Paid',
          paidAt: when,
          paidTxHash: log.txHash,
        });
        return;
      case 'OrderDisputed':
        await this.move(row, 'OrderDisputed', {
          chainStatus: 'Disputed',
          disputeTxHash: log.txHash,
        });
        return;
      case 'OrderReleased':
        await this.move(
          row,
          'OrderReleased',
          {
            chainStatus: 'Released',
            endedAt: when,
            releaseTxHash: log.txHash,
            settlement: {
              toBuyer: event.toBuyer.toString(),
              toSeller: '0',
              bondToSeller: '0',
              protocolFee: event.protocolFee.toString(),
              integratorFee: event.integratorFee.toString(),
            },
          },
          undefined,
          async (tx, moved) => {
            await this.completedStats(tx, moved, when);
            await this.charges.onOrderCompleted(tx, moved);
            await this.payouts.onOrderEnded(tx, moved);
          },
        );
        return;
      case 'OrderCancelled': {
        const previous = row.status as P2pOrderStatus;
        const outcome = cancellationStatus({
          previous,
          at,
          acceptDeadline: row.acceptDeadline ? row.acceptDeadline.getTime() / 1000 : null,
          paymentDeadline: row.paymentDeadline ? row.paymentDeadline.getTime() / 1000 : null,
        });
        await this.move(
          row,
          'OrderCancelled',
          { chainStatus: 'Cancelled', endedAt: when, cancelTxHash: log.txHash },
          outcome,
          async (tx, moved) => {
            const byMerchant = sameAddress(event.by, row.merchantAddress);
            if (merchantAtFault(row.kind as P2pOrderKind, previous, outcome, byMerchant)) {
              await this.bumpMerchant(tx, row.merchantAccountId, {
                cancelledOrders: { increment: 1 },
              });
            }
            await this.payouts.onOrderEnded(tx, moved);
          },
        );
        return;
      }
      case 'OrderResolved':
        await this.move(
          row,
          'OrderResolved',
          {
            chainStatus: 'Resolved',
            endedAt: when,
            resolveTxHash: log.txHash,
            settlement: {
              toBuyer: event.toBuyer.toString(),
              toSeller: event.toSeller.toString(),
              bondToSeller: event.bondToSeller.toString(),
              protocolFee: event.protocolFee.toString(),
              integratorFee: event.integratorFee.toString(),
            },
          },
          undefined,
          async (tx, moved) => {
            if (
              merchantLostDispute(row.kind as P2pOrderKind, BigInt(row.tokenAmount), event.toBuyer)
            ) {
              await this.bumpMerchant(tx, row.merchantAccountId, {
                disputesLost: { increment: 1 },
              });
            }
            // A resolution that paid a charge's buyer delivered what the charge asked.
            if (event.toBuyer > 0n) await this.charges.onOrderCompleted(tx, moved);
            await this.payouts.onOrderEnded(tx, moved);
          },
        );
        return;
    }
  }

  /**
   * One compare-and-swap, in one transaction with its webhook events and
   * `after` (the bookkeeping the move causes). Nothing happens when the order
   * already moved (a log read again) or is elsewhere.
   */
  private async move(
    row: P2pOrderRow,
    event: keyof typeof P2P_EVENT_TRANSITIONS,
    data: Prisma.P2pOrderUpdateManyMutationInput,
    to: P2pOrderStatus = P2P_EVENT_TRANSITIONS[event].to,
    after?: (tx: Tx, moved: P2pOrderRow) => Promise<void>,
  ): Promise<void> {
    const from = P2P_EVENT_TRANSITIONS[event].from as readonly string[];
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.p2pOrder.updateMany({
        where: { id: row.id, status: { in: [...from] } },
        data: { ...data, status: to },
      });
      if (moved.count !== 1) return;
      const now = await tx.p2pOrder.findUnique({ where: { id: row.id }, select: P2P_ORDER_SELECT });
      if (!now) return;
      const type = STATUS_EVENTS[to];
      if (type) await enqueueWebhooks(tx, orderEvents(type, now, this.deployments.chainIdOf(now)));
      await this.bumpMerchant(tx, row.merchantAccountId, { lastActiveAt: new Date() });
      if (after) await after(tx, now);
    });
  }

  private async opened(
    d: Deployment,
    event: Extract<P2pMarketEvent, { name: 'OrderOpened' }>,
    log: IndexedLog,
    times: Map<bigint, number>,
  ): Promise<void> {
    const row = await this.prisma.p2pOrder.findUnique({
      where: { ref: event.ref.toLowerCase() },
      select: P2P_ORDER_SELECT,
    });
    if (
      !row ||
      row.tier !== d.tier ||
      row.network !== d.network ||
      !sameAddress(row.contract, d.contract)
    ) {
      return;
    }
    const kind = row.kind as P2pOrderKind;
    const expected = openParamsOf(row);
    const matches =
      sameAddress(event.opener, row.openerAddress) &&
      sameAddress(event.seller, expected.seller) &&
      sameAddress(event.buyer, expected.buyer) &&
      sameAddress(event.token, expected.token) &&
      event.amount === expected.amount &&
      event.bond === expected.bond &&
      event.viaMatcher === (kind !== 'SELL');
    if (!matches) {
      this.logger.warn(
        `${d.network}/${d.tier}: order ${event.id} carries the ref of ${row.id} but not its terms (opener ${event.opener}); ignored`,
      );
      return;
    }
    const at = await this.blockTime(d, log.block, times);
    if (kind === 'SELL') {
      // The seller's wallet signed this; read back what the event leaves out.
      const onchain = await this.reader.getOrder(d, event.id);
      const termsMatch =
        onchain.paymentWindow === expected.paymentWindow &&
        onchain.settleWindow === expected.settleWindow &&
        onchain.integratorFeeBps === expected.integratorFeeBps &&
        sameAddress(onchain.integrator, expected.integrator) &&
        onchain.fromBalance === false &&
        onchain.feeBps === row.protocolFeeBps &&
        (expected.bond === 0n || onchain.acceptDeadline - at === expected.acceptWindow);
      if (!termsMatch) {
        this.logger.warn(
          `${d.network}/${d.tier}: sale ${row.id} opened as order ${event.id} with other windows, fees or integrator; ignored`,
        );
        return;
      }
    }
    const bonded = expected.bond > 0n;
    const deadlines = {
      acceptDeadline: bonded ? new Date((at + expected.acceptWindow) * 1000) : null,
      paymentDeadline: bonded ? null : new Date((at + expected.paymentWindow) * 1000),
    };
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.p2pOrder.updateMany({
        where: { id: row.id, status: { in: openableFrom(kind) }, onchainId: null },
        data: {
          onchainId: event.id.toString(),
          chainStatus: bonded ? 'Offered' : 'Active',
          status: bonded ? 'awaiting_acceptance' : 'awaiting_payment',
          openTxHash: log.txHash,
          failureReason: null,
          endedAt: null,
          ...deadlines,
        },
      });
      if (moved.count !== 1) {
        // An order we already failed that opened after all still locks tokens:
        // record where it is, without reviving it, so the expiry job cancels it.
        await tx.p2pOrder.updateMany({
          where: { id: row.id, status: 'failed', onchainId: null },
          data: {
            onchainId: event.id.toString(),
            chainStatus: bonded ? 'Offered' : 'Active',
            openTxHash: log.txHash,
            ...deadlines,
          },
        });
        return;
      }
      const now = await tx.p2pOrder.findUnique({ where: { id: row.id }, select: P2P_ORDER_SELECT });
      if (now) {
        await enqueueWebhooks(
          tx,
          orderEvents('P2P_ORDER_CREATED', now, this.deployments.chainIdOf(now)),
        );
      }
    });
  }

  private async operatorSet(
    d: Deployment,
    event: Extract<P2pMarketEvent, { name: 'OperatorSet' }>,
  ): Promise<void> {
    const account = await this.prisma.p2pAccount.findUnique({
      where: { tier_address: { tier: d.tier, address: event.account } },
      select: { id: true, operators: true },
    });
    if (!account) return;
    const all = { ...((account.operators ?? {}) as Record<string, Record<string, number>>) };
    all[d.network] = { ...(all[d.network] ?? {}), [event.operator]: event.permissions };
    await this.prisma.p2pAccount.update({ where: { id: account.id }, data: { operators: all } });
  }

  private async bumpMerchant(
    tx: Tx,
    accountId: string | null,
    data: Prisma.P2pAccountUpdateManyMutationInput,
  ): Promise<void> {
    if (!accountId) return;
    await tx.p2pAccount.updateMany({ where: { id: accountId }, data });
  }

  /** A completed order: one more for its merchant, and its median release time again. */
  private async completedStats(tx: Tx, row: P2pOrderRow, when: Date): Promise<void> {
    if (!row.merchantAccountId) return;
    let median: number | null | undefined;
    if (P2P_MERCHANT_SIDE[row.kind as P2pOrderKind] === 'seller') {
      const recent = await tx.p2pOrder.findMany({
        where: {
          merchantAccountId: row.merchantAccountId,
          status: 'completed',
          kind: { in: ['BUY', 'CHARGE'] },
          paidAt: { not: null },
          endedAt: { not: null },
        },
        orderBy: { endedAt: 'desc' },
        take: MEDIAN_WINDOW,
        select: { paidAt: true, endedAt: true },
      });
      median = medianSeconds(
        recent.map((o) =>
          Math.max(
            0,
            Math.round(((o.endedAt as Date).getTime() - (o.paidAt as Date).getTime()) / 1000),
          ),
        ),
      );
    }
    await this.bumpMerchant(tx, row.merchantAccountId, {
      completedOrders: { increment: 1 },
      lastActiveAt: when,
      ...(median !== undefined ? { medianReleaseSeconds: median } : {}),
    });
  }
}
