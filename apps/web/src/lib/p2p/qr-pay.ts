/* A QR payment (`QR_PAY`): the person pays a shop's local-money QR (Argentina's interoperable QR,
   Brazil's PIX) through a market merchant, who pays the QR from its own banking app. It is a sale
   to that merchant with fixed windows (docs/STELLAR.md 5.6): the signing check pins
   `open_with_deposit` to these, never to an answer's. */
import type { MerchantQr } from '@pedospe/payment-qr';

/** Seconds: the merchant accepts within 2 minutes, pays within 10, and the order settles by
    itself an hour after it is marked paid when nobody acts. */
export const QR_PAY_WINDOWS = { acceptSeconds: 120, paymentSeconds: 600, settleSeconds: 3600 };

/** The market rail a merchant QR is paid through, or null when the market takes none. */
export function qrRail(qr: Pick<MerchantQr, 'standard' | 'currency'>): 'ar_qr' | 'br_pix_qr' | null {
  if (qr.standard === 'ar-interoperable' && qr.currency === 'ARS') return 'ar_qr';
  if (qr.standard === 'pix' && qr.currency === 'BRL') return 'br_pix_qr';
  return null;
}

/** The rails a QR payment uses: they take no account fields (the destination is the QR). */
export const QR_RAILS = ['ar_qr', 'br_pix_qr'] as const;
export const isQrRail = (rail: string) => (QR_RAILS as readonly string[]).includes(rail);
