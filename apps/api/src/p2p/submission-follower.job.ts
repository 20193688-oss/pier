import { Inject, Injectable, Logger } from '@nestjs/common';
import { DeploymentsService } from '@/chain/deployments.service';
import type { Tier } from '@/chain/networks';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { JOB_LOCK_KEYS, ScheduledJob } from '@/jobs/scheduled-job';
import { P2P_MATCHER_REBROADCAST_MS, P2P_SUBMISSION_FOLLOW_BATCH } from '@/p2p/domain/constants';
import { SUBMISSION_SELECT, SubmissionsService } from '@/p2p/submissions.service';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Follows the transactions wallets submitted through the API until each is
 * applied or can no longer be: a pending one is read from the network, and
 * sent again with its STORED bytes while its time bounds allow; past them it
 * is `FAILED`. A transfer built and never submitted is forgotten, and a
 * charge payment never submitted expires.
 */
@Injectable()
export class SubmissionFollowerJob extends ScheduledJob {
  protected readonly logger = new Logger(SubmissionFollowerJob.name);
  protected readonly lockKey = JOB_LOCK_KEYS.submissionFollower;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly submissions: SubmissionsService,
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
    return this.deployments.timeoutMs() * (P2P_SUBMISSION_FOLLOW_BATCH * 2 + 10);
  }

  protected async run(): Promise<void> {
    const rows = await this.prisma.p2pSubmission.findMany({
      where: { status: 'PENDING' },
      orderBy: { updatedAt: 'asc' },
      take: P2P_SUBMISSION_FOLLOW_BATCH,
      select: SUBMISSION_SELECT,
    });
    for (const row of rows) {
      const d = this.deployments.find(row.tier as Tier, row.network);
      if (!d) continue;
      try {
        const now = await this.submissions.refresh(d, row);
        const last = (now.sentAt ?? new Date(0)).getTime();
        if (
          now.status === 'PENDING' &&
          Date.now() < now.maxTime.getTime() &&
          Date.now() - last >= P2P_MATCHER_REBROADCAST_MS
        ) {
          await this.submissions.broadcast(d, now);
        }
      } catch (err) {
        this.logger.warn(
          `Submission ${row.hash}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const now = new Date();
    // A transfer built and never submitted did not happen: it is forgotten.
    await this.prisma.appTransfer.deleteMany({
      where: { status: 'PENDING', origin: 'app', expiresAt: { lt: now } },
    });
    await this.prisma.p2pChargePayment.updateMany({
      where: { status: 'PENDING', expiresAt: { lt: now } },
      data: { status: 'EXPIRED', completedAt: now },
    });
  }
}
