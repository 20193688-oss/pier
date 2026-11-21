import { describe, expect, it } from 'vitest';
import { getOrderMessageAttachment, listOrderMessages, sendOrderMessage } from '@/chat';
import { createPierClient, PierError } from '@/client';
import type { OrderMessage } from '@/types';

const ORDER = '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10';
const MESSAGE: OrderMessage = {
  id: '6c1d0f3a-2b4e-4f6a-9c8d-7e6f5a4b3c2d',
  orderId: ORDER,
  from: 'merchant',
  kind: 'receipt',
  text: 'Listo, ya te transferí.',
  attachment: { name: 'comprobante.pdf', contentType: 'application/pdf', size: 9 },
  createdAt: '2026-11-20T12:05:00.000Z',
};

/** A client whose fetch records each request and answers from `answer`. */
function recording(answer: (request: Request) => Response) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const client = createPierClient({
    baseUrl: 'https://api.pier.test',
    apiKey: 'pk_test_3kQ9x7Lm2Vb8',
    fetch: async (request) => {
      const body = request.method === 'POST' ? await request.clone().json() : undefined;
      calls.push({ method: request.method, path: new URL(request.url).pathname, body });
      return answer(request);
    },
  });
  return { client, calls };
}

describe('the order chat client', () => {
  it('reads, writes and fetches files on each side’s routes', async () => {
    const { client, calls } = recording((request) =>
      request.url.endsWith('/attachment')
        ? Response.json({ ...MESSAGE.attachment, data: 'JVBERi0xLjQK' })
        : request.method === 'POST'
          ? Response.json(MESSAGE, { status: 201 })
          : Response.json({ data: [MESSAGE] }),
    );
    expect(await listOrderMessages(client, 'creator', ORDER)).toEqual([MESSAGE]);
    expect(await listOrderMessages(client, 'merchant', ORDER)).toEqual([MESSAGE]);
    expect(await listOrderMessages(client, 'app', ORDER)).toEqual([MESSAGE]);
    const body = {
      text: 'Listo',
      attachment: { name: 'c.pdf', contentType: 'application/pdf' as const, data: 'JVBERi0=' },
    };
    expect(await sendOrderMessage(client, 'merchant', ORDER, body)).toEqual(MESSAGE);
    expect(await getOrderMessageAttachment(client, 'creator', ORDER, MESSAGE.id)).toMatchObject({
      contentType: 'application/pdf',
      data: 'JVBERi0xLjQK',
    });
    expect(calls).toEqual([
      { method: 'GET', path: `/v1/p2p/orders/${ORDER}/messages`, body: undefined },
      { method: 'GET', path: `/v1/p2p/merchant/orders/${ORDER}/messages`, body: undefined },
      { method: 'GET', path: `/v1/app/orders/${ORDER}/messages`, body: undefined },
      { method: 'POST', path: `/v1/p2p/merchant/orders/${ORDER}/messages`, body },
      {
        method: 'GET',
        path: `/v1/p2p/orders/${ORDER}/messages/${MESSAGE.id}/attachment`,
        body: undefined,
      },
    ]);
  });

  it('throws the API’s error, e.g. a message without a file', async () => {
    const { client } = recording(() =>
      Response.json(
        { error: { code: 'not_found', message: 'Message has no attachment on this order' } },
        { status: 404 },
      ),
    );
    await expect(getOrderMessageAttachment(client, 'merchant', ORDER, MESSAGE.id)).rejects.toThrow(
      PierError,
    );
  });
});
