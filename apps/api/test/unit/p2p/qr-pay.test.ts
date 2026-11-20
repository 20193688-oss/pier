import { emvCrc } from '@pedospe/payment-qr';
import { describe, expect, it } from 'vitest';
import { isReservedHandle } from '@/p2p/app-wallet.service';
import { qrHash, readQrPayment } from '@/p2p/domain/qr-pay';
import { isQrRail, P2P_RAILS, qrRailFor, validateRailDetails } from '@/p2p/domain/rails';

const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** An EMV merchant QR with a valid CRC. */
function emv(fields: string[]): string {
  const body = `${tlv('00', '01')}${fields.join('')}6304`;
  return `${body}${emvCrc(body)}`;
}

/** Argentina's interoperable QR (a dynamic one carries its amount). */
const arQr = (amount?: string) =>
  emv([
    tlv('01', amount ? '12' : '11'),
    tlv('43', `${tlv('00', 'com.mercadolibre')}${tlv('01', 'abc123')}`),
    tlv('52', '5812'),
    tlv('53', '032'),
    ...(amount ? [tlv('54', amount)] : []),
    tlv('58', 'AR'),
    tlv('59', 'PANADERIA SALTENA'),
    tlv('60', 'SALTA'),
    tlv('62', tlv('05', 'TICKET-42')),
  ]);

/** A PIX BR Code. */
const pixQr = (amount?: string) =>
  emv([
    tlv('01', '12'),
    tlv('26', `${tlv('00', 'br.gov.bcb.pix')}${tlv('01', 'pix@loja.example')}`),
    tlv('52', '0000'),
    tlv('53', '986'),
    ...(amount ? [tlv('54', amount)] : []),
    tlv('58', 'BR'),
    tlv('59', 'LOJA'),
    tlv('60', 'SAO PAULO'),
  ]);

describe('QR payments', () => {
  it('reads Argentina’s interoperable QR on ar_qr, with its own amount', () => {
    const read = readQrPayment(arQr('12500.00'));
    if (!read.ok) throw new Error(read.error);
    expect(read).toMatchObject({ rail: 'ar_qr', currency: 'ARS', fiatAmount: '12500.00' });
    expect(read.summary).toEqual({
      standard: 'ar-interoperable',
      merchantName: 'PANADERIA SALTENA',
      merchantCity: 'SALTA',
      amount: '12500.00',
      currency: 'ARS',
    });
    expect(read.sealed).toMatchObject({ payload: arQr('12500.00'), reference: 'TICKET-42' });
    expect(read.hash).toBe(qrHash(arQr('12500.00')));
  });

  it('reads PIX on br_pix_qr', () => {
    const read = readQrPayment(pixQr('35.90'));
    expect(read).toMatchObject({
      ok: true,
      rail: 'br_pix_qr',
      currency: 'BRL',
      fiatAmount: '35.90',
    });
  });

  it('takes the typed amount only for a QR without one, and must agree with a QR that has one', () => {
    expect(readQrPayment(arQr())).toMatchObject({ ok: false });
    expect(readQrPayment(arQr(), '800')).toMatchObject({ ok: true, fiatAmount: '800.00' });
    expect(readQrPayment(arQr('12500.00'), '12500')).toMatchObject({ ok: true });
    expect(readQrPayment(arQr('12500.00'), '100')).toMatchObject({ ok: false });
  });

  it('refuses a bad CRC, a non-EMV text and a QR of another standard or currency', () => {
    const good = arQr('10');
    expect(readQrPayment(`${good.slice(0, -1)}${good.endsWith('0') ? '1' : '0'}`)).toMatchObject({
      ok: false,
    });
    expect(readQrPayment('hello')).toMatchObject({ ok: false });
    const usd = emv([tlv('53', '840'), tlv('58', 'US'), tlv('59', 'SHOP'), tlv('60', 'NYC')]);
    expect(readQrPayment(usd, '10')).toMatchObject({ ok: false });
  });

  it('keeps QR rails out of accounts', () => {
    expect(isQrRail('ar_qr')).toBe(true);
    expect(isQrRail('ar_bank_transfer')).toBe(false);
    expect(qrRailFor('pix')).toBe('br_pix_qr');
    expect(qrRailFor('emv')).toBeNull();
    expect(P2P_RAILS.ar_qr.fields).toEqual([]);
    expect(validateRailDetails('ar_qr', 'ARS', {})).toMatchObject({ ok: false });
  });
});

describe('handles', () => {
  it('reserves the product’s and the platform’s words', () => {
    expect(isReservedHandle('admin', 'pedospe')).toBe(true);
    expect(isReservedHandle('pedospe_team', 'pedospe')).toBe(true);
    expect(isReservedHandle('newbrand', 'New Brand')).toBe(true);
    expect(isReservedHandle('maria_salta', 'pedospe')).toBe(false);
  });
});
