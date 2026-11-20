import { createHash } from 'node:crypto';
import { parseEmv, type MerchantQr } from '@midpoint/payment-qr';
import { P2P_CURRENCIES, type P2pCurrency } from '@/p2p/domain/constants';
import { formatUnits, parseDecimalUnits } from '@/p2p/domain/pricing';
import { P2P_RAILS, qrRailFor, type P2pRailId } from '@/p2p/domain/rails';

/**
 * A scanned merchant QR as a QR payment (`QR_PAY`) reads it. Parsing is
 * `@midpoint/payment-qr`'s `parseEmv` (CRC checked, repeated or ambiguous
 * fields refused); this only decides whether the market pays it: the
 * standard must have a QR rail (Argentina's interoperable QR → `ar_qr`, PIX
 * → `br_pix_qr`), the QR's currency must be that rail's (ARS or BRL), and a
 * QR that carries its own amount is paid exactly that amount.
 */

/** What the person who scanned sees (no payload). */
export interface QrSummary {
  standard: string;
  merchantName: string | null;
  merchantCity: string | null;
  amount: string | null;
  currency: string | null;
}

/** What is sealed on the order and shown to its merchant while it is live. */
export interface SealedQr extends QrSummary {
  payload: string;
  reference: string | null;
}

export type QrPayment =
  | {
      ok: true;
      rail: P2pRailId;
      currency: P2pCurrency;
      /** The local money to pay, decimal, in the currency's minor units. */
      fiatAmount: string;
      /** SHA-256 of the payload, hex: the quote and the order must name the same QR. */
      hash: string;
      summary: QrSummary;
      sealed: SealedQr;
    }
  | { ok: false; error: string };

/** SHA-256 of a scanned payload (trimmed, as `parseEmv` reads it), hex. */
export function qrHash(payload: string): string {
  return createHash('sha256').update(payload.trim(), 'utf8').digest('hex');
}

const ERRORS = {
  'not-emv': 'this is not a merchant QR (EMV)',
  malformed: 'the QR is malformed or ambiguous',
  'bad-crc': 'the QR’s checksum (CRC) does not match: scan it again',
} as const;

/**
 * Reads a scanned QR for a payment of `fiatAmount` (needed only when the QR
 * carries no amount; when both are given they must be equal).
 */
export function readQrPayment(payload: string, fiatAmount?: string): QrPayment {
  const parsed = parseEmv(payload);
  if (!parsed.ok) return { ok: false, error: ERRORS[parsed.error] };
  const qr: MerchantQr = parsed.qr;
  const rail = qrRailFor(qr.standard);
  if (!rail) {
    return {
      ok: false,
      error: 'only Argentina’s interoperable QR (Transferencias 3.0) and PIX QR codes are paid',
    };
  }
  const currency = P2P_RAILS[rail].currency;
  if (qr.currency !== currency) {
    return { ok: false, error: `a ${qr.standard} QR must ask for ${currency}` };
  }
  const decimals = P2P_CURRENCIES[currency].decimals;
  const own = qr.amount !== null ? parseDecimalUnits(qr.amount, decimals) : null;
  const typed = fiatAmount !== undefined ? parseDecimalUnits(fiatAmount, decimals) : null;
  if (qr.amount !== null && (own === null || own <= 0n)) {
    return { ok: false, error: 'the QR’s amount is not valid' };
  }
  if (fiatAmount !== undefined && (typed === null || typed <= 0n)) {
    return {
      ok: false,
      error: `fiatAmount must be greater than 0 with at most ${decimals} decimals`,
    };
  }
  if (own !== null && typed !== null && own !== typed) {
    return {
      ok: false,
      error: `the QR asks for ${qr.amount} ${currency}: fiatAmount must equal it`,
    };
  }
  const units = own ?? typed;
  if (units === null) {
    return { ok: false, error: 'this QR carries no amount: give fiatAmount' };
  }
  const summary: QrSummary = {
    standard: qr.standard,
    merchantName: qr.merchantName,
    merchantCity: qr.merchantCity,
    amount: qr.amount,
    currency: qr.currency,
  };
  return {
    ok: true,
    rail,
    currency,
    fiatAmount: formatUnits(units, decimals),
    hash: qrHash(qr.payload),
    summary,
    sealed: { ...summary, payload: qr.payload, reference: qr.reference },
  };
}
