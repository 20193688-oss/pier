/**
 * An order's chat: the messages its two sides exchange (`creator`, who opened
 * the order; `merchant`, who takes it), and the transfer receipts they attach.
 * Pure: the service checks a message here before it seals and stores it.
 *
 * An attachment travels as base64 inside JSON (images and PDFs only), so it is
 * decoded strictly, measured after decoding, and its leading bytes must be
 * those of the type it claims: a file is never stored as something it is not.
 */

export const ORDER_CHAT_SIDES = ['creator', 'merchant'] as const;
export type OrderChatSide = (typeof ORDER_CHAT_SIDES)[number];

/** Characters of a message's text, after trimming. */
export const ORDER_CHAT_TEXT_MAX = 1000;
/** Characters of an attachment's name (shown, never used as a path). */
export const ORDER_CHAT_NAME_MAX = 120;
/** Decoded bytes of an attachment: 2 MiB. */
export const ORDER_CHAT_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
/** The base64 length of the largest attachment. */
export const ORDER_CHAT_ATTACHMENT_MAX_BASE64 = Math.ceil(ORDER_CHAT_ATTACHMENT_MAX_BYTES / 3) * 4;
/** Messages a list answers: the latest ones, oldest first. */
export const ORDER_CHAT_LIST_MAX = 200;
/** Messages one caller may send per minute. */
export const ORDER_CHAT_SEND_PER_MINUTE = 30;
/**
 * The JSON body limit of the routes that send a message: the largest
 * attachment in base64 plus its name and the text, with room to spare. Every
 * other route keeps the app's 256 kB.
 */
export const ORDER_CHAT_BODY_LIMIT = '3mb';

/** `POST …/orders/{id}/messages` on the app's, the client's and the merchant's routes. */
const ORDER_MESSAGE_POST = /^\/v1\/(?:app|p2p|p2p\/merchant)\/orders\/[^/?#]+\/messages\/?$/;

/**
 * Whether a request sends an order message: the only body allowed above the
 * app's JSON limit (it may carry a 2 MiB receipt in base64).
 */
export function isOrderMessagePost(req: { method?: string; url?: string }): boolean {
  return req.method === 'POST' && ORDER_MESSAGE_POST.test((req.url ?? '').split('?')[0]);
}

export const ORDER_CHAT_ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
] as const;
export type OrderChatAttachmentType = (typeof ORDER_CHAT_ATTACHMENT_TYPES)[number];

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  bytes.length >= at + prefix.length && prefix.every((b, i) => bytes[at + i] === b);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** Whether a file's leading bytes are those of `contentType` (its magic number). */
export function matchesContentType(contentType: OrderChatAttachmentType, bytes: Uint8Array) {
  switch (contentType) {
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]);
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/webp':
      return startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8);
    case 'application/pdf':
      return startsWith(bytes, ascii('%PDF-'));
  }
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Standard base64 (padded, no whitespace) as bytes; null for anything else. */
export function decodeBase64(data: string): Buffer | null {
  if (!BASE64.test(data)) return null;
  return Buffer.from(data, 'base64');
}

/** A message ready to store: trimmed text, and the attachment checked and decoded. */
export interface CheckedOrderMessage {
  text: string | null;
  attachment: {
    name: string;
    contentType: OrderChatAttachmentType;
    size: number;
    /** The bytes, base64 (as sent, checked). */
    data: string;
  } | null;
}

export type OrderMessageCheck =
  { ok: true; message: CheckedOrderMessage } | { ok: false; errors: string[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Without control characters (C0, DEL, C1): they never belong in a file name shown to people. */
function printable(value: string): string {
  return [...value]
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code >= 0x20 && (code < 0x7f || code > 0x9f);
    })
    .join('');
}

/**
 * Checks a message: at least one of `text` (trimmed, 1 to 1000 characters)
 * and `attachment` (a name of 1 to 120 characters, one of the four types,
 * base64 of 1 byte to 2 MiB whose leading bytes match the type). One message
 * per problem.
 */
export function checkOrderMessage(input: { text?: unknown; attachment?: unknown }) {
  const errors: string[] = [];
  let text: string | null = null;
  if (input.text !== undefined && input.text !== null) {
    if (typeof input.text !== 'string') {
      errors.push('text must be a string');
    } else {
      const trimmed = input.text.trim();
      if (trimmed.length > ORDER_CHAT_TEXT_MAX) {
        errors.push(`text must be at most ${ORDER_CHAT_TEXT_MAX} characters`);
      } else if (trimmed) {
        text = trimmed;
      }
    }
  }
  let attachment: CheckedOrderMessage['attachment'] = null;
  if (input.attachment !== undefined && input.attachment !== null) {
    const a = input.attachment;
    if (!isObject(a)) {
      errors.push('attachment must be an object');
    } else {
      const name = typeof a.name === 'string' ? printable(a.name).trim() : '';
      if (!name || name.length > ORDER_CHAT_NAME_MAX) {
        errors.push(`attachment.name must be 1 to ${ORDER_CHAT_NAME_MAX} characters`);
      }
      const contentType = ORDER_CHAT_ATTACHMENT_TYPES.find((t) => t === a.contentType);
      if (!contentType) {
        errors.push(
          `attachment.contentType must be one of ${ORDER_CHAT_ATTACHMENT_TYPES.join(', ')}`,
        );
      }
      const bytes =
        typeof a.data === 'string' && a.data.length <= ORDER_CHAT_ATTACHMENT_MAX_BASE64
          ? decodeBase64(a.data)
          : null;
      if (
        typeof a.data !== 'string' ||
        (a.data.length <= ORDER_CHAT_ATTACHMENT_MAX_BASE64 && !bytes)
      ) {
        errors.push('attachment.data must be base64');
      } else if (!bytes || bytes.length > ORDER_CHAT_ATTACHMENT_MAX_BYTES) {
        errors.push(
          `attachment.data must decode to at most ${ORDER_CHAT_ATTACHMENT_MAX_BYTES} bytes`,
        );
      } else if (bytes.length === 0) {
        errors.push('attachment.data must not be empty');
      } else if (contentType && !matchesContentType(contentType, bytes)) {
        errors.push(`attachment.data is not a ${contentType} file`);
      }
      if (errors.length === 0 && contentType && bytes) {
        attachment = { name, contentType, size: bytes.length, data: a.data as string };
      }
    }
  }
  if (errors.length === 0 && !text && !attachment) {
    errors.push('send a text, an attachment or both');
  }
  return errors.length
    ? ({ ok: false, errors } as const)
    : ({ ok: true, message: { text, attachment } } as const);
}

/** What an order view says about its chat. */
export interface OrderChatSummary {
  count: number;
  lastAt: Date | null;
  lastFrom: OrderChatSide | null;
}

/** An order row's chat summary (the columns each message updates). */
export function chatSummaryOf(row: {
  chatCount: number;
  chatLastAt: Date | null;
  chatLastFrom: string | null;
}): OrderChatSummary {
  return {
    count: row.chatCount,
    lastAt: row.chatLastAt,
    lastFrom: ORDER_CHAT_SIDES.find((s) => s === row.chatLastFrom) ?? null,
  };
}
