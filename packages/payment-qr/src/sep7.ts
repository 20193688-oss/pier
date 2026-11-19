/* SEP-7 payment requests (`web+stellar:pay?...`): what other Stellar wallets put in a QR to ask
   for a payment, and what this app's "receive" screen can show so any Stellar wallet can pay it.

   A request may carry `origin_domain` + `signature`; checking that signature needs the domain's
   stellar.toml, which this package does not fetch, so `signed` only says one is present and a
   screen must never present the origin domain as verified. */
import { isStellarAddress } from '@/strkey';

export const SEP7_SCHEME = 'web+stellar:';

export type Sep7MemoType = 'MEMO_TEXT' | 'MEMO_ID' | 'MEMO_HASH' | 'MEMO_RETURN';

export interface Sep7Pay {
  destination: string;
  amount: string | null;
  /* Null code: the network's native coin (XLM). */
  assetCode: string | null;
  assetIssuer: string | null;
  memo: string | null;
  memoType: Sep7MemoType | null;
  /* A note for the payer (`msg`, at most 300 characters). */
  message: string | null;
  networkPassphrase: string | null;
  originDomain: string | null;
  signed: boolean;
}

export type Sep7Result =
  | { ok: true; pay: Sep7Pay }
  | { ok: false; error: 'not-sep7' | 'unsupported-operation' | 'invalid' };

/** Decimal with at most seven places (Stellar's precision), positive. */
export const STELLAR_AMOUNT_RE = /^(?!0+(\.0+)?$)\d{1,12}(\.\d{1,7})?$/;
const ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/;
const MEMO_TYPES: readonly Sep7MemoType[] = ['MEMO_TEXT', 'MEMO_ID', 'MEMO_HASH', 'MEMO_RETURN'];

/** Reads a SEP-7 URI; only the `pay` operation is supported (`tx` asks to sign an arbitrary
    transaction, which a payments app refuses). */
export function parseSep7(input: string): Sep7Result {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text.toLowerCase().startsWith(SEP7_SCHEME)) return { ok: false, error: 'not-sep7' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  const operation = url.pathname.replace(/^\/+/, '').toLowerCase();
  if (operation !== 'pay') return { ok: false, error: 'unsupported-operation' };
  const q = url.searchParams;
  const destination = q.get('destination') ?? '';
  if (!isStellarAddress(destination)) return { ok: false, error: 'invalid' };
  const amount = q.get('amount');
  if (amount !== null && !STELLAR_AMOUNT_RE.test(amount)) return { ok: false, error: 'invalid' };
  const assetCode = q.get('asset_code');
  const assetIssuer = q.get('asset_issuer');
  if (assetCode !== null && !ASSET_CODE_RE.test(assetCode)) return { ok: false, error: 'invalid' };
  if (assetIssuer !== null && !isStellarAddress(assetIssuer, ['account'])) {
    return { ok: false, error: 'invalid' };
  }
  // A non-native asset is named by code AND issuer; an issuer alone means nothing.
  if ((assetCode === null) !== (assetIssuer === null) && assetCode?.toUpperCase() !== 'XLM') {
    return { ok: false, error: 'invalid' };
  }
  const memoTypeRaw = q.get('memo_type');
  const memoType = memoTypeRaw === null ? null : (memoTypeRaw.toUpperCase() as Sep7MemoType);
  if (memoType !== null && !MEMO_TYPES.includes(memoType)) return { ok: false, error: 'invalid' };
  const memo = q.get('memo');
  if (
    memo !== null &&
    (memoType ?? 'MEMO_TEXT') === 'MEMO_TEXT' &&
    new TextEncoder().encode(memo).length > 28
  ) {
    return { ok: false, error: 'invalid' };
  }
  if (memo !== null && memoType === 'MEMO_ID' && !/^\d{1,20}$/.test(memo)) {
    return { ok: false, error: 'invalid' };
  }
  const message = q.get('msg');
  if (message !== null && message.length > 300) return { ok: false, error: 'invalid' };
  const native = assetCode === null || (assetCode.toUpperCase() === 'XLM' && assetIssuer === null);
  return {
    ok: true,
    pay: {
      destination,
      amount,
      assetCode: native ? null : assetCode,
      assetIssuer: native ? null : assetIssuer,
      memo,
      memoType: memo === null ? null : (memoType ?? 'MEMO_TEXT'),
      message,
      networkPassphrase: q.get('network_passphrase'),
      originDomain: q.get('origin_domain'),
      signed: q.has('signature'),
    },
  };
}

export interface Sep7PayInput {
  destination: string;
  amount?: string | null;
  assetCode?: string | null;
  assetIssuer?: string | null;
  /* A text memo (at most 28 bytes). */
  memo?: string | null;
  message?: string | null;
  networkPassphrase?: string | null;
}

/** An unsigned `web+stellar:pay` URI. Throws on an invalid destination, amount or asset. */
export function buildSep7Pay(input: Sep7PayInput): string {
  if (!isStellarAddress(input.destination)) throw new Error('destination is not a Stellar address');
  if (input.amount != null && !STELLAR_AMOUNT_RE.test(input.amount)) {
    throw new Error('amount must be a positive decimal with at most 7 places');
  }
  if ((input.assetCode == null) !== (input.assetIssuer == null)) {
    throw new Error('a non-native asset needs both its code and its issuer');
  }
  if (input.assetCode != null && !ASSET_CODE_RE.test(input.assetCode))
    throw new Error('bad asset code');
  if (input.assetIssuer != null && !isStellarAddress(input.assetIssuer, ['account'])) {
    throw new Error('bad asset issuer');
  }
  if (input.memo != null && new TextEncoder().encode(input.memo).length > 28) {
    throw new Error('a text memo holds at most 28 bytes');
  }
  const q = new URLSearchParams({ destination: input.destination });
  if (input.amount != null) q.set('amount', input.amount);
  if (input.assetCode != null) q.set('asset_code', input.assetCode);
  if (input.assetIssuer != null) q.set('asset_issuer', input.assetIssuer);
  if (input.memo != null) {
    q.set('memo', input.memo);
    q.set('memo_type', 'MEMO_TEXT');
  }
  if (input.message != null) q.set('msg', input.message.slice(0, 300));
  if (input.networkPassphrase != null) q.set('network_passphrase', input.networkPassphrase);
  // SEP-7 asks for percent-encoding (%20), not form encoding (+).
  return `${SEP7_SCHEME}pay?${q.toString().replace(/\+/g, '%20')}`;
}
