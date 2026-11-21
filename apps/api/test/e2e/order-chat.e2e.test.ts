import { createHash, randomUUID } from 'node:crypto';
import type { Keypair } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ORGANIZATION_ID } from '@/p2p/p2p-events';
import {
  bearer,
  bootApp,
  FAKE_CONTRACT,
  organization,
  randomWallet,
  signIn,
  type Harness,
} from '@test/e2e/harness';

/**
 * An order's chat end to end on the HTTP app: each side reads and writes only
 * its own orders (anyone else gets the 404 of a missing order), messages are
 * checked (text, base64, size, the file's leading bytes), sealed at rest,
 * summarised on the order views, and the other side's organization gets an
 * event without the message's text or file.
 */

let h: Harness;
let client: Awaited<ReturnType<typeof organization>>;
let merchant: Awaited<ReturnType<typeof organization>>;
let outsider: Awaited<ReturnType<typeof organization>>;
let wallet: Keypair;
let walletSession = '';
let orgOrder = '';
let appOrder = '';

/** The smallest valid PDF the routes take (its leading bytes are `%PDF-`). */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n', 'latin1');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** An order row as the API stores one, straight in the database (no chain needed to chat). */
async function insertOrder(input: {
  organizationId: string;
  merchantOrganizationId: string;
  endUserAddress?: string;
}): Promise<string> {
  const id = randomUUID();
  const address = randomWallet().publicKey();
  await h.prisma.p2pOrder.create({
    data: {
      id,
      ref: createHash('sha256').update(id).digest('hex'),
      organizationId: input.organizationId,
      tier: 'test',
      kind: 'SELL',
      endUserAddress: input.endUserAddress ?? null,
      network: 'testnet',
      contract: FAKE_CONTRACT,
      token: FAKE_CONTRACT,
      tokenSymbol: 'USDC',
      tokenDecimals: 7,
      merchantOrganizationId: input.merchantOrganizationId,
      merchantAddress: address,
      merchantDisplayName: 'Andes Cambio',
      offerSnapshot: {},
      price: '11.9',
      fiatAmount: '119.00',
      currency: 'BOB',
      rail: 'bo_bank_transfer',
      tokenAmount: '100000000',
      netAmount: '99500000',
      protocolFeeBps: 50,
      integratorFeeBps: 0,
      sellerAddress: input.endUserAddress ?? address,
      buyerAddress: address,
      bond: '10000000',
      acceptWindow: 300,
      paymentWindow: 1800,
      settleWindow: 21600,
      openerAddress: input.endUserAddress ?? address,
      status: 'awaiting_payment',
    },
  });
  return id;
}

beforeAll(async () => {
  h = await bootApp();
  client = await organization(h);
  merchant = await organization(h);
  outsider = await organization(h);
  wallet = randomWallet();
  walletSession = await signIn(h, wallet);
  orgOrder = await insertOrder({
    organizationId: client.id,
    merchantOrganizationId: merchant.id,
  });
  appOrder = await insertOrder({
    organizationId: APP_ORGANIZATION_ID,
    merchantOrganizationId: merchant.id,
    endUserAddress: wallet.publicKey(),
  });
});

afterAll(async () => {
  await h?.close();
});

const clientPath = (id: string) => `/v1/p2p/orders/${id}/messages`;
const merchantPath = (id: string) => `/v1/p2p/merchant/orders/${id}/messages`;
const appPath = (id: string) => `/v1/app/orders/${id}/messages`;

