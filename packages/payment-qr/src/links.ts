/* This app's own links: a payment request (`<origin>/app/send?to=...`), which opens the app's
   send screen filled in, and a charge (`<origin>/pay/<id>` or `<origin>/c/<id>`), a business's
   request for an amount in local money. Only links on the origins the caller trusts count. */
import { isStellarAddress } from '@/strkey';
import { STELLAR_AMOUNT_RE } from '@/sep7';

/** A user handle: 3 to 20 of a-z, 0-9 and underscore, stored and compared in lower case. */
export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

/** `@Name`, `name` or ` @name ` → `name`; null when it is not a valid handle. */
export function normalizeHandle(input: string): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim().replace(/^@/, '').toLowerCase();
  return HANDLE_RE.test(text) ? text : null;
}

/** Where a payment goes: a Stellar address (G, M or C) or a handle written `@name`. */
export function normalizeRecipient(input: string): string | null {
  const text = typeof input === 'string' ? input.trim() : '';
  if (isStellarAddress(text)) return text;
  if (text.startsWith('@')) {
    const handle = normalizeHandle(text);
    return handle ? `@${handle}` : null;
  }
  return null;
}

export interface PaymentLink {
  /* A Stellar address, or `@handle`. */
  to: string;
  amount: string | null;
  /* The token's symbol (USDC), or null to let the payer choose. */
  asset: string | null;
  /* A short note shown to both sides; at most 28 bytes so it fits a text memo. */
  note: string | null;
}

export const PAYMENT_LINK_PATH = '/app/send';
const CHARGE_PATH_RE = /^\/(?:pay|c)\/([A-Za-z0-9_-]{6,64})\/?$/;
const ASSET_RE = /^[A-Za-z0-9]{1,12}$/;

const trimOrigin = (origin: string) => origin.replace(/\/+$/, '');

function trustedUrl(input: string, origins: readonly string[]): URL | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  return origins.map(trimOrigin).includes(url.origin) ? url : null;
}

/** A link that opens the send screen with the recipient (and optionally amount, asset, note)
    filled in. Throws when the recipient, amount or note is invalid. */
export function buildPaymentLink(
  origin: string,
  link: Partial<PaymentLink> & { to: string },
): string {
  const to = normalizeRecipient(link.to);
  if (!to) throw new Error('to must be a Stellar address or @handle');
  if (link.amount != null && !STELLAR_AMOUNT_RE.test(link.amount)) throw new Error('bad amount');
  if (link.asset != null && !ASSET_RE.test(link.asset)) throw new Error('bad asset');
  if (link.note != null && new TextEncoder().encode(link.note).length > 28) {
    throw new Error('a note holds at most 28 bytes');
  }
  const q = new URLSearchParams({ to });
  if (link.amount != null) q.set('amount', link.amount);
  if (link.asset != null) q.set('asset', link.asset.toUpperCase());
  if (link.note != null && link.note !== '') q.set('note', link.note);
  return `${trimOrigin(origin)}${PAYMENT_LINK_PATH}?${q.toString().replace(/\+/g, '%20')}`;
}

/** A payment request link on a trusted origin, or null. An invalid amount, asset or note is
    dropped (the payer types it), never guessed. */
export function parsePaymentLink(input: string, origins: readonly string[]): PaymentLink | null {
  const url = trustedUrl(input, origins);
  if (!url || url.pathname.replace(/\/+$/, '') !== PAYMENT_LINK_PATH) return null;
  const to = normalizeRecipient(url.searchParams.get('to') ?? '');
  if (!to) return null;
  const amount = url.searchParams.get('amount');
  const asset = url.searchParams.get('asset');
  const note = url.searchParams.get('note');
  return {
    to,
    amount: amount !== null && STELLAR_AMOUNT_RE.test(amount) ? amount : null,
    asset: asset !== null && ASSET_RE.test(asset) ? asset.toUpperCase() : null,
    note: note !== null && note !== '' && new TextEncoder().encode(note).length <= 28 ? note : null,
  };
}

/** The charge id of a charge link on a trusted origin, or null. */
export function parseChargeLink(input: string, origins: readonly string[]): string | null {
  const url = trustedUrl(input, origins);
  return url?.pathname.match(CHARGE_PATH_RE)?.[1] ?? null;
}
