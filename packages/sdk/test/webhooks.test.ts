import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PIER_SIGNATURE_HEADER,
  PierWebhookError,
  parseWebhook,
  signWebhook,
  verifyWebhook,
} from '@/webhooks';

const secret = 'whsec_test_5f2b9c';
const now = new Date('2026-11-19T12:00:00.000Z');
const t = Math.floor(now.getTime() / 1000);
const payload = JSON.stringify({
  id: 'evt_0f7c',
  type: 'P2P_ORDER_PAID',
  createdAt: '2026-11-19T11:59:58.000Z',
  data: { id: '3f1c2b7e', status: 'paid' },
});

/** Signs exactly as the API does (apps/api/src/webhooks/webhook-signature.ts). */
function header(body: string, timestamp = t, key = secret): string {
  const mac = createHmac('sha256', key).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

describe('verifyWebhook', () => {
  it('names the header the API signs in', () => {
    expect(PIER_SIGNATURE_HEADER).toBe('pier-signature');
  });

  it('accepts a delivery signed with the secret within the tolerance', () => {
    expect(verifyWebhook({ payload, header: header(payload), secret, now })).toBe(true);
    // Spaces after commas and upper-case hex are still the same signature.
    const spaced = header(payload).replace(',', ', ').toUpperCase().replace('T=', 't=');
    expect(verifyWebhook({ payload, header: spaced.replace('V1=', 'v1='), secret, now })).toBe(
      true,
    );
  });

  it('matches what signWebhook produces', () => {
    expect(signWebhook({ payload, secret, now })).toBe(header(payload));
  });

  it('rejects a tampered body', () => {
    const tampered = payload.replace('"paid"', '"completed"');
    expect(verifyWebhook({ payload: tampered, header: header(payload), secret, now })).toBe(false);
    expect(verifyWebhook({ payload: `${payload} `, header: header(payload), secret, now })).toBe(
      false,
    );
  });

  it('rejects a signature made with another secret', () => {
    const forged = header(payload, t, 'whsec_other');
    expect(verifyWebhook({ payload, header: forged, secret, now })).toBe(false);
  });

  it('rejects a timestamp swapped into a valid MAC (the timestamp is signed)', () => {
    const mac = header(payload).split('v1=')[1];
    expect(verifyWebhook({ payload, header: `t=${t + 1},v1=${mac}`, secret, now })).toBe(false);
  });

  it('rejects stale and future timestamps beyond the tolerance', () => {
    expect(verifyWebhook({ payload, header: header(payload, t - 300), secret, now })).toBe(true);
    expect(verifyWebhook({ payload, header: header(payload, t - 301), secret, now })).toBe(false);
    expect(verifyWebhook({ payload, header: header(payload, t + 300), secret, now })).toBe(true);
    expect(verifyWebhook({ payload, header: header(payload, t + 301), secret, now })).toBe(false);
  });

  it('honours a custom tolerance', () => {
    const old = header(payload, t - 3_600);
    expect(verifyWebhook({ payload, header: old, secret, now })).toBe(false);
    expect(verifyWebhook({ payload, header: old, secret, now, toleranceSeconds: 3_600 })).toBe(
      true,
    );
    expect(() => verifyWebhook({ payload, header: old, secret, toleranceSeconds: -1 })).toThrow(
      RangeError,
    );
  });

  it('rejects malformed headers', () => {
    const mac = header(payload).split('v1=')[1];
    const malformed = [
      undefined,
      null,
      '',
      'garbage',
      `v1=${mac}`,
      `t=${t}`,
      `t=${t},v1=`,
      `t=${t},v1=${mac.slice(2)}`,
      `t=${t},v1=${mac}00`,
      `t=${t},v1=${'z'.repeat(64)}`,
      `t=abc,v1=${mac}`,
      `t=-${t},v1=${mac}`,
      `t=${t}.5,v1=${mac}`,
      `t=${t},t=${t},v1=${mac}`,
      `t=${t},v1=${mac},`,
      `t=${t};v1=${mac}`,
    ];
    for (const value of malformed) {
      expect(verifyWebhook({ payload, header: value, secret, now }), String(value)).toBe(false);
    }
  });

  it('accepts any matching v1 and ignores unknown schemes', () => {
    const mac = header(payload).split('v1=')[1];
    const rotated = `t=${t},v1=${'0'.repeat(64)},v1=${mac},v2=future`;
    expect(verifyWebhook({ payload, header: rotated, secret, now })).toBe(true);
  });

  it('refuses to verify without a secret', () => {
    expect(() => verifyWebhook({ payload, header: header(payload), secret: '', now })).toThrow(
      TypeError,
    );
  });
});

describe('parseWebhook', () => {
  it('returns the typed envelope of an authentic delivery', () => {
    const event = parseWebhook({ payload, header: header(payload), secret, now });
    expect(event).toEqual({
      id: 'evt_0f7c',
      type: 'P2P_ORDER_PAID',
      createdAt: '2026-11-19T11:59:58.000Z',
      data: { id: '3f1c2b7e', status: 'paid' },
    });
  });

  it('throws with the reason when verification fails', () => {
    const cases = [
      { header: 'nope', reason: 'malformed_header' },
      { header: header(payload, t - 1_000), reason: 'timestamp_out_of_tolerance' },
      { header: header(payload, t, 'whsec_other'), reason: 'signature_mismatch' },
    ];
    for (const c of cases) {
      let caught: unknown;
      try {
        parseWebhook({ payload, header: c.header, secret, now });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PierWebhookError);
      expect((caught as PierWebhookError).reason).toBe(c.reason);
    }
  });

  it('throws on an authentic body that is not an event envelope', () => {
    for (const body of ['not json', '[]', '{"id":"evt_1","type":"P2P_ORDER_PAID"}']) {
      expect(() => parseWebhook({ payload: body, header: header(body), secret, now })).toThrow(
        expect.objectContaining({ reason: 'invalid_payload' }),
      );
    }
  });
});
