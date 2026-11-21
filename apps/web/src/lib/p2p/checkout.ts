/* checkout.ts: what the hosted charge page (/c/{chargeId}) reads from the API's keyless checkout
   routes, from the payer's browser, with no session:

     GET  /v1/checkout/charges/{id}           the charge as its payer reads it
     POST /v1/checkout/charges/{id}/orders    {rail, payer: {name, document, email}} -> the
                                              payer's order with `payerToken` (shown once)
     GET  /v1/checkout/orders/{id}            the order, with X-Payer-Token
     POST /v1/checkout/orders/{id}/paid       "I transferred" {reference?}, with X-Payer-Token
     POST /v1/checkout/orders/{id}/cancel     the payer gives up before paying

   This is a trust boundary: the page tells a payer where to send money, so every field is checked
   before it is shown, and an answer that fails a check is an error, never half-shown. Bank details
   are plain strings of a bounded length; the page writes them as text only. Pure but for
   sessionStorage (tests/unit/checkout.test.ts). */
import { P2P_ORDER_STATUSES, type P2pOrderStatus } from '@/lib/p2p/types';
export type ChargeStatus = 'open' | 'paid' | 'expired' | 'cancelled';

export interface CheckoutCharge {
  id: string;
  network: string;
  /* The token's symbol (the server's `tokenSymbol`). */
  token: string;
  currency: string;
  fiatAmount: string;
  description: string | null;
  /* Who the payer is paying (the charge creator's name), never the merchant who settles it. */
  payeeName: string | null;
  status: ChargeStatus;
  /* The rails a merchant takes for this amount right now; empty when none does. */
  rails: string[];
  expiresAt: string | null;
}

export interface CheckoutAccount {
  rail: string;
  holderName: string;
  document: string | null;
  details: Record<string, string>;
}

export interface CheckoutOrder {
  id: string;
  chargeId: string;
  status: P2pOrderStatus;
  currency: string;
  fiatAmount: string;
  rail: string;
  merchantName: string | null;
  /* The server's `paymentDeadline`. */
  payBy: string | null;
  /* Where to transfer, while the order is live. */
  paymentDetails: CheckoutAccount | null;
  paidAt: string | null;
  createdAt: string | null;
}

const ID = /^[a-z0-9][a-z0-9_-]{7,63}$/i;
const CURRENCY = /^[A-Z]{3}$/;
const FIAT = /^\d{1,15}(\.\d{1,2})?$/;
const SYMBOL = /^[A-Za-z0-9.]{1,12}$/;
const NETWORK = /^[a-z0-9-]{1,40}$/;
const RAIL = /^[a-z0-9_]{2,40}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const KEY = /^[a-zA-Z]{1,24}$/;

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
/* The server answers its objects bare; an envelope `{ data: {...} }` is read too. */
const unwrap = (json: unknown) => {
  const o = obj(json);
  return o && 'data' in o && obj(o.data) && !('id' in o) ? obj(o.data) : o;
};
const str = (v: unknown, re?: RegExp, max = 200) =>
  typeof v === 'string' && v.length <= max && (!re || re.test(v)) ? v : null;
/* A line of text for the page: no control characters, bounded. */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;
const line = (v: unknown, max = 120) =>
  typeof v === 'string' && v.trim() && v.length <= max && !CONTROL.test(v) ? v.trim() : null;
const date = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const optional = <T>(v: unknown, read: (x: unknown) => T | null): T | null | undefined =>
  v === null || v === undefined ? null : (read(v) ?? undefined);
/** The charge as its payer reads it, or null when anything is malformed. */
export function parseCheckoutCharge(json: unknown): CheckoutCharge | null {
  const o = unwrap(json);
  if (!o) return null;
  const status = o.status;
  if (status !== 'open' && status !== 'paid' && status !== 'expired' && status !== 'cancelled')
    return null;
  if (!Array.isArray(o.rails) || !o.rails.every((r) => typeof r === 'string' && RAIL.test(r)))
    return null;
  const description = optional(o.description, (x) => line(x, 200));
  const expiresAt = optional(o.expiresAt, date);
  // Who the payer pays (the charge creator's `payeeName`), never the merchant who settles it.
  const payeeName = optional(o.payeeName ?? o.merchantName, (x) => line(x, 60));
  const c = {
    id: str(o.id, ID),
    network: str(o.network, NETWORK),
    token: str(o.tokenSymbol ?? o.token, SYMBOL),
    currency: str(o.currency, CURRENCY),
    fiatAmount: str(o.fiatAmount, FIAT),
  };
  if (Object.values(c).some((v) => v === null)) return null;
  if (description === undefined || expiresAt === undefined || payeeName === undefined) return null;
  return {
    ...(c as { id: string; network: string; token: string; currency: string; fiatAmount: string }),
    description,
    payeeName,
    status,
    rails: o.rails as string[],
    expiresAt,
  };
}

