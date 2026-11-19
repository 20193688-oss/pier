import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Hex } from 'viem';
import { ChainClient } from '@/chain/chain-client.service';
import { DeploymentsService } from '@/chain/deployments.service';
import type { Tier } from '@/chain/networks';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { JOB_LOCK_KEYS, ScheduledJob } from '@/jobs/scheduled-job';
import { P2P_MATCHER_FOLLOW_BATCH, P2P_MATCHER_REBROADCAST_MS } from '@/p2p/domain/constants';
import { OrderOpener } from '@/p2p/order-opener.service';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Follows the matcher's transactions until each is mined. A transaction with
 * no receipt is sent again with its STORED bytes (never re-signed); one whose
 * nonce the chain has passed without it was replaced or dropped and is
 * `dropped`. An `open` that reverted or was dropped fails its order, so the
 * merchant's slot is free again; the other kinds change nothing here (the
 * indexer moves orders on what was mined).
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
    private readonly opener: OrderOpener,
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
    return this.deployments.timeoutMs() * (P2P_MATCHER_FOLLOW_BATCH * 3 + 10);
  }

  protected async run(): Promise<void> {
    const rows = await this.prisma.p2pMatcherTx.findMany({
      where: { status: { in: ['signed', 'sent'] } },
      orderBy: { updatedAt: 'asc' },
      take: P2P_MATCHER_FOLLOW_BATCH,
    });
    for (const row of rows) {
      const d = this.deployments.find(row.tier as Tier, row.network);
      if (!d) continue;
      try {
        const receipt = await this.chain.receipt(d, row.hash as Hex);
        if (receipt) {
          await this.prisma.p2pMatcherTx.updateMany({
            where: { id: row.id, status: { in: ['signed', 'sent'] } },
            data: {
              status: receipt.succeeded ? 'mined' : 'reverted',
              minedBlock: receipt.blockNumber,
            },
          });
          if (!receipt.succeeded) {
            this.logger.warn(
              `P2P matcher ${row.kind} ${row.hash} reverted on ${row.network}/${row.tier}`,
            );
            if (row.kind === 'open' && row.orderId) {
              await this.opener.fail(row.orderId, 'the opening transaction reverted');
            }
          }
          continue;
        }
        const mined = await this.chain.minedNonce(d, row.fromAddress);
        if (mined > row.nonce) {
          // That nonce is spent by another transaction: this one never will be.
          await this.prisma.p2pMatcherTx.updateMany({
            where: { id: row.id, status: { in: ['signed', 'sent'] } },
            data: { status: 'dropped' },
          });
          this.logger.error(
            `P2P matcher ${row.kind} ${row.hash} dropped: nonce ${row.nonce} was used by another transaction`,
          );
          if (row.kind === 'open' && row.orderId) {
            await this.opener.fail(row.orderId, 'the opening transaction was dropped');
          }
          continue;
        }
        if (Date.now() - row.updatedAt.getTime() >= P2P_MATCHER_REBROADCAST_MS) {
          await this.chain.sendRawTransaction(d, row.raw as Hex);
          await this.prisma.p2pMatcherTx.update({
            where: { id: row.id },
            data: {
              status: 'sent',
              sentAt: row.sentAt ?? new Date(),
              lastError: null,
            },
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
  }
}
