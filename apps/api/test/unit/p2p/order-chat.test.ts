import { describe, expect, it } from 'vitest';
import {
  ORDER_CHAT_ATTACHMENT_MAX_BASE64,
  ORDER_CHAT_ATTACHMENT_MAX_BYTES,
  chatSummaryOf,
  checkOrderMessage,
  decodeBase64,
  isOrderMessagePost,
  matchesContentType,
} from '@/p2p/domain/order-chat';
import { APP_ORGANIZATION_ID } from '@/p2p/p2p-events';
import { orderMessageEvents } from '@/p2p/order-messages.service';

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from('WEBPVP8 ', 'latin1'),
]);

const file = (bytes: Buffer, contentType: string, name = 'comprobante') => ({
  attachment: { name, contentType, data: bytes.toString('base64') },
});

describe('the order chat: file types', () => {
  it('knows each type by its leading bytes', () => {
    expect(matchesContentType('application/pdf', PDF)).toBe(true);
    expect(matchesContentType('image/png', PNG)).toBe(true);
    expect(matchesContentType('image/jpeg', JPEG)).toBe(true);
    expect(matchesContentType('image/webp', WEBP)).toBe(true);
    expect(matchesContentType('application/pdf', PNG)).toBe(false);
    expect(matchesContentType('image/png', JPEG)).toBe(false);
    // RIFF of another kind (a WAV) is not a WEBP.
    const wav = Buffer.concat([WEBP.subarray(0, 8), Buffer.from('WAVEfmt ', 'latin1')]);
    expect(matchesContentType('image/webp', wav)).toBe(false);
    expect(matchesContentType('image/jpeg', Buffer.from([0xff, 0xd8]))).toBe(false);
  });

  it('decodes only standard, padded base64', () => {
    expect(decodeBase64(PDF.toString('base64'))?.equals(PDF)).toBe(true);
    expect(decodeBase64('')?.length).toBe(0);
    expect(decodeBase64('abc')).toBeNull();
    expect(decodeBase64('ab c')).toBeNull();
    expect(decodeBase64('ab\ncd==')).toBeNull();
    expect(decodeBase64('_-_-')).toBeNull();
    expect(decodeBase64('YQ==')?.toString()).toBe('a');
  });
});

describe('checkOrderMessage', () => {
  it('takes a trimmed text, a file, or both', () => {
    expect(checkOrderMessage({ text: '  Hola  ' })).toEqual({
      ok: true,
      message: { text: 'Hola', attachment: null },
    });
    const both = checkOrderMessage({ text: 'Listo', ...file(PDF, 'application/pdf') });
    expect(both).toEqual({
      ok: true,
      message: {
        text: 'Listo',
        attachment: {
          name: 'comprobante',
          contentType: 'application/pdf',
          size: PDF.length,
          data: PDF.toString('base64'),
        },
      },
    });
    for (const [bytes, type] of [
      [PNG, 'image/png'],
      [JPEG, 'image/jpeg'],
      [WEBP, 'image/webp'],
    ] as const) {
      expect(checkOrderMessage(file(bytes, type)).ok, type).toBe(true);
    }
  });

  it('wants at least one of a text or a file', () => {
    for (const body of [{}, { text: '' }, { text: '   ' }, { text: null, attachment: null }]) {
      expect(checkOrderMessage(body)).toEqual({
        ok: false,
        errors: ['send a text, an attachment or both'],
      });
    }
  });

  it('takes 1000 characters of text, not 1001 (after trimming)', () => {
    expect(checkOrderMessage({ text: 'a'.repeat(1000) }).ok).toBe(true);
    expect(checkOrderMessage({ text: ` ${'a'.repeat(1000)} ` }).ok).toBe(true);
    expect(checkOrderMessage({ text: 'a'.repeat(1001) })).toEqual({
      ok: false,
      errors: ['text must be at most 1000 characters'],
    });
    expect(checkOrderMessage({ text: 42 })).toEqual({
      ok: false,
      errors: ['text must be a string'],
    });
  });

  it('checks the file’s name, type, base64, size and leading bytes', () => {
    const errors = (body: unknown) => {
      const r = checkOrderMessage(body as { attachment?: unknown });
      return r.ok ? [] : r.errors;
    };
    expect(errors(file(PDF, 'application/pdf', ''))).toEqual([
      'attachment.name must be 1 to 120 characters',
    ]);
    expect(errors(file(PDF, 'application/pdf', 'x'.repeat(121)))).toEqual([
      'attachment.name must be 1 to 120 characters',
    ]);
    expect(errors(file(PDF, 'text/html'))).toEqual([
      'attachment.contentType must be one of image/png, image/jpeg, image/webp, application/pdf',
    ]);
    expect(errors(file(PNG, 'application/pdf'))).toEqual([
      'attachment.data is not a application/pdf file',
    ]);
    expect(
      errors({ attachment: { name: 'a', contentType: 'image/png', data: 'not base64' } }),
    ).toEqual(['attachment.data must be base64']);
    expect(errors({ attachment: { name: 'a', contentType: 'image/png', data: '' } })).toEqual([
      'attachment.data must not be empty',
    ]);
    expect(errors({ attachment: 'file' })).toEqual(['attachment must be an object']);
  });

  it('takes a file of exactly 2 MiB and refuses one byte more', () => {
    const max = Buffer.concat([PDF, Buffer.alloc(ORDER_CHAT_ATTACHMENT_MAX_BYTES - PDF.length)]);
    const ok = checkOrderMessage(file(max, 'application/pdf'));
    expect(ok.ok && ok.message.attachment?.size).toBe(ORDER_CHAT_ATTACHMENT_MAX_BYTES);
    expect(max.toString('base64').length).toBeLessThanOrEqual(ORDER_CHAT_ATTACHMENT_MAX_BASE64);
    const over = Buffer.concat([max, Buffer.alloc(1)]);
    expect(checkOrderMessage(file(over, 'application/pdf'))).toEqual({
      ok: false,
      errors: [`attachment.data must decode to at most ${ORDER_CHAT_ATTACHMENT_MAX_BYTES} bytes`],
    });
  });

  it('drops control characters from a file name, which stays a display name', () => {
    const r = checkOrderMessage(file(PDF, 'application/pdf', ' ../recibo\u0000\n.pdf '));
    expect(r.ok && r.message.attachment?.name).toBe('../recibo.pdf');
  });
});

