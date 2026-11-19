import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueWebhooks } from '@/webhooks/webhook-outbox';
import { MAX_ATTEMPTS, WebhookSenderJob } from '@/webhooks/webhook-sender.job';
import { bearer, bootApp, organization, type Harness } from '@test/e2e/harness';

/**
 * The webhook outbox and its sender: an event is delivered once to every
 * subscribed endpoint of its organization and tier, a failing receiver is
 * retried later (never in a hot loop), and a delivery gives up after the last
 * attempt.
 */

let h: Harness;
let server: Server;
let answer = 500;
let hits = 0;
let url = '';

beforeAll(async () => {
  h = await bootApp();
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits += 1;
      res.writeHead(answer).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/hook`;
});

afterAll(async () => {
  await h?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

describe('webhook deliveries', () => {
  it('retries a failing receiver with backoff, then delivers', async () => {
    const org = await organization(h);
    const endpoint = await h
      .http()
      .post('/v1/webhook-endpoints')
      .set(bearer(org.testKey))
      .send({ url, events: ['P2P_ORDER_PAID'] })
      .expect(201);
    // Another type and another tier never reach it.
    await h.prisma.$transaction((tx) =>
      enqueueWebhooks(tx, [
        { organizationId: org.id, tier: 'test', type: 'P2P_ORDER_PAID', data: { id: 'o1' } },
        { organizationId: org.id, tier: 'test', type: 'P2P_ORDER_COMPLETED', data: { id: 'o1' } },
        { organizationId: org.id, tier: 'live', type: 'P2P_ORDER_PAID', data: { id: 'o2' } },
      ]),
    );
    const sender = h.app.get(WebhookSenderJob);
    answer = 500;
    await sender.tick();
    expect(hits).toBe(1);
    let deliveries = await h
      .http()
      .get(`/v1/webhook-endpoints/${endpoint.body.id}/deliveries`)
      .set(bearer(org.testKey))
      .expect(200);
    expect(deliveries.body.total).toBe(1);
    const first = deliveries.body.data[0];
    expect(first).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastStatus: 500,
      type: 'P2P_ORDER_PAID',
    });
    expect(new Date(first.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + 20_000);

    // Not due yet: nothing is sent.
    await sender.tick();
    expect(hits).toBe(1);

    // Due again, and the receiver recovered.
    await h.prisma.webhookDelivery.updateMany({
      where: { id: first.id },
      data: { nextAttemptAt: new Date() },
    });
    answer = 200;
    await sender.tick();
    deliveries = await h
      .http()
      .get(`/v1/webhook-endpoints/${endpoint.body.id}/deliveries`)
      .set(bearer(org.testKey))
      .expect(200);
    expect(deliveries.body.data[0]).toMatchObject({
      status: 'delivered',
      attempts: 2,
      lastStatus: 200,
    });
    expect(deliveries.body.data[0].payload).toMatchObject({
      type: 'P2P_ORDER_PAID',
      data: { id: 'o1' },
    });
  });

  it('gives up after the last attempt', async () => {
    const org = await organization(h);
    const endpoint = await h
      .http()
      .post('/v1/webhook-endpoints')
      .set(bearer(org.testKey))
      .send({ url })
      .expect(201);
    await h.prisma.$transaction((tx) =>
      enqueueWebhooks(tx, [
        { organizationId: org.id, tier: 'test', type: 'P2P_ORDER_FAILED', data: {} },
      ]),
    );
    await h.prisma.webhookDelivery.updateMany({
      where: { endpointId: endpoint.body.id },
      data: { attempts: MAX_ATTEMPTS - 1 },
    });
    answer = 503;
    await h.app.get(WebhookSenderJob).tick();
    const row = await h.prisma.webhookDelivery.findFirstOrThrow({
      where: { endpointId: endpoint.body.id },
    });
    expect(row).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, lastStatus: 503 });
  });
});
