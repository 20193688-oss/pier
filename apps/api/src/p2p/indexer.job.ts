import { Inject, Injectable, Logger } from '@nestjs/common';
import type { rpc } from '@stellar/stellar-sdk';
import { ChainClient } from '@/chain/chain-client.service';
import { DeploymentsService, type Deployment } from '@/chain/deployments.service';
import { decodeMarketEvent, type P2pChainOrder, type P2pMarketEvent } from '@/chain/market-codec';
import { MarketReader } from '@/chain/market-reader.service';
import { sameAddress } from '@/common/stellar';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import type { Prisma } from '@/generated/prisma/client';
import { JOB_LOCK_KEYS, ScheduledJob } from '@/jobs/scheduled-job';
import { ChargesService } from '@/p2p/charges.service';
import { P2P_INDEXER_MAX_PAGES, P2P_INDEXER_PAGE_LIMIT } from '@/p2p/domain/constants';
import { openParamsOf, orderRef } from '@/p2p/domain/order-ref';
import {
  cancellationStatus,
  isSelfOpened,
  medianSeconds,
  merchantAtFault,
  merchantLostDispute,
  openableFrom,
  P2P_EVENT_TRANSITIONS,
  P2P_LIVE_STATUSES,
  P2P_MERCHANT_SIDE,
  type P2pOrderKind,
  type P2pOrderStatus,
} from '@/p2p/domain/order-status';
import { orderEvents, STATUS_EVENTS } from '@/p2p/p2p-events';
import { PayoutsService } from '@/p2p/payouts.service';
import { P2P_ORDER_SELECT, type P2pOrderRow } from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';
import { enqueueWebhooks, type Tx } from '@/webhooks/webhook-outbox';

/** Recent completed orders a merchant's median release time is taken over. */
const MEDIAN_WINDOW = 50;
/** Live orders a recovery pass reads back from the contract per tick. */
const RECONCILE_BATCH = 25;

/** One decoded event, where and when it happened. */
export interface IndexedEvent {
  event: P2pMarketEvent;
  /** Unix seconds of the ledger that closed it. */
  at: number;
  ledger: number;
  txHash: string;
}

type Opened = Extract<P2pMarketEvent, { name: 'order_opened' }>;

/**
 * The field-by-field check of an `order_opened` against the order we expect:
 * the opener the order names (the matcher, or the person selling), every
 * `OpenParams` field, where the tokens came from (`from_balance`: the
 * matcher opens on a balance, a seller deposits), the protocol fee the quote
 * priced, and the accept deadline the bond implies. Answers what differs.
 */
export function openedMismatch(row: P2pOrderRow, event: Opened, at: number): string[] {
  const expected = openParamsOf(row);
  const selfOpened = isSelfOpened(row.kind);
  const problems: string[] = [];
  const check = (ok: boolean, field: string) => {
    if (!ok) problems.push(field);
  };
  check(sameAddress(event.opener, row.openerAddress), 'opener');
  check(event.refId === orderRef(row.id), 'ref_id');
  check(sameAddress(event.seller, expected.seller), 'seller');
  check(sameAddress(event.buyer, expected.buyer), 'buyer');
  check(sameAddress(event.token, expected.token), 'token');
  check(event.amount === expected.amount, 'amount');
  check(event.bond === expected.bond, 'bond');
  check(event.viaMatcher === !selfOpened, 'via_matcher');
  check(event.fromBalance === !selfOpened, 'from_balance');
  check(event.paymentWindow === expected.paymentWindow, 'payment_window');
  check(event.settleWindow === expected.settleWindow, 'settle_window');
  check(event.integratorFeeBps === expected.integratorFeeBps, 'integrator_fee_bps');
  check((event.integrator ?? null) === expected.integrator, 'integrator');
  check(event.feeBps === row.protocolFeeBps, 'fee_bps');
  if (expected.bond > 0n)
    check(event.acceptDeadline - at === expected.acceptWindow, 'accept_deadline');
  return problems;
}

