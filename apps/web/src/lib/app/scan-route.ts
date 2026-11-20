/* Where a scanned or pasted text takes the person: @pedospe/payment-qr reads it (parseScan, the one
   reader for scanned text), this decides the screen. A payment request for another asset or
   network, or with a memo the app cannot carry, is refused here rather than half-honoured; a
   merchant QR the market does not take is refused; a secret key is a warning, never kept. Pure;
   tests/unit/scan-route.test.ts. */
import { parseScan, parseSep7, type ScanResult } from '@pedospe/payment-qr';
import { qrRail } from '@/lib/p2p/qr-pay';

export type ScanProblem =
  | Extract<ScanResult, { kind: 'unsupported' }>['reason']
  | 'other-asset'
  | 'other-network'
  | 'memo'
  | 'qr-not-taken';

export type ScanRoute =
  | {
      to: 'send';
      recipient: string;
      amount: string | null;
      note: string | null;
    }
  | { to: 'charge'; chargeId: string }
  | { to: 'pay-qr'; payload: string }
  | { to: 'secret' }
  | { to: 'problem'; problem: ScanProblem; asset?: string };

export interface ScanContext {
  /* Origins whose app and charge links are this app's. */
  origins: readonly string[];
  /* The token the app sends. */
  token: { symbol: string; code: string; issuer: string | null };
  networkPassphrase: string;
}

export function routeScan(text: string, ctx: ScanContext): ScanRoute {
  const r = parseScan(text, { origins: ctx.origins });
  switch (r.kind) {
    case 'secret-key':
      return { to: 'secret' };
    case 'unsupported':
      return { to: 'problem', problem: r.reason };
    case 'charge':
      return { to: 'charge', chargeId: r.chargeId };
    case 'merchant-qr':
      return qrRail(r.qr)
        ? { to: 'pay-qr', payload: r.qr.payload }
        : { to: 'problem', problem: 'qr-not-taken' };
    case 'pay-to': {
      if (r.via === 'sep7') {
        // A SEP-7 request names its asset by code and issuer; null is the native coin.
        if (r.asset === null) return { to: 'problem', problem: 'other-asset', asset: 'XLM' };
        if (r.asset !== ctx.token.code || r.assetIssuer !== ctx.token.issuer)
          return { to: 'problem', problem: 'other-asset', asset: r.asset };
        if (r.memo !== null && r.memoType !== 'MEMO_TEXT') return { to: 'problem', problem: 'memo' };
        const sep = parseSep7(text);
        const passphrase = sep.ok ? sep.pay.networkPassphrase : null;
        if (passphrase !== null && passphrase !== ctx.networkPassphrase)
          return { to: 'problem', problem: 'other-network' };
      } else if (r.via === 'app-link' && r.asset !== null && r.asset !== ctx.token.symbol) {
        return { to: 'problem', problem: 'other-asset', asset: r.asset };
      }
      return {
        to: 'send',
        recipient: r.to,
        amount: r.amount,
        // A text memo becomes the transfer's note (at most 28 bytes, checked by the reader).
        note: r.via === 'sep7' ? r.memo : r.note,
      };
    }
  }
}

/** A send screen's address for a route, e.g. /app/send?to=...&amount=...&note=... */
export function sendPath(r: Extract<ScanRoute, { to: 'send' }>): string {
  const q = new URLSearchParams({ to: r.recipient });
  if (r.amount) q.set('amount', r.amount);
  if (r.note) q.set('note', r.note);
  return `/app/send?${q.toString()}`;
}