describe('order chat: the two sides', () => {
  it('lets the client write, the merchant read and answer with a receipt, and the client fetch it', async () => {
    const sent = await h
      .http()
      .post(clientPath(orgOrder))
      .set(bearer(client.testKey))
      .send({ text: '  Hola, ¿ya pagaste?  ' })
      .expect(201);
    expect(sent.body).toMatchObject({
      orderId: orgOrder,
      from: 'creator',
      kind: 'text',
      text: 'Hola, ¿ya pagaste?',
      attachment: null,
    });
    const receipt = await h
      .http()
      .post(merchantPath(orgOrder))
      .set(bearer(merchant.testKey))
      .send({
        text: 'Listo, ya te transferí. Te dejo el comprobante.',
        attachment: {
          name: 'comprobante.pdf',
          contentType: 'application/pdf',
          data: PDF.toString('base64'),
        },
      })
      .expect(201);
    expect(receipt.body).toMatchObject({
      from: 'merchant',
      kind: 'receipt',
      attachment: { name: 'comprobante.pdf', contentType: 'application/pdf', size: PDF.length },
    });

    for (const [path, key] of [
      [clientPath(orgOrder), client.testKey],
      [merchantPath(orgOrder), merchant.testKey],
    ] as const) {
      const list = await h.http().get(path).set(bearer(key)).expect(200);
      expect(list.body.data.map((m: { from: string }) => m.from)).toEqual(['creator', 'merchant']);
    }
    const file = await h
      .http()
      .get(`${clientPath(orgOrder)}/${receipt.body.id}/attachment`)
      .set(bearer(client.testKey))
      .expect(200);
    expect(file.body).toEqual({
      name: 'comprobante.pdf',
      contentType: 'application/pdf',
      size: PDF.length,
      data: PDF.toString('base64'),
    });
    // A message without a file has no attachment to fetch.
    await h
      .http()
      .get(`${merchantPath(orgOrder)}/${sent.body.id}/attachment`)
      .set(bearer(merchant.testKey))
      .expect(404);
  });

  it('summarises the chat on both sides’ order views', async () => {
    const asClient = await h
      .http()
      .get(`/v1/p2p/orders/${orgOrder}`)
      .set(bearer(client.testKey))
      .expect(200);
    expect(asClient.body.chat).toMatchObject({ count: 2, lastFrom: 'merchant' });
    expect(Date.parse(asClient.body.chat.lastAt)).not.toBeNaN();
    const asMerchant = await h
      .http()
      .get(`/v1/p2p/merchant/orders/${orgOrder}`)
      .set(bearer(merchant.testKey))
      .expect(200);
    expect(asMerchant.body.chat).toEqual(asClient.body.chat);
  });

  it('lets the app’s wallet chat on its own order, and nobody else', async () => {
    await h
      .http()
      .post(appPath(appOrder))
      .set(bearer(walletSession))
      .send({ text: 'Gracias' })
      .expect(201);
    const view = await h.http().get(`/v1/app/orders/${appOrder}`).set(bearer(walletSession));
    expect(view.body.chat).toMatchObject({ count: 1, lastFrom: 'creator' });
    const list = await h.http().get(merchantPath(appOrder)).set(bearer(merchant.testKey));
    expect(list.body.data).toHaveLength(1);
    // Another wallet, and an organization's order through the app's routes: missing.
    const stranger = await signIn(h, randomWallet());
    await h.http().get(appPath(appOrder)).set(bearer(stranger)).expect(404);
    await h.http().get(appPath(orgOrder)).set(bearer(walletSession)).expect(404);
  });

  it('answers 404 to anyone who is not that side of the order', async () => {
    const cases: [string, string][] = [
      [clientPath(orgOrder), outsider.testKey],
      [merchantPath(orgOrder), outsider.testKey],
      // Each side only on its own routes.
      [clientPath(orgOrder), merchant.testKey],
      [merchantPath(orgOrder), client.testKey],
      // The right organization on its other tier.
      [clientPath(orgOrder), client.liveKey],
      [clientPath(appOrder), client.testKey],
    ];
    for (const [path, key] of cases) {
      const read = await h.http().get(path).set(bearer(key));
      expect(read.status, `${path} GET`).toBe(404);
      const write = await h.http().post(path).set(bearer(key)).send({ text: 'hola' });
      expect(write.status, `${path} POST`).toBe(404);
    }
    const list = await h.http().get(clientPath(orgOrder)).set(bearer(client.testKey));
    const receipt = list.body.data.find((m: { kind: string }) => m.kind === 'receipt');
    await h
      .http()
      .get(`${merchantPath(orgOrder)}/${receipt.id}/attachment`)
      .set(bearer(outsider.testKey))
      .expect(404);
    // A message of another order is not this order's.
    await h
      .http()
      .get(`${merchantPath(appOrder)}/${receipt.id}/attachment`)
      .set(bearer(merchant.testKey))
      .expect(404);
    await h
      .http()
      .get(`${clientPath(orgOrder)}/not-a-uuid/attachment`)
      .set(bearer(client.testKey))
      .expect(404);
  });
});