/** A bank account the payer is told to pay into: a rail, a holder, and its details as short
    single-line strings under plain keys. */
export function parseAccount(v: unknown): CheckoutAccount | null {
  const o = obj(v);
  if (!o) return null;
  const rail = str(o.rail, RAIL);
  const holderName = line(o.holderName, 100);
  const raw = obj(o.details);
  if (!rail || !holderName || !raw) return null;
  const details: Record<string, string> = {};
  for (const [k, value] of Object.entries(raw)) {
    if (!KEY.test(k)) return null;
    const v2 = line(value, 80);
    if (v2 === null) return null;
    details[k] = v2;
  }
  if (!Object.keys(details).length) return null;
  const document = optional(o.document, (x) => line(x, 30));
  if (document === undefined) return null;
  return { rail, holderName, document, details };
}

/** The payer's order, or null when anything is malformed. */
export function parseCheckoutOrder(json: unknown): CheckoutOrder | null {
  const o = unwrap(json);
  if (!o) return null;
  const status = (P2P_ORDER_STATUSES as readonly string[]).includes(String(o.status))
    ? (o.status as P2pOrderStatus)
    : null;
  const payBy = optional(o.paymentDeadline ?? o.payBy, date);
  const pd =
    o.paymentDetails === null || o.paymentDetails === undefined
      ? null
      : parseAccount(o.paymentDetails);
  if (o.paymentDetails != null && !pd) return null;
  const merchantName = optional(o.merchantName, (x) => line(x, 100));
  const paidAt = optional(o.paidAt, date);
  const createdAt = optional(o.createdAt, date);
  const chargeId = o.chargeId === undefined || o.chargeId === '' ? '' : str(o.chargeId, ID);
  const c = {
    id: str(o.id, ID),
    currency: str(o.currency, CURRENCY),
    fiatAmount: str(o.fiatAmount, FIAT),
    rail: str(o.rail, RAIL),
  };
  if (!status || chargeId === null || Object.values(c).some((v) => v === null)) return null;
  if ([payBy, merchantName, paidAt, createdAt].some((v) => v === undefined)) return null;
  return {
    ...(c as { id: string; currency: string; fiatAmount: string; rail: string }),
    chargeId,
    status,
    merchantName: merchantName ?? null,
    payBy: payBy ?? null,
    paymentDetails: pd,
    paidAt: paidAt ?? null,
    createdAt: createdAt ?? null,
  };
}

/** The answer to opening the payer's order: the order's fields and, beside them, the token that
    reads it again. */
export function parseCreatedOrder(
  json: unknown,
): { order: CheckoutOrder; payerToken: string } | null {
  const o = unwrap(json);
  const order = parseCheckoutOrder(o);
  const payerToken = str(o?.payerToken, TOKEN);
  return order && payerToken ? { order, payerToken } : null;
}

/* The payer's order on a charge, kept for this tab so a reload resumes it (sessionStorage, keyed
   by charge; the token reads only that order). */
const STORE = (chargeId: string) => `pier.charge:${chargeId}`;
export function savedOrder(chargeId: string): { orderId: string; payerToken: string } | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORE(chargeId)) ?? 'null');
    return raw && ID.test(String(raw.orderId)) && TOKEN.test(String(raw.payerToken))
      ? { orderId: raw.orderId, payerToken: raw.payerToken }
      : null;
  } catch {
    return null;
  }
}
export function saveOrder(chargeId: string, value: { orderId: string; payerToken: string } | null) {
  try {
    if (value) sessionStorage.setItem(STORE(chargeId), JSON.stringify(value));
    else sessionStorage.removeItem(STORE(chargeId));
  } catch {
    /* private mode: the order lives in memory for this page only */
  }
}
