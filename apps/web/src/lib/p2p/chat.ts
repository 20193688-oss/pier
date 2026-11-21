/* chat.ts: an order's chat between the person who opened it (`creator`) and the merchant who
   takes it (`merchant`), and the transfer receipts they send in it. The API keeps the messages
   (`/v1/p2p/orders/:id/messages` for the creator, `/v1/p2p/merchant/orders/:id/messages` for the
   merchant); a message with an attachment is a receipt. Attachments are images or PDFs of at
   most 2 MB, sent and read as base64 inside JSON, so the browser never loads a file from the
   API's own origin.

   Pure: tests/unit/chat.test.ts. */

export type ChatSide = 'creator' | 'merchant';

export interface ChatAttachmentMeta {
  name: string;
  contentType: string;
  size: number;
}

export interface ChatMessage {
  id: string;
  orderId: string;
  from: ChatSide;
  kind: 'text' | 'receipt';
  text: string | null;
  attachment: ChatAttachmentMeta | null;
  createdAt: string;
}

/** An attachment as the API sends it back: its bytes in base64. */
export interface ChatAttachment extends ChatAttachmentMeta {
  data: string;
}

/** What an order view says about its chat (the unread badge reads it). */
export interface ChatSummary {
  count: number;
  lastAt: string | null;
  lastFrom: ChatSide | null;
}

export const CHAT_TEXT_MAX = 1000;
export const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
export const ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isSide = (v: unknown): v is ChatSide => v === 'creator' || v === 'merchant';
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function readMeta(raw: unknown): ChatAttachmentMeta | null {
  if (!isObj(raw)) return null;
  const { name, contentType, size } = raw;
  if (typeof name !== 'string' || !name || typeof contentType !== 'string') return null;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
  return { name: name.slice(0, 120), contentType, size };
}

/** One message from the API, or null when its shape is wrong (it is then left out). */
export function readMessage(raw: unknown): ChatMessage | null {
  if (!isObj(raw)) return null;
  const { id, orderId, from, text, createdAt } = raw;
  if (typeof id !== 'string' || !id || typeof orderId !== 'string') return null;
  if (!isSide(from) || !isIso(createdAt)) return null;
  const attachment = raw.attachment == null ? null : readMeta(raw.attachment);
  if (raw.attachment != null && !attachment) return null;
  const body = typeof text === 'string' && text.trim() ? text : null;
  if (!body && !attachment) return null;
  return {
    id,
    orderId,
    from,
    kind: attachment ? 'receipt' : 'text',
    text: body,
    attachment,
    createdAt,
  };
}

/** An attachment answer from the API, or null when its shape is wrong. */
export function readAttachment(raw: unknown): ChatAttachment | null {
  const meta = readMeta(raw);
  if (!meta || !isObj(raw) || typeof raw.data !== 'string' || !raw.data) return null;
  return { ...meta, data: raw.data };
}

/** An order view's chat summary, or an empty one. */
export function readSummary(raw: unknown): ChatSummary {
  if (!isObj(raw)) return { count: 0, lastAt: null, lastFrom: null };
  const count = typeof raw.count === 'number' && raw.count >= 0 ? Math.floor(raw.count) : 0;
  return {
    count,
    lastAt: isIso(raw.lastAt) ? raw.lastAt : null,
    lastFrom: isSide(raw.lastFrom) ? raw.lastFrom : null,
  };
}

/** Why a file cannot be attached: not an image or a PDF, empty, or over 2 MB. */
export function checkAttachment(file: { type: string; size: number }): 'type' | 'size' | null {
  if (!ATTACHMENT_TYPES.includes(file.type)) return 'type';
  if (file.size <= 0 || file.size > ATTACHMENT_MAX_BYTES) return 'size';
  return null;
}

/** The content type a file's first bytes say it is (the API checks the same signatures). */
export function sniffType(bytes: Uint8Array): string | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => bytes[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  return null;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(data: string): Uint8Array {
  const s = atob(data);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Messages from the other side newer than `seenAt` (the last one this browser showed). */
export function unseen(messages: readonly ChatMessage[], me: ChatSide, seenAt: string | null) {
  const seen = seenAt ? Date.parse(seenAt) : 0;
  return messages.filter((m) => m.from !== me && Date.parse(m.createdAt) > seen).length;
}

/** Whether an order's summary carries a message from the other side newer than `seenAt`. */
export function hasUnseen(summary: ChatSummary, me: ChatSide, seenAt: string | null): boolean {
  if (!summary.lastAt || !summary.lastFrom || summary.lastFrom === me) return false;
  return !seenAt || Date.parse(summary.lastAt) > Date.parse(seenAt);
}

/** A file size as a person reads it: "820 KB", "1.4 MB". */
export function fileSize(lang: string, bytes: number): string {
  const nf = (n: number, d: number) =>
    new Intl.NumberFormat(lang, { maximumFractionDigits: d }).format(n);
  if (bytes < 1024 * 1024) return `${nf(Math.max(1, Math.round(bytes / 1024)), 0)} KB`;
  return `${nf(bytes / (1024 * 1024), 1)} MB`;
}
