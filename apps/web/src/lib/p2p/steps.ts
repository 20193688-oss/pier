/* A sale's two unsigned transactions may come only with the order's creation (a later read need
   not repeat them), so this tab keeps them until the wallet sent both: a reload can still sign.
   sessionStorage only; they are unsigned calldata, not secrets. */
import type { P2pTransaction } from '@/lib/p2p/types';
import type { AcceptedQuote } from '@/lib/p2p/fees';

const KEY = (orderId: string) => `pedospe.steps:${orderId}`;

export function saveSteps(orderId: string, steps: P2pTransaction[] | undefined) {
  try {
    if (steps?.length) sessionStorage.setItem(KEY(orderId), JSON.stringify(steps));
    else sessionStorage.removeItem(KEY(orderId));
  } catch {
    /* private mode: the steps stay in memory for this page only */
  }
}

export function savedSteps(orderId: string): P2pTransaction[] | undefined {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY(orderId)) ?? 'null');
    return Array.isArray(raw) && raw.length ? (raw as P2pTransaction[]) : undefined;
  } catch {
    return undefined;
  }
}

/** What the person accepted when a sale opened (the amount they typed, the fee shown to them,
    the addresses the quote named), kept beside its steps so the signing check compares the
    transaction with what they saw, not with what a later answer says (tx-verify.ts). */
const TERMS = (orderId: string) => `pedospe.accepted:${orderId}`;

export function saveQuoteTerms(orderId: string, accepted: AcceptedQuote | undefined) {
  try {
    if (accepted) sessionStorage.setItem(TERMS(orderId), JSON.stringify(accepted));
    else sessionStorage.removeItem(TERMS(orderId));
  } catch {
    /* private mode: nothing is kept, and the check falls back to the strictest terms */
  }
}

/** The kept acceptance, or null (another tab, cleared storage): the check then pins the order's
    own amount and buyer, and no fee. */
export function savedQuoteTerms(orderId: string): AcceptedQuote | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(TERMS(orderId)) ?? 'null');
    if (!raw || typeof raw !== 'object') return null;
    const units = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? v : null);
    const address = (v: unknown) =>
      typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null;
    const amountUnits = units(raw.amountUnits);
    const integratorFeeUnits = units(raw.integratorFeeUnits);
    if (!amountUnits || !integratorFeeUnits) return null;
    return {
      amountUnits,
      integratorFeeUnits,
      buyer: address(raw.buyer),
      integrator: address(raw.integrator),
    };
  } catch {
    return null;
  }
}
