/* Paying a charge from the balance: what the screen may offer and what the transaction must do,
   pinned to trusted values only.

   - The asset is the token the app pays with (the market's own token entry: symbol, code, issuer,
     SAC contract), never one an answer names. A price quoted in another token, or one whose
     contract the answer does not state, is no price: "pay with balance" is then unavailable, never
     a different asset to pay with.
   - The destination is the receiving account the payer is shown (`payWithBalance.recipient`) and
     the amount the amount shown; the payment the API creates must be for that charge and amount.
   Pure; tests/unit/charge-pay.test.ts. */
import type { ChargePayment, PayerCharge } from '@/lib/app/types';
import type { P2pToken } from '@/lib/p2p/types';
import type { TxExpectation } from '@/lib/p2p/tx-verify';
import { isContract, isDestination } from '@/lib/stellar/network';

export type BalancePrice = NonNullable<PayerCharge['payWithBalance']>;

/** The charge's price in `token`, or null when the answer prices it in anything else. */
export function balancePrice(charge: PayerCharge, token: P2pToken | null): BalancePrice | null {
  const p = charge.payWithBalance;
  if (!p || !token || charge.status !== 'open') return null;
  if (!isContract(token.contract) || p.tokenContract !== token.contract) return null;
  if (p.token !== token.symbol) return null;
  if (!/^\d+$/.test(p.amount) || BigInt(p.amount) <= 0n || !isDestination(p.recipient)) return null;
  return p;
}

/** What the charge payment's transaction must do: the shown amount of `token` to the shown
    recipient, no memo; null (a refusal) when the API's payment is not for this charge and price. */
export function chargeExpectation(
  charge: PayerCharge,
  price: BalancePrice,
  token: P2pToken,
  payment: ChargePayment | null,
): TxExpectation | null {
  if (!payment || payment.chargeId !== charge.id || payment.amount !== price.amount) return null;
  if (payment.token && payment.token !== token.symbol && payment.token !== token.contract)
    return null;
  return {
    action: 'payment',
    to: price.recipient,
    token: token.contract,
    amountUnits: price.amount,
    memo: null,
  };
}
