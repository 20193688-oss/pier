/* How the mock API shows an order to each side, and which orders are the app user's own. */
import { parseEmv } from '@pedospe/payment-qr';
import { db, pub, tick, type Wire } from '@/lib/mock/db';

/** A QR payment's QR as its merchant sees it, only while the order is live. */
export function qrView(o: Wire) {
  if (!o._qr || !['awaiting_acceptance', 'awaiting_payment', 'paid', 'disputed'].includes(o.status))
    return null;
  const r = parseEmv(o._qr);
  if (!r.ok) return null;
  return {
    payload: r.qr.payload,
    standard: r.qr.standard,
    merchantName: r.qr.merchantName,
    merchantCity: r.qr.merchantCity,
    amount: r.qr.amount ?? o._qrAmount ?? null,
    currency: r.qr.currency,
    reference: r.qr.reference,
  };
}

export function orderView(o: Wire, role: 'client' | 'merchant') {
  const v = pub(tick(o));
  if (role === 'merchant')
    return {
      ...v,
      role: 'merchant',
      merchantAccountId: 'acc_norte_treasury',
      ...(o.kind === 'QR_PAY' ? { qr: qrView(o) } : {}),
    };
  // The client side never sees the beneficiary of someone else's account details; a QR payment's
  // payer sees its QR's summary, not the payload.
  if (o.kind === 'QR_PAY') {
    const q = qrView({ ...o, status: 'paid' });
    return {
      ...v,
      role: 'client',
      qr: q
        ? {
            standard: q.standard,
            merchantName: q.merchantName,
            merchantCity: q.merchantCity,
            amount: q.amount,
            currency: q.currency,
          }
        : null,
    };
  }
  return { ...v, role: 'client' };
}

export const myAppOrders = (address: string) =>
  db().orders.filter(
    (o) => o._owner === 'app' && (o.buyerAddress === address || o.sellerAddress === address),
  );
