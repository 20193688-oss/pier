/* A QR payment (`QR_PAY`): the person pays a shop's local-money QR (Argentina's interoperable QR,
   Brazil's PIX, Peru's interoperable QR: Yape, Plin and the banks) through a market merchant, who pays the QR from its own banking app. It is a sale
   to that merchant with fixed windows (docs/STELLAR.md 5.6): the signing check pins
   `open_with_deposit` to these, never to an answer's. */
import type { MerchantQr } from '@pier/payment-qr';
import { integratorBpsFor, type AcceptedQuote } from '@/lib/p2p/fees';
import { toBaseUnits } from '@/lib/p2p/amounts';
import { isAccount } from '@/lib/stellar/network';
import type { P2pQuote } from '@/lib/p2p/types';

/** Seconds: the merchant accepts within 2 minutes, pays within 10, and the order settles by
    itself an hour after it is marked paid when nobody acts. */
export const QR_PAY_WINDOWS = { acceptSeconds: 120, paymentSeconds: 600, settleSeconds: 3600 };

/** The market rail a merchant QR is paid through, or null when the market takes none. */
export function qrRail(
  qr: Pick<MerchantQr, 'standard' | 'currency'>,
): 'ar_qr' | 'br_pix_qr' | 'pe_qr' | null {
  if (qr.standard === 'ar-interoperable' && qr.currency === 'ARS') return 'ar_qr';
  if (qr.standard === 'pix' && qr.currency === 'BRL') return 'br_pix_qr';
  if (qr.standard === 'pe-interoperable' && qr.currency === 'PEN') return 'pe_qr';
  return null;
}

/** The rails a QR payment uses: they take no account fields (the destination is the QR). */
export const QR_RAILS = ['ar_qr', 'br_pix_qr', 'pe_qr'] as const;
export const isQrRail = (rail: string) => (QR_RAILS as readonly string[]).includes(rail);

/** What a QR payment's quote means for the person, or null when it cannot be trusted: it must be
    for the network, token and rail the QR takes, in the QR's currency, for the QR's own amount
    (or the amount typed for a static QR), and carry an integrator fee the contract can charge
    exactly. The sale is later pinned to this (tx-verify.ts). */
export function trustQrQuote(
  q: P2pQuote,
  asked: {
    network: string;
    token: string;
    qr: Pick<MerchantQr, 'standard' | 'currency' | 'amount'>;
    fiatAmount: string | null;
  },
  decimals: number,
): AcceptedQuote | null {
  const rail = qrRail(asked.qr);
  if (!rail || q.network !== asked.network || q.token !== asked.token) return null;
  if (q.currency !== asked.qr.currency || q.rail !== rail) return null;
  const want = asked.qr.amount ?? asked.fiatAmount;
  if (!want || !(Number(want) > 0) || Number(q.fiatAmount) !== Number(want)) return null;
  const amountUnits = toBaseUnits(q.tokenAmount, decimals);
  const feeUnits = toBaseUnits(q.integratorFee, decimals);
  if (!amountUnits || !feeUnits || amountUnits === '0') return null;
  const bps = integratorBpsFor(amountUnits, feeUnits);
  if (bps === null || (bps > 0 && !isAccount(q.integrator))) return null;
  return {
    amountUnits,
    integratorFeeUnits: feeUnits,
    // A quote need not name the merchant: the sale then pins the order's own buyer.
    buyer: isAccount(q.merchantAddress) ? q.merchantAddress : null,
    integrator: bps > 0 ? q.integrator : null,
  };
}
