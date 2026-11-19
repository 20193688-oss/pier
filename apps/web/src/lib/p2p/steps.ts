/* A sale's two unsigned transactions may come only with the order's creation (a later read need
   not repeat them), so this tab keeps them until the wallet sent both: a reload can still sign.
   sessionStorage only; they are unsigned calldata, not secrets. */
import type { P2pTransaction } from '@/lib/p2p/types';

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

/** The terms of the quote a sale was opened from (merchant address, bond, integrator and fee),
    kept beside its steps so the signing check compares the transaction with what the person
    accepted, not with what a later answer says. */
export interface QuoteTerms {
  /* The token amount the quote stated, in base units. */
  amountUnits: string | null;
  buyer: string | null;
  bondUnits: string | null;
  integrator: string | null;
  integratorFeeBps: number;
}

const TERMS = (orderId: string) => `pedospe.terms:${orderId}`;

export function saveQuoteTerms(orderId: string, terms: QuoteTerms | undefined) {
  try {
    if (terms) sessionStorage.setItem(TERMS(orderId), JSON.stringify(terms));
    else sessionStorage.removeItem(TERMS(orderId));
  } catch {
    /* private mode: the terms stay in memory for this page only */
  }
}

/** The kept terms; with none kept (another tab, cleared storage), the strictest: no named
    merchant claim, the market's bond rate, no integrator and no fee. */
export function savedQuoteTerms(orderId: string): QuoteTerms {
  try {
    const raw = JSON.parse(sessionStorage.getItem(TERMS(orderId)) ?? 'null');
    if (raw && typeof raw === 'object')
      return {
        amountUnits:
          typeof raw.amountUnits === 'string' && /^\d+$/.test(raw.amountUnits)
            ? raw.amountUnits
            : null,
        buyer: typeof raw.buyer === 'string' ? raw.buyer : null,
        bondUnits: typeof raw.bondUnits === 'string' ? raw.bondUnits : null,
        integrator: typeof raw.integrator === 'string' ? raw.integrator : null,
        integratorFeeBps: Number.isInteger(raw.integratorFeeBps) ? raw.integratorFeeBps : 0,
      };
  } catch {
    /* the strictest below */
  }
  return { amountUnits: null, buyer: null, bondUnits: null, integrator: null, integratorFeeBps: 0 };
}
