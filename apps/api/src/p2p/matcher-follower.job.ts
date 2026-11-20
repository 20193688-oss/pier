import { Inject, Injectable, Logger } from '@nestjs/common';
import { Transaction, rpc } from '@stellar/stellar-sdk';
import { ChainClient } from '@/chain/chain-client.service';
import { DeploymentsService } from '@/chain/deployments.service';
import type { Tier } from '@/chain/networks';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { JOB_LOCK_KEYS, ScheduledJob } from '@/jobs/scheduled-job';
import { P2P_MATCHER_FOLLOW_BATCH, P2P_MATCHER_REBROADCAST_MS } from '@/p2p/domain/constants';
import { MatcherService } from '@/p2p/matcher.service';
import { PrismaService } from '@/prisma/prisma.service';

/** Seconds past a transaction's upper time bound before it is called dropped. */
const DROP_GRACE_SECONDS = 15;

/**
 * Follows the matcher's transactions until each is applied, and keeps its
 * queue moving. A transaction the network has not answered is sent again
 * with its STORED bytes (never re-signed); one whose time bounds passed
 * without being applied never will be and is `dropped`. An `open` that failed
 * or was dropped fails its order, so the merchant's slot is free again; the
 * other kinds change nothing here (the indexer moves orders on what the chain
 * shows). Then the next queued call of each network is signed and sent.
 */
@Injectable()
export class MatcherFollowerJob extends ScheduledJob {
  protected readonly logger = new Logger(MatcherFollowerJob.name);
  protected readonly lockKey = JOB_LOCK_KEYS.matcherFollower;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly chain: ChainClient,
    private readonly matcher: MatcherService,
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
    return this.deployments.timeoutMs() * (P2P_MATCHER_FOLLOW_BATCH * 3 + 20);
  }

  protected async run(): Promise<void> {
    const rows = await this.prisma.p2pMatcherTx.findMany({
      where: { status: { in: ['signed', 'sent'] } },
      orderBy: { updatedAt: 'asc' },
      take: P2P_MATCHER_FOLLOW_BATCH,
    });
    for (const row of rows) {
      const d = this.deployments.find(row.tier as Tier, row.network);
      if (!d || !row.hash || !row.raw) continue;
      try {
        const got = await this.chain.getTransaction(d, row.hash);
        if (got.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
          const ok = got.status === rpc.Api.GetTransactionStatus.SUCCESS;
          const moved = await this.prisma.p2pMatcherTx.updateMany({
            where: { id: row.id, status: { in: ['signed', 'sent'] } },
            data: { status: ok ? 'mined' : 'reverted', ledger: got.ledger },
          });
          if (!ok && moved.count === 1) {
            this.logger.warn(`P2P matcher ${row.kind} ${row.hash} failed on ${row.network}`);
            await this.matcher.afterDrop(row.id, 'the opening transaction failed');
          }
          continue;
        }
        const maxTime = row.maxTime ? row.maxTime.getTime() : 0;
        if (maxTime > 0 && Date.now() > maxTime + DROP_GRACE_SECONDS * 1000) {
          const moved = await this.prisma.p2pMatcherTx.updateMany({
            where: { id: row.id, status: { in: ['signed', 'sent'] } },
            data: { status: 'dropped' },
          });
          this.logger.error(`P2P matcher ${row.kind} ${row.hash} dropped: its time bounds passed`);
          if (moved.count === 1) {
            await this.matcher.afterDrop(row.id, 'the opening transaction was never applied');
          }
          continue;
        }
        const last = (row.sentAt ?? row.updatedAt).getTime();
        if (row.status === 'signed' || Date.now() - last >= P2P_MATCHER_REBROADCAST_MS) {
          // The same stored bytes, never a new signature.
          await this.chain.send(d, new Transaction(row.raw, d.passphrase));
          await this.prisma.p2pMatcherTx.update({
            where: { id: row.id },
            data: { status: 'sent', sentAt: new Date(), lastError: null },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`P2P matcher ${row.kind} ${row.hash}: ${message}`);
        await this.prisma.p2pMatcherTx.update({
          where: { id: row.id },
          data: { lastError: message.slice(0, 500) },
        });
      }
    }
    await this.advanceQueues();
  }

  /** Signs and sends the next queued call of every network with nothing in flight. */
  async advanceQueues(): Promise<void> {
    const queued = await this.prisma.p2pMatcherTx.groupBy({
      by: ['tier', 'network'],
      where: { status: 'queued' },
    });
    for (const q of queued) {
      const d = this.deployments.find(q.tier as Tier, q.network);
      if (!d) continue;
      try {
        const signed = await this.matcher.signNext(d);
        if (signed) await this.matcher.broadcast(d, signed);
      } catch (err) {
        this.logger.warn(
          `P2P matcher queue on ${q.network}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
