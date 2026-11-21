/* The mock merchant's transfer receipt: a one-page PDF written by hand (Helvetica, WinAnsi, so
   Spanish accents print), returned as base64 the way the API carries attachments. The first line
   is the title, in bold. */

const escape = (s: string) =>
  s
    .replace(/[\\()]/g, (c) => `\\${c}`)
    // WinAnsi covers Latin-1; anything else (the bullet of a masked account) becomes an asterisk.
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '*');

export function receiptPdf(lines: string[]): string {
  const [title, ...rest] = lines;
  const body = [
    'BT',
    '/F2 18 Tf 56 770 Td',
    `(${escape(title ?? '')}) Tj`,
    '/F1 12 Tf 0 -34 Td',
    ...rest.flatMap((l) => [`(${escape(l)}) Tj`, '0 -20 Td']),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character is Latin-1 here, one byte each: btoa takes the string as those bytes.
  return btoa(pdf);
}
