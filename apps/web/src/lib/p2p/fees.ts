/* fees.ts: the integrator fee a person was shown, as the contract will charge it, and what a
   person accepted when a sale opened. Kept apart from tx-verify.ts so the form can use it without
   loading the contract's ABI. Pure; tests/unit/tx-verify.test.ts. */
import { toBaseUnits } from '@/lib/p2p/amounts';
import type { P2pQuote } from '@/lib/p2p/types';

/** The contract's cap on an integrator fee (P2PMarket: 500 bps). */
export const MAX_INTEGRATOR_FEE_BPS = 500;

/** The integrator fee rate that reproduces the fee shown to the person: the bps for which the
    contract's `amount * bps / 10000` (rounded down) equals it, at most the contract's cap; 0 for
    no fee; null when no rate reproduces it (a quote that cannot be trusted). */
export function integratorBpsFor(amountUnits: string, feeUnits: string): number | null {
  if (!/^\d+$/.test(amountUnits) || !/^\d+$/.test(feeUnits)) return null;
  const amount = BigInt(amountUnits);
  const fee = BigInt(feeUnits);
  if (fee === 0n) return 0;
  if (amount === 0n) return null;
  const guess = (fee * 10_000n) / amount;
  for (const bps of [guess, guess + 1n]) {
    if (bps > 0n && bps <= BigInt(MAX_INTEGRATOR_FEE_BPS) && (amount * bps) / 10_000n === fee)
      return Number(bps);
  }
  return null;
}

/** What a sale's terms are pinned to, kept in this tab when the person accepted the quote:
    the amount they typed, the fee shown to them (base units), and the two addresses only the
    quote can name (the merchant, the integrator when there is a fee). */
export interface AcceptedQuote {
  amountUnits: string;
  integratorFeeUnits: string;
  buyer: string | null;
  integrator: string | null;
}

/** What a quote means for the person, or null when it cannot be trusted: it must answer what was
    asked (side, network, token, currency, rail, and the typed amount), and its integrator fee
    must be one the contract can charge exactly (a rate within the cap that reproduces the fee
    shown) with a named recipient. The amount and the fee shown are what a sale is later pinned
    to (tx-verify.ts). */
export function trustQuote(
  q: P2pQuote,
  asked: {
    side: string;
    network: string;
    token: string;
    currency: string;
    rail: string;
    fiatAmount?: string;
    tokenAmount?: string;
  },
  decimals: number,
): AcceptedQuote | null {
  if (
    q.side !== asked.side ||
    q.network !== asked.network ||
    q.token !== asked.token ||
    q.currency !== asked.currency ||
    q.rail !== asked.rail
  )
    return null;
  const amountUnits = toBaseUnits(q.tokenAmount, decimals);
  const feeUnits = toBaseUnits(q.integratorFee, decimals);
  if (!amountUnits || !feeUnits || amountUnits === '0') return null;
  if (asked.tokenAmount !== undefined && asked.tokenAmount !== amountUnits) return null;
  if (asked.fiatAmount !== undefined && Number(asked.fiatAmount) !== Number(q.fiatAmount))
    return null;
  const bps = integratorBpsFor(amountUnits, feeUnits);
  if (bps === null || (bps > 0 && !q.integrator)) return null;
  return {
    amountUnits,
    integratorFeeUnits: feeUnits,
    buyer: q.merchantAddress,
    integrator: bps > 0 ? q.integrator : null,
  };
}
