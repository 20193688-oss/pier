import { createServer, type Server } from 'node:http';
import type { Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { devSend, fundDevWallet } from '@/dev/index';
import { ExpiryJob } from '@/p2p/expiry.job';
import { IndexerJob } from '@/p2p/indexer.job';
import { MatcherFollowerJob } from '@/p2p/matcher-follower.job';
import { verifySignatureHeader } from '@/webhooks/webhook-signature';
import { WebhookSenderJob } from '@/webhooks/webhook-sender.job';
import {
  bearer,
  bootApp,
  organization,
  randomWallet,
  registerWallet,
  type Harness,
} from '@test/e2e/harness';

/**
 * The whole market against a real Postgres and a real EVM node: a merchant
 * sets itself up through the API and signs what the API builds; a purchase
 * opens through the matcher and completes when the merchant releases; a sale
 * opens with the seller's own signature and completes when it releases; the
 * indexer moves every status, and the webhooks arrive signed.
 */

const U = 1_000_000n;
let h: Harness;
let receiver: Server;
const received: { body: string; signature: string }[] = [];
let receiverUrl = '';

const merchantWallet = randomWallet();
const userWallet = randomWallet();
let merchant: Awaited<ReturnType<typeof organization>>;
let business: Awaited<ReturnType<typeof organization>>;
let merchantAccountId = '';
let webhookSecret = '';

async function tickIndexer() {
  await h.app.get(MatcherFollowerJob).tick();
  await h.app.get(IndexerJob).tick();
}

async function signAndSend(key: Hex, tx: { to: Hex; data: Hex }) {
  const infra = inject('infra');
  return devSend(infra.rpcUrl, key, tx);
}

beforeAll(async () => {
  const infra = inject('infra');
  h = await bootApp({ DEV_WALLET_KEYS: merchantWallet.privateKey });
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ body, signature: String(req.headers['pedospe-signature']) });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', () => r()));
  const address = receiver.address();
  receiverUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/hook`;

  await fundDevWallet(infra.rpcUrl, infra.deployment.token, merchantWallet.address, 200_000n * U);
  await fundDevWallet(infra.rpcUrl, infra.deployment.token, userWallet.address, 10_000n * U);

  merchant = await organization(h, merchantWallet);
  business = await organization(h);
  const account = await registerWallet(h, merchant.testKey, merchantWallet, 'Pampa Cambio');
  merchantAccountId = account.id;
  await h
    .http()
    .post('/v1/p2p/payment-methods')
    .set(bearer(merchant.testKey))
    .send({
      accountId: account.id,
      currency: 'ARS',
      rail: 'ar_bank_transfer',
      holderName: 'Pampa Cambio SRL',
      details: { cbu: '2850590940090418135201', cuit: '20123456786' },
    })
    .expect(201);
  for (const offer of [
    { side: 'SELL_TOKEN', price: '1250' },
    { side: 'BUY_TOKEN', price: '1180' },
  ]) {
    await h
      .http()
      .post('/v1/p2p/offers')
      .set(bearer(merchant.testKey))
      .send({
        accountId: account.id,
        network: 'local',
        token: 'tUSD',
        currency: 'ARS',
        rails: ['ar_bank_transfer'],
        minFiat: '1000',
        maxFiat: '5000000',
        priceTtlSeconds: 3600,
        ...offer,
      })
      .expect(201);
  }
  const build = async (action: string, args: Record<string, unknown>) =>
    (
      await h
        .http()
        .post('/v1/p2p/transactions')
        .set(bearer(merchant.testKey))
        .send({ network: 'local', from: account.id, action, args })
        .expect(200)
    ).body as { to: Hex; data: Hex };
  await signAndSend(
    merchantWallet.privateKey,
    await build('approve', { token: 'tUSD', amount: (100_000n * U).toString() }),
  );
  await signAndSend(
    merchantWallet.privateKey,
    await build('deposit', { token: 'tUSD', amount: (100_000n * U).toString() }),
  );
  await signAndSend(
    merchantWallet.privateKey,
    await build('setMatcher', { maxPerOrder: (5_000n * U).toString(), autoSettle: false }),
  );

  const endpoint = await h
    .http()
    .post('/v1/webhook-endpoints')
    .set(bearer(business.testKey))
    .send({ url: receiverUrl })
    .expect(201);
  webhookSecret = endpoint.body.secret;
});

afterAll(async () => {
  await h?.close();
  await new Promise<void>((r) => (receiver ? receiver.close(() => r()) : r()));
});

describe('the market, end to end', () => {
  it('shows the local deployment in the market overview', async () => {
    const res = await h.http().get('/v1/market?tier=test').expect(200);
    expect(res.body.available).toBe(true);
    expect(res.body.networks).toEqual([
      expect.objectContaining({
        id: 'local',
        chainId: 31337,
        tokens: [expect.objectContaining({ symbol: 'tUSD' })],
      }),
    ]);
    expect(res.body.matcher).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('shows the merchant its balance and matcher terms', async () => {
    const res = await h
      .http()
      .get(`/v1/p2p/accounts/${merchantAccountId}`)
      .set(bearer(merchant.testKey))
      .expect(200);
    expect(res.body.networks[0].balances[0].amount).toBe((100_000n * U).toString());
    expect(res.body.networks[0].matcher.maxPerOrder).toBe((5_000n * U).toString());
  });

  it('runs a purchase: quote, matcher open, paid, release, completed', async () => {
    const quote = await h
      .http()
      .post('/v1/p2p/quotes')
      .set(bearer(business.testKey))
      .send({
        side: 'BUY',
        network: 'local',
        token: 'tUSD',
        currency: 'ARS',
        rail: 'ar_bank_transfer',
        fiatAmount: '125000',
      })
      .expect(201);
    expect(quote.body).toMatchObject({
      price: '1250',
      tokenAmount: '100000000',
      merchant: { displayName: 'Pampa Cambio' },
    });
    const recipient = randomWallet().address;
    const order = await h
      .http()
      .post('/v1/p2p/orders')
      .set(bearer(business.testKey))
      .send({
        quoteId: quote.body.id,
        recipient,
        payer: { name: 'Juan Gómez', document: '20123456786' },
        externalReference: 'ext-1',
      })
      .expect(201);
    expect(order.body.status).toBe('pending');
    expect(order.body.paymentDetails).toMatchObject({
      rail: 'ar_bank_transfer',
      holderName: 'Pampa Cambio SRL',
    });
    const id = order.body.id as string;

    await tickIndexer();
    let read = await h.http().get(`/v1/p2p/orders/${id}`).set(bearer(business.testKey)).expect(200);
    expect(read.body.status).toBe('awaiting_payment');
    expect(read.body.onchainId).toBeTruthy();

    await h
      .http()
      .post(`/v1/p2p/orders/${id}/paid`)
      .set(bearer(business.testKey))
      .send({ reference: 'TRX-1' })
      .expect(200);
    await tickIndexer();
    read = await h.http().get(`/v1/p2p/orders/${id}`).set(bearer(business.testKey)).expect(200);
    expect(read.body.status).toBe('paid');

    // The merchant's bot matches the bank transfer and signs the release it is given.
    const matches = await h
      .http()
      .post('/v1/p2p/merchant/transfer-matches')
      .set(bearer(merchant.testKey))
      .send({
        currency: 'ARS',
        amount: '125000',
        payerName: 'GOMEZ JUAN',
        payerDocument: '12345678',
      })
      .expect(200);
    expect(matches.body.data[0]).toMatchObject({
      order: { id },
      matchedOn: ['amount', 'name', 'document'],
    });
    expect(matches.body.data[0].order.payer).toEqual({
      name: 'Juan Gómez',
      document: '20123456786',
    });
    await signAndSend(merchantWallet.privateKey, matches.body.data[0].transaction);
    await tickIndexer();
    read = await h.http().get(`/v1/p2p/orders/${id}`).set(bearer(business.testKey)).expect(200);
    expect(read.body.status).toBe('completed');
    expect(read.body.settlement.toBuyer).toBe((100_000_000n - 500_000n).toString());
    expect(read.body.paymentDetails).toBeNull();

    // Every status reached the business's endpoint, signed.
    await h.app.get(WebhookSenderJob).tick();
    const types = received.map((r) => JSON.parse(r.body).type);
    expect(types).toEqual(['P2P_ORDER_CREATED', 'P2P_ORDER_PAID', 'P2P_ORDER_COMPLETED']);
    for (const r of received)
      expect(verifySignatureHeader(r.signature, r.body, webhookSecret)).toBe(true);
    const completed = JSON.parse(received[2].body);
    expect(completed.data).toMatchObject({ id, role: 'client', externalReference: 'ext-1' });
    expect(JSON.stringify(completed)).not.toContain('Juan');
  });

  it('runs a sale: the seller signs approve + openWithDeposit, the merchant pays, the seller releases', async () => {
    const quote = await h
      .http()
      .post('/v1/p2p/quotes')
      .set(bearer(business.testKey))
      .send({
        side: 'SELL',
        network: 'local',
        token: 'tUSD',
        currency: 'ARS',
        rail: 'ar_bank_transfer',
        fiatAmount: '59000',
      })
      .expect(201);
    expect(quote.body.bond).not.toBe('0');
    const order = await h
      .http()
      .post('/v1/p2p/orders')
      .set(bearer(business.testKey))
      .send({
        quoteId: quote.body.id,
        seller: userWallet.address,
        beneficiary: {
          holderName: 'Ana López',
          document: '27234567891',
          details: { alias: 'ana.lopez.mp', cuit: '20123456786' },
        },
      })
      .expect(201);
    expect(order.body.transactions).toHaveLength(2);
    for (const tx of order.body.transactions) await signAndSend(userWallet.privateKey, tx);
    await tickIndexer();
    const id = order.body.id as string;
    let read = await h.http().get(`/v1/p2p/orders/${id}`).set(bearer(business.testKey)).expect(200);
    expect(read.body.status).toBe('awaiting_acceptance');

    // The merchant sees where to pay while the order is live.
    const seen = await h
      .http()
      .get(`/v1/p2p/merchant/orders/${id}`)
      .set(bearer(merchant.testKey))
      .expect(200);
    expect(seen.body.beneficiary).toMatchObject({ holderName: 'Ana López' });

    // The dev tool plays the merchant's bot: accept + mark paid.
    const simulated = await h.http().post(`/v1/dev/orders/${id}/simulate-transfer`).expect(200);
    expect(simulated.body.steps.map((s: { action: string }) => s.action)).toEqual([
      'accept',
      'markPaid',
    ]);
    await tickIndexer();
    read = await h.http().get(`/v1/p2p/orders/${id}`).set(bearer(business.testKey)).expect(200);
    expect(read.body.status).toBe('paid');

    const release = await h
      .http()
      .post('/v1/p2p/transactions')
      .set(bearer(business.testKey))
      .send({
        network: 'local',
        from: userWallet.address,
        action: 'release',
        args: { orderId: id },
      })
      .expect(200);
    await signAndSend(userWallet.privateKey, release.body);
    await tickIndexer();
    read = await h.http().get(`/v1/p2p/orders/${id}`).set(bearer(business.testKey)).expect(200);
    expect(read.body.status).toBe('completed');
  });

  it('keeps the expiry job harmless when nothing is overdue', async () => {
    expect(await h.app.get(ExpiryJob).tick()).toBe(true);
  });
});
