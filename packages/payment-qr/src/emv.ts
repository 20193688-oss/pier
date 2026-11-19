/* EMVCo merchant-presented QR codes (EMV QRCPS-MPM): the format of Brazil's PIX "BR Code" and of
   Argentina's interoperable QR (Transferencias 3.0), among others. A payload is a run of TLV
   fields (two-digit id, two-digit length, value), ending in field 63: a CRC16/CCITT-FALSE of
   everything before its value. Templates (26-51 merchant accounts, 62 additional data, 64
   language, 80-99) nest TLV fields of their own.

   This reads and checks a payload; it never pays it. The text is kept exactly as scanned, because
   whoever pays it (a merchant's banking app) must scan the same bytes. */

export interface EmvField {
  id: string;
  value: string;
  /* A template's own fields, when its value parses as TLV. */
  children?: EmvField[];
}

export type MerchantQrStandard = 'pix' | 'ar-interoperable' | 'emv';

export interface MerchantQr {
  standard: MerchantQrStandard;
  /* The exact text scanned, CRC included. */
  payload: string;
  /* A dynamic QR (point of initiation 12) is made for one payment; a static one (11) is reused. */
  dynamic: boolean;
  merchantName: string | null;
  merchantCity: string | null;
  /* ISO 3166-1 alpha-2 (field 58). */
  countryCode: string | null;
  /* ISO 4217 alpha code, when the numeric code (field 53) is one this package knows. */
  currency: string | null;
  currencyNumeric: string | null;
  /* The amount the QR asks for (field 54), a decimal string, or null when the payer types it. */
  amount: string | null;
  /* PIX: the key (static) or the payload URL (dynamic). */
  pixKey: string | null;
  pixUrl: string | null;
  /* Field 62, sub-field 05: the reference label. */
  reference: string | null;
  /* The globally unique identifiers (sub-field 00) of the merchant account templates, such as
     "br.gov.bcb.pix" or a payment provider's reverse domain. */
  accounts: string[];
  fields: EmvField[];
}

export type EmvError = 'not-emv' | 'malformed' | 'bad-crc';

export type EmvResult = { ok: true; qr: MerchantQr } | { ok: false; error: EmvError };

/** Longest payload accepted (EMV allows 512 characters). */
export const EMV_MAX_LENGTH = 512;

const CURRENCIES: Record<string, string> = {
  '032': 'ARS',
  '068': 'BOB',
  '152': 'CLP',
  '170': 'COP',
  '484': 'MXN',
  '600': 'PYG',
  '604': 'PEN',
  '840': 'USD',
  '858': 'UYU',
  '986': 'BRL',
};

const PIX_GUI = 'br.gov.bcb.pix';
const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;

const isTemplate = (id: number) => (id >= 26 && id <= 51) || id === 62 || id === 64 || id >= 80;

/** CRC16/CCITT-FALSE (polynomial 0x1021, initial 0xFFFF) of `text`'s UTF-8 bytes, as the four
    upper-case hex digits field 63 carries. */
export function emvCrc(text: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte << 8;
    for (let b = 0; b < 8; b++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** TLV fields of `text`, or null when it is not exactly a run of them. */
export function parseTlv(text: string): EmvField[] | null {
  const fields: EmvField[] = [];
  let at = 0;
  while (at < text.length) {
    const head = text.slice(at, at + 4);
    if (!/^\d{4}$/.test(head)) return null;
    const id = head.slice(0, 2);
    const length = Number(head.slice(2));
    const value = text.slice(at + 4, at + 4 + length);
    if (length === 0 || value.length !== length) return null;
    fields.push({ id, value });
    at += 4 + length;
  }
  return fields;
}

const field = (fields: EmvField[], id: string) => fields.find((f) => f.id === id) ?? null;

/** Reads a merchant-presented EMV QR payload and checks its CRC. */
export function parseEmv(input: string): EmvResult {
  const payload = typeof input === 'string' ? input.trim() : '';
  if (!payload.startsWith('000201')) return { ok: false, error: 'not-emv' };
  if (payload.length > EMV_MAX_LENGTH) return { ok: false, error: 'malformed' };
  const fields = parseTlv(payload);
  if (!fields || fields.length < 3) return { ok: false, error: 'malformed' };
  const last = fields[fields.length - 1];
  if (last.id !== '63' || last.value.length !== 4) return { ok: false, error: 'malformed' };
  if (fields.slice(0, -1).some((f) => f.id === '63')) return { ok: false, error: 'malformed' };
  if (emvCrc(payload.slice(0, -4)) !== last.value.toUpperCase())
    return { ok: false, error: 'bad-crc' };

  for (const f of fields) {
    if (!isTemplate(Number(f.id))) continue;
    const children = parseTlv(f.value);
    if (children) f.children = children;
  }

  const accounts: string[] = [];
  let pixKey: string | null = null;
  let pixUrl: string | null = null;
  for (const f of fields) {
    const id = Number(f.id);
    if (id < 26 || id > 51 || !f.children) continue;
    const gui = field(f.children, '00')?.value ?? null;
    if (!gui) continue;
    accounts.push(gui);
    if (gui.toLowerCase() === PIX_GUI) {
      pixKey = field(f.children, '01')?.value ?? null;
      pixUrl = field(f.children, '25')?.value ?? null;
    }
  }

  const amount = field(fields, '54')?.value ?? null;
  if (amount !== null && !AMOUNT_RE.test(amount)) return { ok: false, error: 'malformed' };
  const initiation = field(fields, '01')?.value ?? null;
  if (initiation !== null && initiation !== '11' && initiation !== '12') {
    return { ok: false, error: 'malformed' };
  }
  const currencyNumeric = field(fields, '53')?.value ?? null;
  const countryCode = field(fields, '58')?.value?.toUpperCase() ?? null;
  const currency = currencyNumeric ? (CURRENCIES[currencyNumeric] ?? null) : null;
  const additional = field(fields, '62')?.children ?? [];

  const standard: MerchantQrStandard =
    pixKey !== null || pixUrl !== null
      ? 'pix'
      : countryCode === 'AR' && currencyNumeric === '032'
        ? 'ar-interoperable'
        : 'emv';

  return {
    ok: true,
    qr: {
      standard,
      payload,
      dynamic: initiation === '12',
      merchantName: field(fields, '59')?.value.trim() || null,
      merchantCity: field(fields, '60')?.value.trim() || null,
      countryCode,
      currency,
      currencyNumeric,
      amount,
      pixKey,
      pixUrl,
      reference: field(additional, '05')?.value ?? null,
      accounts,
      fields,
    },
  };
}
