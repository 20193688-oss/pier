import type { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { PrismaService } from '@/prisma/prisma.service';

/** First key of every job's two-key advisory lock: `(JOB_LOCK_CLASS, job key)`. */
export const JOB_LOCK_CLASS = 72_001;

/** Each job's second lock key: one runner per job across every replica. */
export const JOB_LOCK_KEYS = {
  indexer: 1,
  expiry: 2,
  matcherFollower: 3,
  webhookSender: 4,
} as const;

/**
 * A job that runs every `intervalMs()` on ONE replica at a time: each tick
 * takes a transaction-scoped Postgres advisory lock (`pg_try_advisory_xact_lock`)
 * and skips when another replica holds it. Ticks never overlap within a
 * process, and a failing tick is logged and retried on the next one. The lock
 * is released with the transaction, so a crashed replica never keeps it.
 */
export abstract class ScheduledJob implements OnApplicationBootstrap, OnApplicationShutdown {
  protected abstract readonly logger: Logger;
  protected abstract readonly lockKey: number;
  protected abstract enabled(): boolean;
  protected abstract intervalMs(): number;
  protected abstract run(): Promise<void>;

  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running?: Promise<boolean>;

  protected constructor(protected readonly prisma: PrismaService) {}

  /** How long one tick may hold its lock (its transaction's timeout). */
  protected lockTimeoutMs(): number {
    return 120_000;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled()) return;
    this.logger.log(`Scheduled every ${this.intervalMs()} ms`);
    this.schedule(Math.min(1_000, this.intervalMs()));
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((err: unknown) => {
          this.logger.error(`Tick failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => this.schedule(this.intervalMs()));
    }, delayMs);
    this.timer.unref?.();
  }

  /** One tick under the job's lock; answers whether it ran (false: another replica holds it). */
  tick(): Promise<boolean> {
    if (this.running) return this.running;
    const run = this.prisma
      .$transaction(
        async (tx) => {
          const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${JOB_LOCK_CLASS}::int, ${this.lockKey}::int) AS locked`;
          if (!row?.locked) return false;
          await this.run();
          return true;
        },
        { timeout: this.lockTimeoutMs(), maxWait: 10_000 },
      )
      .finally(() => {
        this.running = undefined;
      });
    this.running = run;
    return run;
  }
}