describe('order chat: what a message may be', () => {
  const post = (body: unknown) =>
    h
      .http()
      .post(clientPath(orgOrder))
      .set(bearer(client.testKey))
      .send(body as object);

  it('refuses an empty message, a long text, a bad file and a lying type (400)', async () => {
    const pdf = (data: string, contentType = 'application/pdf') => ({
      attachment: { name: 'x.pdf', contentType, data },
    });
    const refused: [unknown, string][] = [
      [{}, 'send a text, an attachment or both'],
      [{ text: '   ' }, 'send a text, an attachment or both'],
      [{ text: 'x'.repeat(1001) }, 'text must be at most 1000 characters'],
      [pdf('not base64!'), 'attachment.data must be base64'],
      [pdf(''), 'attachment.data must not be empty'],
      [pdf(PNG.toString('base64')), 'attachment.data is not a application/pdf file'],
      [pdf(PDF.toString('base64'), 'text/html'), 'attachment.contentType must be one of'],
      [
        { attachment: { name: '', contentType: 'application/pdf', data: PDF.toString('base64') } },
        'attachment.name must be 1 to 120 characters',
      ],
    ];
    for (const [body, detail] of refused) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.details.join(' | ')).toContain(detail);
    }
  });

  it('takes a 2 MiB file (a body above the usual 256 kB) and refuses one byte more', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(2 * 1024 * 1024 - PDF.length, 0x20)]);
    const ok = await post({
      attachment: { name: 'big.pdf', contentType: 'application/pdf', data: big.toString('base64') },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.attachment.size).toBe(2 * 1024 * 1024);
    const over = Buffer.concat([big, Buffer.from(' ')]);
    const res = await post({
      attachment: {
        name: 'big.pdf',
        contentType: 'application/pdf',
        data: over.toString('base64'),
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.join(' ')).toContain('at most 2097152 bytes');
    // Every other route keeps its 256 kB limit.
    const elsewhere = await h
      .http()
      .post('/v1/p2p/offers')
      .set(bearer(client.testKey))
      .send({ padding: 'x'.repeat(300 * 1024) });
    expect(elsewhere.status).toBe(413);
  });

  it('seals the text and the file at rest', async () => {
    const rows = await h.prisma.p2pOrderMessage.findMany({ where: { orderId: orgOrder } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      if (row.text) expect(row.text).toMatch(/^v1:/);
      if (row.attachmentData) {
        expect(row.attachmentData).toMatch(/^v1:/);
        expect(row.attachmentData).not.toContain(PDF.toString('base64').slice(0, 12));
      }
      if (row.attachmentName) expect(row.attachmentName).not.toContain('.pdf');
    }
  });
});

describe('order chat: the other side’s event', () => {
  it('tells the other organization, without the text or the file', async () => {
    await h
      .http()
      .post('/v1/webhook-endpoints')
      .set(bearer(merchant.testKey))
      .send({ url: 'http://127.0.0.1:9/hook', events: ['P2P_ORDER_MESSAGE'] })
      .expect(201);
    const sent = await h
      .http()
      .post(clientPath(orgOrder))
      .set(bearer(client.testKey))
      .send({ text: 'Mi CBU es 2850590940090418135201' })
      .expect(201);
    const events = await h.prisma.webhookEvent.findMany({
      where: { organizationId: merchant.id, type: 'P2P_ORDER_MESSAGE' },
    });
    const event = events.find(
      (e) => (e.payload as { data: { message: { id: string } } }).data.message.id === sent.body.id,
    );
    expect(event?.payload).toMatchObject({
      type: 'P2P_ORDER_MESSAGE',
      data: {
        orderId: orgOrder,
        role: 'merchant',
        message: { id: sent.body.id, from: 'creator', kind: 'text', attachment: null },
      },
    });
    expect(JSON.stringify(event?.payload)).not.toContain('2850590940090418135201');
    // The sender's own organization gets nothing for its message; it got the merchant's receipt.
    const own = await h.prisma.webhookEvent.findMany({
      where: { organizationId: client.id, type: 'P2P_ORDER_MESSAGE' },
    });
    const ids = own.map(
      (e) => (e.payload as { data: { message: { id: string } } }).data.message.id,
    );
    expect(ids).not.toContain(sent.body.id);
    expect(
      own.map((e) => (e.payload as { data: { message: { from: string } } }).data.message.from),
    ).toEqual(own.map(() => 'merchant'));
  });
});
