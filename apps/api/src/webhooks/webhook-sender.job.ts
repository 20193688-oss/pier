import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataCipher } from '@/common/data-cipher';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { JOB_LOCK_KEYS, ScheduledJob } from '@/jobs/scheduled-job';
import { PrismaService } from '@/prisma/prisma.service';
import { destinationProblem, safeLookup, type DestinationPolicy } from '@/webhooks/ssrf';
import { SIGNATURE_HEADER, signatureHeader } from '@/webhooks/webhook-signature';

/** Deliveries one tick sends. */
const BATCH = 50;
/** Deliveries in flight at once. */
const CONCURRENCY = 10;
/** Seconds before each retry: 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h, 24 h. */
export const RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 3600, 10_800, 21_600, 43_200, 86_400];
/** Attempts before a delivery is `failed`. */
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
/** Bytes of a receiver's answer read (the rest is dropped). */
const MAX_RESPONSE_BYTES = 16 * 1024;

export interface PostResult {
  status: number | null;
  error: string | null;
}

/**
 * POSTs one body to a destination with the SSRF guard at connect time, no
 * redirects followed, and a hard timeout. Never throws.
 */
export function postWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  policy: DestinationPolicy,
): Promise<PostResult> {
  const problem = destinationProblem(url, policy);
  if (problem) return Promise.resolve({ status: null, error: problem });
  return new Promise((resolve) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      target,
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body).toString(),
          'user-agent': 'midpoint-webhooks/1',
        },
        lookup: safeLookup(policy) as never,
        timeout: timeoutMs,
      },
      (res) => {
        let read = 0;
        res.on('data', (chunk: Buffer) => {
          read += chunk.length;
          if (read > MAX_RESPONSE_BYTES) res.destroy();
        });
        res.on('end', () => resolve({ status: res.statusCode ?? null, error: null }));
        res.on('close', () => resolve({ status: res.statusCode ?? null, error: null }));
        res.on('error', () => resolve({ status: res.statusCode ?? null, error: null }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', (err) => resolve({ status: null, error: err.message.slice(0, 300) }));
    req.end(body);
  });
}

/**
 * Sends the outbox: every pending delivery whose time came, signed with its
 * endpoint's secret. A 2xx is delivered; anything else retries with
 * exponential backoff, and after {@link MAX_ATTEMPTS} it is `failed`.
 */
@Injectable()
export class WebhookSenderJob extends ScheduledJob {
  protected readonly logger = new Logger(WebhookSenderJob.name);
  protected readonly lockKey = JOB_LOCK_KEYS.webhookSender;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    prisma: PrismaService,
    private readonly cipher: DataCipher,
  ) {
    super(prisma);
  }

  protected enabled(): boolean {
    return this.config.jobs.enabled;
  }

  protected intervalMs(): number {
    return this.config.jobs.webhookIntervalMs;
  }

  protected override lockTimeoutMs(): number {
    return (this.config.webhooks.timeoutMs + 5_000) * Math.ceil(BATCH / CONCURRENCY) + 30_000;
  }

  protected async run(): Promise<void> {
    const due = await this.prisma.webhookDelivery.findMany({
      where: { status: 'pending', nextAttemptAt: { lte: new Date() } },
      orderBy: { nextAttemptAt: 'asc' },
      take: BATCH,
      include: {
        event: { select: { id: true, type: true, payload: true } },
        endpoint: { select: { id: true, url: true, secret: true, active: true } },
      },
    });
    for (let i = 0; i < due.length; i += CONCURRENCY) {
      await Promise.all(due.slice(i, i + CONCURRENCY).map((d) => this.deliver(d)));
    }
  }

  private async deliver(d: {
    id: string;
    attempts: number;
    event: { id: string; type: string; payload: unknown };
    endpoint: { id: string; url: string; secret: string; active: boolean };
  }): Promise<void> {
    if (!d.endpoint.active) {
      await this.prisma.webhookDelivery.updateMany({
        where: { id: d.id, status: 'pending' },
        data: { status: 'failed', lastError: 'the endpoint is paused' },
      });
      return;
    }
    const body = JSON.stringify(d.event.payload);
    let secret: string;
    try {
      secret = this.cipher.open<string>(
        'webhook-endpoint.secret',
        d.endpoint.id,
        d.endpoint.secret,
      );
    } catch (err) {
      this.logger.error(`Endpoint ${d.endpoint.id}: secret does not open: ${String(err)}`);
      return;
    }
    const result = await postWebhook(
      d.endpoint.url,
      body,
      {
        [SIGNATURE_HEADER]: signatureHeader(secret, body, Math.floor(Date.now() / 1000)),
        'midpoint-event-id': d.event.id,
        'midpoint-event-type': d.event.type,
      },
      this.config.webhooks.timeoutMs,
      { allowInsecure: this.config.webhooks.allowInsecure },
    );
    const attempts = d.attempts + 1;
    const now = new Date();
    if (result.status !== null && result.status >= 200 && result.status < 300) {
      await this.prisma.webhookDelivery.updateMany({
        where: { id: d.id, status: 'pending' },
        data: {
          status: 'delivered',
          attempts,
          lastAttemptAt: now,
          lastStatus: result.status,
          lastError: null,
          deliveredAt: now,
        },
      });
      return;
    }
    const failed = attempts >= MAX_ATTEMPTS;
    const delay = RETRY_DELAYS_SECONDS[Math.min(attempts - 1, RETRY_DELAYS_SECONDS.length - 1)];
    await this.prisma.webhookDelivery.updateMany({
      where: { id: d.id, status: 'pending' },
      data: {
        status: failed ? 'failed' : 'pending',
        attempts,
        lastAttemptAt: now,
        lastStatus: result.status,
        lastError: result.error ?? `answered ${result.status}`,
        nextAttemptAt: new Date(now.getTime() + delay * 1000),
      },
    });
  }
}
