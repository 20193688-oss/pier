/* chat.test.ts: an order's chat as the web reads it (src/lib/p2p/chat.ts): messages and
   attachments read defensively, the files a receipt may be (by type, size and first bytes),
   base64 both ways, the unread marks, and the mock merchant's PDF receipt. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  ATTACHMENT_MAX_BYTES,
  checkAttachment,
  fileSize,
  fromBase64,
  hasUnseen,
  readAttachment,
  readMessage,
  readSummary,
  sniffType,
  toBase64,
  unseen,
  type ChatMessage,
} from '@/lib/p2p/chat';
import { sideOf } from '@/lib/api/chat';
import { receiptPdf } from '@/lib/mock/receipt';

const msg = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  orderId: 'o1',
  from: 'merchant',
  kind: 'text',
  text: 'Hola',
  attachment: null,
  createdAt: '2026-11-20T12:00:00.000Z',
  ...over,
});

test('a message is read only in its shape; an attachment makes it a receipt', () => {
  assert.deepEqual(readMessage(msg()), { ...msg(), kind: 'text' });
  const r = readMessage(
    msg({ text: null, kind: 'text', attachment: { name: 'c.pdf', contentType: 'application/pdf', size: 900 } }),
  );
  assert.equal(r?.kind, 'receipt');
  assert.equal(r?.text, null);
  for (const bad of [
    null,
    msg({ from: 'arbiter' }),
    msg({ createdAt: 'yesterday' }),
    msg({ id: '' }),
    msg({ text: '   ' }),
    msg({ attachment: { name: 'x' } }),
  ])
    assert.equal(readMessage(bad), null);
});

test('an attachment answer needs its bytes; a summary defaults to empty', () => {
  assert.equal(readAttachment({ name: 'a.png', contentType: 'image/png', size: 3 }), null);
  assert.deepEqual(readAttachment({ name: 'a.png', contentType: 'image/png', size: 3, data: 'AAAA' }), {
    name: 'a.png',
    contentType: 'image/png',
    size: 3,
    data: 'AAAA',
  });
  assert.deepEqual(readSummary(undefined), { count: 0, lastAt: null, lastFrom: null });
  assert.deepEqual(readSummary({ count: 2, lastAt: '2026-11-20T12:00:00Z', lastFrom: 'merchant' }), {
    count: 2,
    lastAt: '2026-11-20T12:00:00Z',
    lastFrom: 'merchant',
  });
});

test('a receipt is an image or a PDF of 2 MB at most, and its bytes must say so', () => {
  assert.equal(checkAttachment({ type: 'application/pdf', size: 1000 }), null);
  assert.equal(checkAttachment({ type: 'image/svg+xml', size: 1000 }), 'type');
  assert.equal(checkAttachment({ type: 'text/html', size: 10 }), 'type');
  assert.equal(checkAttachment({ type: 'image/png', size: ATTACHMENT_MAX_BYTES + 1 }), 'size');
  assert.equal(checkAttachment({ type: 'image/png', size: 0 }), 'size');
  assert.equal(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d])), 'image/png');
  assert.equal(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(
    sniffType(new TextEncoder().encode('RIFF\x00\x00\x00\x00WEBPVP8 ')),
    'image/webp',
  );
  assert.equal(sniffType(new TextEncoder().encode('%PDF-1.4')), 'application/pdf');
  assert.equal(sniffType(new TextEncoder().encode('<svg xmlns=')), null);
});

test('base64 both ways, also for large files', () => {
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  assert.equal(toBase64(new TextEncoder().encode('hola')), 'aG9sYQ==');
});

test('unread: only the other side, only newer than what this browser showed', () => {
  const list = [
    readMessage(msg({ id: 'a', from: 'creator', createdAt: '2026-11-20T12:00:00Z' })),
    readMessage(msg({ id: 'b', from: 'merchant', createdAt: '2026-11-20T12:01:00Z' })),
    readMessage(msg({ id: 'c', from: 'merchant', createdAt: '2026-11-20T12:02:00Z' })),
  ] as ChatMessage[];
  assert.equal(unseen(list, 'creator', null), 2);
  assert.equal(unseen(list, 'creator', '2026-11-20T12:01:00Z'), 1);
  assert.equal(unseen(list, 'merchant', null), 1);
  const summary = { count: 3, lastAt: '2026-11-20T12:02:00Z', lastFrom: 'merchant' as const };
  assert.ok(hasUnseen(summary, 'creator', null));
  assert.ok(!hasUnseen(summary, 'creator', '2026-11-20T12:02:00Z'));
  assert.ok(!hasUnseen(summary, 'merchant', null));
  assert.ok(!hasUnseen({ count: 0, lastAt: null, lastFrom: null }, 'creator', null));
  assert.equal(sideOf('app'), 'creator');
  assert.equal(sideOf('org'), 'creator');
  assert.equal(sideOf('merchant'), 'merchant');
});

test('file sizes read as a person reads them', () => {
  assert.equal(fileSize('en', 800), '1 KB');
  assert.equal(fileSize('en', 300 * 1024), '300 KB');
  assert.equal(fileSize('es', 1.5 * 1024 * 1024), '1,5 MB');
});

test("the mock merchant's receipt is a PDF the chat accepts, with a valid cross-reference table", () => {
  const data = receiptPdf(['Comprobante de transferencia', 'Monto: 474,00 BOB', 'Cuenta ••••6789']);
  const bytes = fromBase64(data);
  assert.equal(sniffType(bytes), 'application/pdf');
  const pdf = String.fromCharCode(...bytes);
  const xref = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
  assert.ok(pdf.slice(xref).startsWith('xref'));
  // Every object sits at the offset the table gives.
  const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 6);
  offsets.forEach((o, i) => assert.ok(pdf.slice(o).startsWith(`${i + 1} 0 obj`), String(i)));
  assert.ok(pdf.includes('(Cuenta ****6789) Tj'));
});
