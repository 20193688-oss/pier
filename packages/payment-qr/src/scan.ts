/* What a scanned (or pasted) text asks the app to do, in one place: pay someone, pay a business's
   charge, pay a merchant's local-money QR through a market merchant, or nothing. The screen then
   routes on `kind`; nothing here moves money. */
import { parseEmv, type MerchantQr } from '@/emv';
import { parseChargeLink, parsePaymentLink, normalizeHandle } from '@/links';
import { parseSep7, type Sep7MemoType } from '@/sep7';
import { strKeyKind } from '@/strkey';

export type ScanResult =
  | {
      kind: 'pay-to';
      via: 'address' | 'handle' | 'app-link' | 'sep7';
      /* A Stellar address, or `@handle`. */
      to: string;
      amount: string | null;
      /* App links name the token by symbol; SEP-7 by code and issuer (null code: XLM). */
      asset: string | null;
      assetIssuer: string | null;
      memo: string | null;
      memoType: Sep7MemoType | null;
      note: string | null;
    }
  | { kind: 'charge'; chargeId: string }
  | { kind: 'merchant-qr'; qr: MerchantQr }
  /* A Stellar secret seed: the screen must warn and never keep or send it. */
  | { kind: 'secret-key' }
  | {
      kind: 'unsupported';
      reason: 'sep7-tx' | 'sep7-invalid' | 'emv-invalid' | 'foreign-link' | 'unknown';
    };

export interface ScanOptions {
  /* Origins whose app and charge links are trusted, e.g. ['https://app.example']. */
  origins: readonly string[];
}

const empty = {
  amount: null,
  asset: null,
  assetIssuer: null,
  memo: null,
  memoType: null,
  note: null,
};

export function parseScan(input: string, options: ScanOptions): ScanResult {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return { kind: 'unsupported', reason: 'unknown' };

  const keyKind = strKeyKind(text);
  if (keyKind === 'secret') return { kind: 'secret-key' };
  if (keyKind) return { kind: 'pay-to', via: 'address', to: text, ...empty };

  if (text.startsWith('@')) {
    const handle = normalizeHandle(text);
    return handle
      ? { kind: 'pay-to', via: 'handle', to: `@${handle}`, ...empty }
      : { kind: 'unsupported', reason: 'unknown' };
  }

  if (text.toLowerCase().startsWith('web+stellar:')) {
    const sep7 = parseSep7(text);
    if (!sep7.ok) {
      return {
        kind: 'unsupported',
        reason: sep7.error === 'unsupported-operation' ? 'sep7-tx' : 'sep7-invalid',
      };
    }
    const p = sep7.pay;
    return {
      kind: 'pay-to',
      via: 'sep7',
      to: p.destination,
      amount: p.amount,
      asset: p.assetCode,
      assetIssuer: p.assetIssuer,
      memo: p.memo,
      memoType: p.memoType,
      note: p.message,
    };
  }

  if (text.startsWith('000201')) {
    const emv = parseEmv(text);
    return emv.ok
      ? { kind: 'merchant-qr', qr: emv.qr }
      : { kind: 'unsupported', reason: 'emv-invalid' };
  }

  if (/^https?:\/\//i.test(text)) {
    const chargeId = parseChargeLink(text, options.origins);
    if (chargeId) return { kind: 'charge', chargeId };
    const link = parsePaymentLink(text, options.origins);
    if (link) {
      return {
        kind: 'pay-to',
        via: 'app-link',
        to: link.to,
        amount: link.amount,
        asset: link.asset,
        assetIssuer: null,
        memo: link.note,
        memoType: link.note ? 'MEMO_TEXT' : null,
        note: link.note,
      };
    }
    return { kind: 'unsupported', reason: 'foreign-link' };
  }

  return { kind: 'unsupported', reason: 'unknown' };
}