/**
 * Follows every P2PMarket deployment and moves our orders on what the chain
 * shows. Per deployment and tick: RPC `getEvents` for the contract from the
 * persisted cursor (at most {@link P2P_INDEXER_MAX_PAGES} pages). Stellar has
 * finality, so there is no confirmation depth and no reorg window. Every
 * write is a compare-and-swap from the statuses an event may move
 * (`P2P_EVENT_TRANSITIONS`), committed in ONE transaction with its webhook
 * events and the charge / payout bookkeeping, so an event read twice changes
 * nothing and a stale one never moves an order back.
 *
 * An `order_opened` is ours only when its `ref_id` is one of our orders, from
 * the opener that order expects, and every field equals the order's
 * ({@link openedMismatch}). A copy of our ref under another opener is someone
 * else's order and is ignored.
 *
 * Recovery: RPC keeps events for a limited window (about 7 days on SDF's
 * RPC). When the cursor (or the configured start ledger) fell out of it, the
 * indexer starts again from the oldest retained ledger and reads every live
 * order back from the contract (`get_order`, `order_id_of`), applying the
 * moves it missed (their settlement amounts are left empty).
 */
@Injectable()
export class IndexerJob extends ScheduledJob {
  protected readonly logger = new Logger(IndexerJob.name);
  protected readonly lockKey = JOB_LOCK_KEYS.indexer;
  /** Deployments whose cursor fell out of retention: their live orders are read back. */
  private readonly reconciling = new Set<string>();

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
    return this.deployments.timeoutMs() * (P2P_INDEXER_MAX_PAGES * 3 + RECONCILE_BATCH + 20);
  }

  protected async run(): Promise<void> {
    for (const tier of ['live', 'test'] as const) {
      for (const d of await this.reader.liveDeployments(tier)) {
        try {
          await this.indexDeployment(d);
          if (this.reconciling.has(d.contract)) await this.reconcile(d);
        } catch (err) {
          this.logger.warn(`${d.network}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  /** One deployment's tick. */
  async indexDeployment(d: Deployment): Promise<void> {
    const key = { tier: d.tier, network: d.network, contract: d.contract };
    const saved = await this.prisma.p2pChainCursor.findUnique({
      where: { tier_network_contract: key },
      select: { cursor: true, lastLedger: true },
    });
    const filters: rpc.Api.EventFilter[] = [{ type: 'contract', contractIds: [d.contract] }];
    let cursor = saved?.cursor ?? null;
    for (let page = 0; page < P2P_INDEXER_MAX_PAGES; page++) {
      let res: rpc.Api.GetEventsResponse;
      try {
        res = cursor
          ? await this.chain.getEvents(d, { filters, cursor, limit: P2P_INDEXER_PAGE_LIMIT })
          : await this.chain.getEvents(d, {
              filters,
              startLedger: await this.startLedger(d, saved?.lastLedger ?? 0),
              limit: P2P_INDEXER_PAGE_LIMIT,
            });
      } catch (err) {
        if (cursor && /cursor|range|ledger/i.test(String(err))) {
          this.logger.error(
            `${d.network}: the event cursor is no longer served (${String(err)}): starting from the oldest retained ledger and reading live orders back from the contract`,
          );
          cursor = null;
          this.reconciling.add(d.contract);
          await this.prisma.p2pChainCursor.updateMany({ where: key, data: { cursor: null } });
          continue;
        }
        throw err;
      }
      for (const raw of res.events) {
        const indexed = this.decode(d, raw);
        if (indexed) await this.apply(d, indexed);
      }
      const lastLedger = res.events.at(-1)?.ledger ?? saved?.lastLedger ?? 0;
      await this.prisma.p2pChainCursor.upsert({
        where: { tier_network_contract: key },
        create: { ...key, cursor: res.cursor, lastLedger },
        update: { cursor: res.cursor, lastLedger },
      });
      cursor = res.cursor;
      if (res.events.length < P2P_INDEXER_PAGE_LIMIT) return;
    }
  }

  /** Where to start without a cursor: the configured ledger, never older than what RPC keeps. */
  private async startLedger(d: Deployment, lastLedger: number): Promise<number> {
    const health = await this.chain.health(d);
    const wanted = lastLedger > 0 ? lastLedger : (d.startLedger ?? health.oldestLedger);
    if (wanted < health.oldestLedger) {
      this.logger.error(
        `${d.network}: ledger ${wanted} is older than what the RPC keeps (${health.oldestLedger}): reading live orders back from the contract`,
      );
      this.reconciling.add(d.contract);
      return health.oldestLedger;
    }
    return wanted;
  }

  private decode(d: Deployment, raw: rpc.Api.EventResponse): IndexedEvent | null {
    if (raw.inSuccessfulContractCall === false) return null;
    if (raw.contractId && raw.contractId.contractId() !== d.contract) return null;
    try {
      const event = decodeMarketEvent(raw.topic, raw.value);
      return event
        ? {
            event,
            at: Math.floor(Date.parse(raw.ledgerClosedAt) / 1000),
            ledger: raw.ledger,
            txHash: raw.txHash,
          }
        : null;
    } catch (err) {
      this.logger.warn(`${d.network}: event ${raw.id} not decoded: ${String(err)}`);
      return null;
    }
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

  /** Applies one event (exported for tests and the recovery pass). */
  async apply(d: Deployment, log: IndexedEvent): Promise<void> {
    const { event } = log;
    switch (event.name) {
      case 'operator_set':
        return this.operatorSet(d, event);
      case 'matcher_set':
        return;
      case 'order_opened':
        return this.opened(d, event, log);
      default:
        break;
    }
    const row = await this.byChainId(d, event.id);
    if (!row) return;
    const when = new Date(log.at * 1000);
    switch (event.name) {
      case 'order_accepted':
        await this.move(row, 'order_accepted', {
          chainStatus: 'Active',
          paymentDeadline: new Date(event.paymentDeadline * 1000),
          acceptTxHash: log.txHash,
        });
        return;
      case 'order_paid':
        await this.move(row, 'order_paid', {
          chainStatus: 'Paid',
          paidAt: when,
          paidTxHash: log.txHash,
        });
        return;
      case 'order_disputed':
        await this.move(row, 'order_disputed', {
          chainStatus: 'Disputed',
          disputeTxHash: log.txHash,
        });
        return;
      case 'order_released':
        await this.move(
          row,
          'order_released',
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
      case 'order_cancelled': {
        const previous = row.status as P2pOrderStatus;
        const outcome = cancellationStatus({
          previous,
          at: log.at,
          acceptDeadline: row.acceptDeadline ? row.acceptDeadline.getTime() / 1000 : null,
          paymentDeadline: row.paymentDeadline ? row.paymentDeadline.getTime() / 1000 : null,
        });
        await this.move(
          row,
          'order_cancelled',
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
      case 'order_resolved':
        await this.move(
          row,
          'order_resolved',
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
   * already moved (an event read again) or is elsewhere.
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
      if (type) await enqueueWebhooks(tx, orderEvents(type, now));
      await this.bumpMerchant(tx, row.merchantAccountId, { lastActiveAt: new Date() });
      if (after) await after(tx, now);
    });
  }

  private async opened(d: Deployment, event: Opened, log: IndexedEvent): Promise<void> {
    const row = await this.prisma.p2pOrder.findUnique({
      where: { ref: event.refId },
      select: P2P_ORDER_SELECT,
    });
    if (!row || row.tier !== d.tier || row.network !== d.network || row.contract !== d.contract) {
      return;
    }
    const problems = openedMismatch(row, event, log.at);
    if (problems.length > 0) {
      this.logger.warn(
        `${d.network}: order ${event.id} carries the ref of ${row.id} but not its terms (${problems.join(', ')}; opener ${event.opener}); ignored`,
      );
      return;
    }
    const kind = row.kind as P2pOrderKind;
    const bonded = BigInt(row.bond) > 0n;
    const deadlines = {
      acceptDeadline: bonded ? new Date(event.acceptDeadline * 1000) : null,
      paymentDeadline: bonded ? null : new Date(event.paymentDeadline * 1000),
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
      if (now) await enqueueWebhooks(tx, orderEvents('P2P_ORDER_CREATED', now));
    });
  }

  private async operatorSet(
    d: Deployment,
    event: Extract<P2pMarketEvent, { name: 'operator_set' }>,
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

  /**
   * The recovery pass: live orders read back from the contract. An order not
   * open yet is looked up by its ref under its expected opener; an open one
   * gets the moves its chain status implies. Done when no live order is left
   * to read.
   */
  async reconcile(d: Deployment): Promise<void> {
    const rows = await this.prisma.p2pOrder.findMany({
      where: {
        tier: d.tier,
        network: d.network,
        contract: d.contract,
        status: { in: [...P2P_LIVE_STATUSES] },
      },
      orderBy: { updatedAt: 'asc' },
      take: RECONCILE_BATCH,
      select: P2P_ORDER_SELECT,
    });
    const now = Math.floor(Date.now() / 1000);
    for (const row of rows) {
      let id = row.onchainId ? BigInt(row.onchainId) : 0n;
      if (id === 0n) id = await this.reader.orderIdOf(d, row.openerAddress, orderRef(row.id));
      if (id === 0n) continue;
      const onchain = await this.reader.getOrder(d, id);
      if (!onchain) continue;
      const base = { at: now, ledger: 0, txHash: '' };
      if (!row.onchainId) {
        const event: Opened = { name: 'order_opened', id, ...withoutPaidAt(onchain) };
        // When it opened, as its own deadlines tell (the event's time is lost).
        const openedAt =
          BigInt(row.bond) > 0n
            ? onchain.acceptDeadline - row.acceptWindow
            : onchain.paymentDeadline - row.paymentWindow;
        await this.opened(d, event, { ...base, at: openedAt, event });
      }
      for (const event of missedEvents(id, onchain, row.netAmount)) {
        await this.apply(d, { ...base, event });
      }
    }
    if (rows.length < RECONCILE_BATCH) this.reconciling.delete(d.contract);
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

function withoutPaidAt(o: P2pChainOrder): Omit<P2pChainOrder, 'paidAt'> {
  const { paidAt: _paidAt, ...rest } = o;
  return rest;
}

/**
 * The events an order went through on-chain that its stored status has not
 * seen, rebuilt from its chain status (recovery only; amounts the contract
 * does not store are left out). Each is applied as a compare-and-swap, so
 * the ones already seen change nothing.
 */
export function missedEvents(id: bigint, o: P2pChainOrder, netAmount: string): P2pMarketEvent[] {
  const accepted: P2pMarketEvent = {
    name: 'order_accepted',
    id,
    paymentDeadline: o.paymentDeadline,
  };
  const paid: P2pMarketEvent = { name: 'order_paid', id, by: null };
  const disputed: P2pMarketEvent = { name: 'order_disputed', id, by: null };
  switch (o.status) {
    case 'Active':
      return [accepted];
    case 'Paid':
      return [accepted, paid];
    case 'Disputed':
      return [accepted, paid, disputed];
    case 'Released':
      return [
        accepted,
        {
          name: 'order_released',
          id,
          by: null,
          toBuyer: BigInt(netAmount),
          protocolFee: 0n,
          integratorFee: 0n,
        },
      ];
    case 'Cancelled':
      return [{ name: 'order_cancelled', id, by: null }];
    case 'Resolved':
      return [
        accepted,
        paid,
        disputed,
        {
          name: 'order_resolved',
          id,
          toBuyer: 0n,
          toSeller: 0n,
          bondToSeller: 0n,
          protocolFee: 0n,
          integratorFee: 0n,
        },
      ];
    default:
      return [];
  }
}
