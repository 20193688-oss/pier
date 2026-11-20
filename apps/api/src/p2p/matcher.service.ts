import { Injectable, Logger } from '@nestjs/common';
import { Transaction, xdr } from '@stellar/stellar-sdk';
import { ChainCallReverted, ChainClient } from '@/chain/chain-client.service';
import { DeploymentsService, type Deployment } from '@/chain/deployments.service';
import { TxBuilder } from '@/chain/tx-builder.service';
import { ApiError } from '@/common/api-error';
import { P2P_MATCHER_LOCK_CLASS, P2P_MATCHER_TX_TTL_SECONDS } from '@/p2p/domain/constants';
import { PrismaService } from '@/prisma/prisma.service';
import type { Tx } from '@/webhooks/webhook-outbox';

/** What the matcher sends: an order's opening, or an act for a buyer it opened an order for. */
export type P2pMatcherKind = 'open' | 'markPaid' | 'cancel' | 'dispute';

export interface P2pMatcherSend {
  kind: P2pMatcherKind;
  orderId: string;
  operation: xdr.Operation;
}

/** Called when a queued `open` turns out refused or never applies: its order fails. */
export type OpenFailed = (orderId: string, reason: string) => Promise<void>;

const IN_FLIGHT = ['signed', 'sent'];

/**
 * The only place the matcher key signs. Stellar takes one transaction per
 * source account per ledger, so the matcher's calls form a queue per network:
 *
 *   1. every call is SIMULATED first: a call the contract would refuse is a
 *      `ChainCallReverted` before anything is signed or queued;
 *   2. it is written to `p2p_matcher_tx` as `queued`, under the network's
 *      advisory lock;
 *   3. when no other matcher transaction is in flight there, the oldest queued
 *      call is prepared again, signed with the next sequence number, and its
 *      bytes WRITTEN (`signed`) before they are broadcast (`sent`).
 *
 * Only those stored bytes are ever sent again (`MatcherFollowerJob`); a
 * transaction whose time bounds passed without being applied is `dropped`
 * and the queue moves on. The matcher pays its own fees and holds only the
 * authority sellers granted it; it never holds a seller's or a buyer's tokens.
 */