describe('chatSummaryOf', () => {
  it('reads the order’s chat columns, and only the two sides', () => {
    const at = new Date('2026-11-20T12:00:00Z');
    expect(chatSummaryOf({ chatCount: 2, chatLastAt: at, chatLastFrom: 'merchant' })).toEqual({
      count: 2,
      lastAt: at,
      lastFrom: 'merchant',
    });
    expect(chatSummaryOf({ chatCount: 0, chatLastAt: null, chatLastFrom: null })).toEqual({
      count: 0,
      lastAt: null,
      lastFrom: null,
    });
    expect(chatSummaryOf({ chatCount: 1, chatLastAt: at, chatLastFrom: 'admin' }).lastFrom).toBe(
      null,
    );
  });
});

describe('orderMessageEvents', () => {
  const order = {
    id: 'o1',
    tier: 'test',
    organizationId: 'org_client',
    merchantOrganizationId: 'org_merchant',
  };
  const message = {
    id: 'm1',
    orderId: 'o1',
    from: 'creator',
    kind: 'receipt',
    text: 'Mi CBU es 2850590940090418135201',
    attachment: { name: 'recibo Juan Perez.pdf', contentType: 'application/pdf', size: 10 },
    createdAt: new Date('2026-11-20T12:00:00Z'),
  };

  it('tells the other side, without the text or the file’s name', () => {
    const [event, ...rest] = orderMessageEvents(order, message);
    expect(rest).toEqual([]);
    expect(event).toEqual({
      organizationId: 'org_merchant',
      tier: 'test',
      type: 'P2P_ORDER_MESSAGE',
      data: {
        orderId: 'o1',
        role: 'merchant',
        message: {
          id: 'm1',
          orderId: 'o1',
          from: 'creator',
          kind: 'receipt',
          attachment: { contentType: 'application/pdf', size: 10 },
          createdAt: message.createdAt,
        },
      },
    });
    expect(JSON.stringify(event)).not.toMatch(/CBU|Juan/);
    const reply = orderMessageEvents(order, { ...message, from: 'merchant' });
    expect(reply.map((e) => [e.organizationId, e.data.role])).toEqual([['org_client', 'client']]);
  });

  it('tells nobody for the public app’s wallet, nor an organization trading with itself', () => {
    const app = { ...order, organizationId: APP_ORGANIZATION_ID };
    expect(orderMessageEvents(app, { ...message, from: 'merchant' })).toEqual([]);
    expect(orderMessageEvents(app, message)).toHaveLength(1);
    const self = { ...order, merchantOrganizationId: 'org_client' };
    expect(orderMessageEvents(self, message)).toEqual([]);
  });
});

describe('isOrderMessagePost', () => {
  it('is a POST to the messages of one order, on each of the three route families', () => {
    for (const url of [
      '/v1/app/orders/abc/messages',
      '/v1/p2p/orders/abc/messages',
      '/v1/p2p/merchant/orders/abc/messages/',
      '/v1/p2p/orders/abc/messages?x=1',
    ]) {
      expect(isOrderMessagePost({ method: 'POST', url }), url).toBe(true);
    }
    for (const [method, url] of [
      ['GET', '/v1/p2p/orders/abc/messages'],
      ['POST', '/v1/p2p/orders/abc/paid'],
      ['POST', '/v1/p2p/orders/abc/messages/m1/attachment'],
      ['POST', '/v1/p2p/offers'],
      ['POST', '/v1/p2p/orders/a/b/messages'],
      ['POST', '/x/v1/p2p/orders/abc/messages'],
    ]) {
      expect(isOrderMessagePost({ method, url }), `${method} ${url}`).toBe(false);
    }
  });
});
