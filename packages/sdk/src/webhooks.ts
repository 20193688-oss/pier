import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookEnvelope } from '@/types';

/** The header every webhook delivery is signed in (HTTP header names are case-insensitive). */
export const MIDPOINT_SIGNATURE_HEADER = 'midpoint-signature';
/** How far a delivery's timestamp may be from the receiver's clock, in seconds. */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface VerifyWebhookOptions {
  /** The raw request body, exactly as received (not re-serialized JSON). */
  payload: string;
  /** The `midpoint-signature` header value. */
  header: string | null | undefined;
  /** The endpoint's signing secret, shown once when the endpoint was created. */
  secret: string;
  /** Accepted clock difference, in seconds (default 300), in both directions. */
  toleranceSeconds?: number;
  /** The receiver's clock (default: now). */
  now?: Date;
}

/** Why a delivery failed verification. */
export type WebhookFailure =
  'malformed_header' | 'timestamp_out_of_tolerance' | 'signature_mismatch' | 'invalid_payload';

/** A delivery that is not authentic, is stale, or is not a Midpoint event. */
export class MidpointWebhookError extends Error {
  override readonly name = 'MidpointWebhookError';
  readonly reason: WebhookFailure;

  constructor(reason: WebhookFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

const TIMESTAMP = /^[0-9]{1,15}$/;
const HEX_MAC = /^[0-9a-f]{64}$/i;

function mac(secret: string, timestamp: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest();
}

/**
 * Parses `t=<unix seconds>,v1=<hex>[,v1=<hex>...]`. Exactly one `t` and at
 * least one `v1`; unknown keys are ignored so a future scheme can be added
 * next to `v1`. Null when the header is malformed.
 */
function parseHeader(header: string): { timestamp: string; signatures: Buffer[] } | null {
  let timestamp: string | null = null;
  const signatures: Buffer[] = [];
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    if (at <= 0) return null;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 't') {
      if (timestamp !== null || !TIMESTAMP.test(value)) return null;
      timestamp = value;
    } else if (key === 'v1') {
      if (!HEX_MAC.test(value)) return null;
      signatures.push(Buffer.from(value, 'hex'));
    }
  }
  return timestamp !== null && signatures.length > 0 ? { timestamp, signatures } : null;
}

function check(options: VerifyWebhookOptions): WebhookFailure | null {
  const { payload, header, secret } = options;
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  if (typeof payload !== 'string') {
    throw new TypeError('payload must be the raw request body as a string.');
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('secret must be the webhook endpoint signing secret.');
  }
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    throw new RangeError('toleranceSeconds must be a non-negative number.');
  }

  const parsed = typeof header === 'string' ? parseHeader(header) : null;
  if (parsed === null) return 'malformed_header';
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - Number(parsed.timestamp)) > toleranceSeconds) {
    return 'timestamp_out_of_tolerance';
  }
  const expected = mac(secret, parsed.timestamp, payload);
  // Every candidate is compared (constant time each) so the time taken does not
  // depend on which one matched.
  let matched = false;
  for (const signature of parsed.signatures) {
    if (timingSafeEqual(expected, signature)) matched = true;
  }
  return matched ? null : 'signature_mismatch';
}

/**
 * Whether a delivery is authentic: `midpoint-signature` carries
 * `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<payload>")>`, the MAC
 * matches (constant-time compare) and `t` is within the tolerance of `now`,
 * so a captured delivery cannot be replayed later.
 */
export function verifyWebhook(options: VerifyWebhookOptions): boolean {
  return check(options) === null;
}

/**
 * Verifies a delivery and returns its event envelope; throws a
 * `MidpointWebhookError` (with its `reason`) when it is not authentic or is
 * not an event. Deduplicate on `envelope.id`: retries carry the same id.
 */
export function parseWebhook(options: VerifyWebhookOptions): WebhookEnvelope {
  const failure = check(options);
  if (failure !== null) {
    throw new MidpointWebhookError(failure, `Webhook verification failed: ${failure}.`);
  }
  let body: unknown;
  try {
    body = JSON.parse(options.payload);
  } catch {
    throw new MidpointWebhookError('invalid_payload', 'The webhook payload is not JSON.');
  }
  if (!isEnvelope(body)) {
    throw new MidpointWebhookError(
      'invalid_payload',
      'The webhook payload is not an event envelope.',
    );
  }
  return body;
}

function isEnvelope(body: unknown): body is WebhookEnvelope {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const { id, type, createdAt, data } = body as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    typeof type === 'string' &&
    typeof createdAt === 'string' &&
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data)
  );
}

/**
 * Signs a payload the way the API does, for testing a webhook receiver:
 * returns the `midpoint-signature` header value.
 */
export function signWebhook(options: { payload: string; secret: string; now?: Date }): string {
  const t = String(Math.floor((options.now ?? new Date()).getTime() / 1000));
  return `t=${t},v1=${mac(options.secret, t, options.payload).toString('hex')}`;
}