@Injectable()
export class MatcherService {
  private readonly logger = new Logger(MatcherService.name);
  /** Set by `OrderOpener` (which depends on this service). */
  onOpenFailed: OpenFailed = async () => undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly chain: ChainClient,
    private readonly builder: TxBuilder,
  ) {}

  private async matcherAccount(d: Deployment) {
    const key = this.deployments.matcherKey();
    const account = await this.chain.loadAccount(d, key.publicKey());
    if (!account) {
      throw ApiError.unavailable(
        'The market cannot act on this network right now.',
        `The matcher account ${key.publicKey()} does not exist on ${d.network}.`,
      );
    }
    return { key, account };
  }

  /**
   * Queues a call (after simulating it) and signs and broadcasts it at once
   * when nothing else is in flight. Answers the transaction hash, or null
   * while it waits in the queue.
   */
  async send(d: Deployment, input: P2pMatcherSend): Promise<string | null> {
    const { key, account } = await this.matcherAccount(d);
    // A refusal surfaces here, before anything is written or signed.
    await this.builder.prepare(d, account, input.operation, P2P_MATCHER_TX_TTL_SECONDS);
    await this.prisma.p2pMatcherTx.create({
      data: {
        tier: d.tier,
        network: d.network,
        fromAddress: key.publicKey(),
        kind: input.kind,
        orderId: input.orderId,
        operation: input.operation.toXdr('base64'),
      },
    });
    const signed = await this.signNext(d);
    if (signed) await this.broadcast(d, signed);
    const row = await this.prisma.p2pMatcherTx.findFirst({
      where: { orderId: input.orderId, kind: input.kind },
      orderBy: { createdAt: 'desc' },
      select: { hash: true },
    });
    return row?.hash ?? null;
  }

  /**
   * Signs the oldest queued call of a network when none is in flight, and
   * writes its bytes; answers the row to broadcast, or null. Calls the
   * contract now refuses are marked `reverted` on the way (their order fails
   * when they were openings).
   */
  async signNext(d: Deployment): Promise<{ id: string; raw: string; hash: string } | null> {
    const key = this.deployments.matcherKey();
    const from = key.publicKey();
    const refused: { orderId: string | null; kind: string; reason: string }[] = [];
    const signed = await this.prisma.$transaction(
      async (tx) => {
        await this.lock(tx, d);
        const busy = await tx.p2pMatcherTx.count({
          where: { network: d.network, tier: d.tier, fromAddress: from, status: { in: IN_FLIGHT } },
        });
        if (busy > 0) return null;
        for (;;) {
          const next = await tx.p2pMatcherTx.findFirst({
            where: { network: d.network, tier: d.tier, fromAddress: from, status: 'queued' },
            orderBy: { createdAt: 'asc' },
          });
          if (!next) return null;
          const account = await this.chain.loadAccount(d, from);
          if (!account) throw new Error(`matcher account missing on ${d.network}`);
          let prepared: Transaction;
          try {
            prepared = await this.builder.prepare(
              d,
              account,
              xdr.Operation.fromXdr(next.operation, 'base64'),
              P2P_MATCHER_TX_TTL_SECONDS,
            );
          } catch (err) {
            if (!(err instanceof ChainCallReverted)) throw err;
            const reason = err.contractError ?? 'refused';
            await tx.p2pMatcherTx.update({
              where: { id: next.id },
              data: { status: 'reverted', lastError: err.detail.slice(0, 500) },
            });
            refused.push({ orderId: next.orderId, kind: next.kind, reason });
            continue;
          }
          prepared.sign(key);
          const hash = Buffer.from(prepared.hash()).toString('hex');
          const raw = prepared.toXDR();
          await tx.p2pMatcherTx.update({
            where: { id: next.id },
            data: {
              status: 'signed',
              sequence: BigInt(prepared.sequence),
              hash,
              raw,
              maxTime: new Date(Number(prepared.timeBounds?.maxTime ?? 0) * 1000),
            },
          });
          if (next.kind === 'open' && next.orderId) {
            await tx.p2pOrder.updateMany({
              where: { id: next.orderId, openTxHash: null },
              data: { openTxHash: hash },
            });
          }
          return { id: next.id, raw, hash };
        }
      },
      { timeout: this.deployments.timeoutMs() * 6, maxWait: 10_000 },
    );
    for (const r of refused) {
      this.logger.warn(`P2P matcher ${r.kind} for order ${r.orderId} refused (${r.reason})`);
      if (r.kind === 'open' && r.orderId) {
        await this.onOpenFailed(r.orderId, `the merchant could no longer fill it (${r.reason})`);
      }
    }
    return signed;
  }

  private async lock(tx: Tx, d: Deployment): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${P2P_MATCHER_LOCK_CLASS}::int, hashtext(${`${d.tier}:${d.network}`}))`;
  }

  /** Sends a signed row's stored bytes; a refusal of those exact bytes drops it. */
  async broadcast(d: Deployment, row: { id: string; raw: string; hash: string }): Promise<void> {
    try {
      const tx = new Transaction(row.raw, d.passphrase);
      const sent = await this.chain.send(d, tx);
      if (sent.status === 'ERROR') {
        const detail = JSON.stringify(sent.errorResult?.toJSON?.() ?? sent.status).slice(0, 500);
        const dropped = await this.prisma.p2pMatcherTx.updateMany({
          where: { id: row.id, status: { in: IN_FLIGHT } },
          data: { status: 'dropped', lastError: detail },
        });
        this.logger.error(`P2P matcher ${row.hash} refused by the network: ${detail}`);
        if (dropped.count === 1)
          await this.afterDrop(row.id, 'the opening transaction was refused');
        return;
      }
      await this.prisma.p2pMatcherTx.updateMany({
        where: { id: row.id, status: 'signed' },
        data: { status: 'sent', sentAt: new Date(), lastError: null },
      });
      if (sent.status === 'TRY_AGAIN_LATER') {
        await this.prisma.p2pMatcherTx.updateMany({
          where: { id: row.id },
          data: { lastError: 'TRY_AGAIN_LATER' },
        });
      }
    } catch (err) {
      // Recorded and signed: the follower sends these same bytes again.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`P2P matcher ${row.hash} not broadcast yet: ${message}`);
      await this.prisma.p2pMatcherTx.updateMany({
        where: { id: row.id },
        data: { lastError: message.slice(0, 500) },
      });
    }
  }

  /** A transaction that never applies: an opening fails its order. */
  async afterDrop(id: string, reason: string): Promise<void> {
    const row = await this.prisma.p2pMatcherTx.findUnique({
      where: { id },
      select: { kind: true, orderId: true },
    });
    if (row?.kind === 'open' && row.orderId) await this.onOpenFailed(row.orderId, reason);
  }
}
