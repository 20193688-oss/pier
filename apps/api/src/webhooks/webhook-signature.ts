import { createHmac, timingSafeEqual } from 'node:crypto';

/** The header every delivery is signed in. */
export const SIGNATURE_HEADER = 'pedospe-signature';
/** How far a receiver should accept a delivery's timestamp from its own clock. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * `pedospe-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
 * The timestamp is inside the MAC, so a captured delivery cannot be replayed
 * later with a fresh one; receivers check it within a tolerance.
 */
export function signatureHeader(secret: string, body: string, timestamp: number): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

/** Whether a header signs `body` with `secret` within the tolerance (constant-time compare). */
export function verifySignatureHeader(
  header: string,
  body: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const at = part.indexOf('=');
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = Buffer.from(signatureHeader(secret, body, t).split('v1=')[1], 'hex');
  return timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'));
}
