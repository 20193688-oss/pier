/**
 * The simulated merchant's transfer receipt: a one-page PDF written by hand
 * (no dependency), the way a bank's "comprobante" reads, sent to the person on
 * the order's chat when the bot pays them. Its text is end-user content, in
 * Spanish.
 *
 * The PDF uses the standard Helvetica fonts with WinAnsiEncoding, so Latin-1
 * (Spanish accents included) and the bullet of a masked account print; any
 * other character becomes `?`. Pure: `test/receipt.test.ts`.
 */
import { createHash } from 'node:crypto';
import type { MerchantOrder, NewOrderMessage } from '@/types';

/** A character as WinAnsi: Latin-1 as is, the bullet (U+2022) at 0x95, anything else `?`. */
function winAnsi(c: string): string {
  const code = c.charCodeAt(0);
  if (c === '•') return '\x95';
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) ? c : '?';
}

/** A PDF string literal's content: WinAnsi, with `\`, `(` and `)` escaped. */
function pdfText(text: string): string {
  return [...text]
    .map((c) => (c === '\\' || c === '(' || c === ')' ? `\\${c}` : winAnsi(c)))
    .join('');
}

/** A one-page A4 PDF of `lines`: the first is the title, in bold. Answers its bytes. */
export function receiptPdf(lines: readonly string[]): Buffer {
  const [title = '', ...rest] = lines;
  const content = [
    'BT',
    '/F2 18 Tf 56 770 Td',
    `(${pdfText(title)}) Tj`,
    '/F1 12 Tf 0 -34 Td',
    ...rest.flatMap((line) => [`(${pdfText(line)}) Tj`, '0 -20 Td']),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  // Every character is one byte (Latin-1) from here on: string offsets are byte offsets.
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** The rails' names as a Spanish-speaking person reads them on a receipt. */
const RAIL_NAMES: Readonly<Record<string, string>> = {
  bo_bank_transfer: 'Transferencia bancaria',
  ar_bank_transfer: 'Transferencia bancaria (CBU/CVU)',
  br_pix: 'PIX',
  mx_spei: 'SPEI',
  co_bank_transfer: 'Transferencia bancaria',
  pe_bank_transfer: 'Transferencia interbancaria (CCI)',
  cl_bank_transfer: 'Transferencia bancaria',
  ar_qr: 'Pago con QR interoperable',
  br_pix_qr: 'Pago con QR PIX',
  pe_qr: 'Pago con QR interoperable (Yape, Plin)',
};

/** Where each currency's people read the time. */
const TIME_ZONES: Readonly<Record<string, string>> = {
  BOB: 'America/La_Paz',
  ARS: 'America/Argentina/Buenos_Aires',
  BRL: 'America/Sao_Paulo',
  MXN: 'America/Mexico_City',
  COP: 'America/Bogota',
  PEN: 'America/Lima',
  CLP: 'America/Santiago',
};

/** The account fields a receipt masks, most telling first. */
const ACCOUNT_FIELDS = ['accountNumber', 'cbu', 'cvu', 'clabe', 'cci', 'key', 'alias'];

/** `••••1234`: the last four characters of the beneficiary's account. */
export function maskedAccount(details: Readonly<Record<string, string>>): string {
  const value = ACCOUNT_FIELDS.map((f) => details[f]).find((v) => typeof v === 'string' && v);
  if (!value) return '••••';
  return value.length <= 4 ? value : `••••${value.slice(-4)}`;
}

/** A made-up but stable operation number (ten digits) for an order. */
export function operationNumber(orderId: string): string {
  const hex = createHash('sha256').update(`operation:${orderId}`).digest('hex').slice(0, 15);
  return (BigInt(`0x${hex}`) % 10_000_000_000n).toString().padStart(10, '0');
}

/** `20/11/2026 09:15 (GMT-4)` in the currency's country. */
export function receiptTime(at: Date, currency: string): string {
  const timeZone = TIME_ZONES[currency] ?? 'UTC';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'shortOffset',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute} (${parts.timeZoneName})`;
}

/** The message that carries the receipt (end-user content). */
export const RECEIPT_MESSAGE = 'Listo, ya te transferí. Te dejo el comprobante.';
/** The receipt's title. */
export const RECEIPT_TITLE = 'Comprobante de transferencia';

/** The lines of the receipt of an order the merchant paid (`at`: when it paid). */
export function receiptLines(
  order: Pick<
    MerchantOrder,
    'id' | 'kind' | 'fiatAmount' | 'currency' | 'rail' | 'beneficiary' | 'qr'
  >,
  merchantName: string,
  at: Date,
): string[] {
  const qr = order.kind === 'QR_PAY' ? order.qr : null;
  const beneficiary = qr
    ? (qr.merchantName ?? 'Comercio del QR')
    : (order.beneficiary?.holderName ?? '-');
  const account = qr
    ? `QR ${qr.reference ? `ref. ${qr.reference}` : 'del comercio'}`
    : maskedAccount(order.beneficiary?.details ?? {});
  return [
    RECEIPT_TITLE,
    `Emisor: ${merchantName}`,
    `Fecha y hora: ${receiptTime(at, order.currency)}`,
    `Monto: ${order.fiatAmount} ${order.currency}`,
    `Medio: ${RAIL_NAMES[order.rail] ?? order.rail}`,
    `Beneficiario: ${beneficiary}`,
    `Cuenta: ${account}`,
    `Orden: ${order.id.slice(0, 8)}`,
    `Operación N.º ${operationNumber(order.id)}`,
  ];
}

/** The chat message that sends the receipt: its text and the PDF, in base64. */
export function receiptMessage(
  order: Parameters<typeof receiptLines>[0],
  merchantName: string,
  at: Date,
): NewOrderMessage & { text: string } {
  return {
    text: RECEIPT_MESSAGE,
    attachment: {
      name: `comprobante-${order.id.slice(0, 8)}.pdf`,
      contentType: 'application/pdf',
      data: receiptPdf(receiptLines(order, merchantName, at)).toString('base64'),
    },
  };
}
