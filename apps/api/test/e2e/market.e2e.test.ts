import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { approveCalldata, p2pCalldata } from '@/chain/market-codec';
import { devSend, devWallet, fundDevWallet } from '@/dev/index';
import { orderRef } from '@/p2p/domain/order-ref';
import { ExpiryJob } from '@/p2p/expiry.job';
import {
  bearer,
  bootApp,
  organization,
  quietMarket,
  randomWallet,
  registerWallet,
  setupMerchant,
  signIn,
  tickChain,
  wallet,
  type Harness,
  type Merchant,
} from '@test/e2e/harness';

/**
 * The market's other paths against the real chain: a charge paid on the
 * keyless checkout, the public app's wallet-bound orders, a front-run of an
 * order's ref, a dispute resolved by the arbiter, an expired order, and a
 * payout batch. This file's merchant quotes the best prices, so every match
 * here is its own.
 */

const U = 1_000_000n;
let h: Harness;
let merchant: Merchant;
let business: Awaited<ReturnType<typeof organization>>;
let businessWallet = randomWallet();
let businessAccountId = '';

const PRICES = { sell: '1200', buy: '1230' };

beforeAll(async () => {
  const infra = inject('infra');
  h = await bootApp();
  await quietMarket(h);
  merchant = await setupMerchant(h, 'Norte Cambios', PRICES);
  // setupMerchant made its own wallet; the dev tools must sign for it.
  await h.close();
  h = await bootApp({ DEV_WALLET_KEYS: merchant.wallet.privateKey });
  businessWallet = randomWallet();
  await fundDevWallet(infra.rpcUrl, infra.deployment.token, businessWallet.address, 50_000n * U);
  business = await organization(h, businessWallet);
  businessAccountId = (await registerWallet(h, business.testKey, businessWallet, 'Kiosco Sur')).id;
});

afterAll(async () => {
  await h?.close();
});

async function status(key: string, id: string): Promise<string> {
  return (await h.http().get(`/v1/p2p/orders/${id}`).set(bearer(key)).expect(200)).body.status;
}

describe('a charge paid on the hosted checkout, without a key', () => {
  it('opens one order per payer, shows it only to its payer token, and completes the charge', async () => {
    const charge = await h
      .http()
      .post('/v1/p2p/charges')
      .set(bearer(business.testKey))
      .send({
        network: 'local',
        token: 'tUSD',
        currency: 'ARS',
        fiatAmount: '24000',
        recipient: businessAccountId,
        payeeName: 'Kiosco Sur',
        description: 'Order 42',
      })
      .expect(201);
    const read = await h.http().get(`/v1/p2p-checkout/charges/${charge.body.id}`).expect(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toMatchObject({
      fiatAmount: '24000.00',
      status: 'open',
      rails: ['ar_bank_transfer'],
    });

    const payer = { name: 'María Pérez', document: '27234567891', email: 'maria@example.com' };
    const created = await h
      .http()
      .post(`/v1/p2p-checkout/charges/${charge.body.id}/orders`)
      .send({ rail: 'ar_bank_transfer', payer })
      .expect(201);
    expect(created.body.payerToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created.body.paymentDetails.holderName).toBe('Norte Cambios SRL');
    const id = created.body.id as string;

    // One live order per charge (single use): a second payer waits.
    await h
      .http()
      .post(`/v1/p2p-checkout/charges/${charge.body.id}/orders`)
      .send({ rail: 'ar_bank_transfer', payer })
      .expect(409);
    // The order is read with its payer token only.
    await h.http().get(`/v1/p2p-checkout/orders/${id}`).expect(404);
    await h.http().get(`/v1/p2p-checkout/orders/${id}`).set('x-payer-token', 'wrong').expect(404);
    await tickChain(h);
    const mine = await h
      .http()
      .get(`/v1/p2p-checkout/orders/${id}`)
      .set('x-payer-token', created.body.payerToken)
      .expect(200);
    expect(mine.body.status).toBe('awaiting_payment');

    await h
      .http()
      .post(`/v1/p2p-checkout/orders/${id}/paid`)
      .set('x-payer-token', created.body.payerToken)
      .send({ reference: 'TRX-9' })
      .expect(200);
    await tickChain(h);
    await h.http().post(`/v1/dev/orders/${id}/simulate-transfer`).expect(200);
    await tickChain(h);
    expect(await status(business.testKey, id)).toBe('completed');
    const after = await h
      .http()
      .get(`/v1/p2p/charges/${charge.body.id}`)
      .set(bearer(business.testKey))
      .expect(200);
    expect(after.body).toMatchObject({ status: 'paid', paidCount: 1 });
    const events = await h.prisma.webhookEvent.findMany({
      where: { organizationId: business.id, type: 'P2P_CHARGE_SUCCEEDED' },
    });
    expect(events).toHaveLength(1);
  });
});

describe('the public app', () => {
  it('binds orders to the signed-in wallet', async () => {
    const person = randomWallet();
    const session = await signIn(h, person);
    const quote = await h
      .http()
      .post('/v1/app/quotes')
      .set(bearer(session))
      .send({
        side: 'BUY',
        network: 'local',
        token: 'tUSD',
        currency: 'ARS',
        rail: 'ar_bank_transfer',
        fiatAmount: '12000',
      })
      .expect(201);
    // Another wallet cannot use this quote.
    const stranger = await signIn(h, randomWallet());
    await h
      .http()
      .post('/v1/app/orders')
      .set(bearer(stranger))
      .send({ quoteId: quote.body.id, payer: { name: 'Juan Pérez', document: '20123456786' } })
      .expect(404);
    const order = await h
      .http()
      .post('/v1/app/orders')
      .set(bearer(session))
      .send({ quoteId: quote.body.id, payer: { name: 'Juan Pérez', document: '20123456786' } })
      .expect(201);
    expect(order.body.buyerAddress).toBe(person.address);
    const list = await h.http().get('/v1/app/orders').set(bearer(session)).expect(200);
    expect(list.body.data.map((o: { id: string }) => o.id)).toEqual([order.body.id]);
    await h.http().get(`/v1/app/orders/${order.body.id}`).set(bearer(stranger)).expect(404);
    // Not an organization's order either.
    await h.http().get(`/v1/p2p/orders/${order.body.id}`).set(bearer(business.testKey)).expect(404);
    await tickChain(h);
    await h.http().post(`/v1/app/orders/${order.body.id}/cancel`).set(bearer(session)).expect(200);
    await tickChain(h);
    const read = await h
      .http()
      .get(`/v1/app/orders/${order.body.id}`)
      .set(bearer(session))
      .expect(200);
    expect(read.body.status).toBe('cancelled');
  });
});

describe('a front-run of an order’s ref', () => {
  it('is ignored: only the expected opener with the expected terms opens our order', async () => {
    const infra = inject('infra');
    const seller = randomWallet();
    const attacker = randomWallet();
    await fundDevWallet(infra.rpcUrl, infra.deployment.token, seller.address, 1_000n * U);
    await fundDevWallet(infra.rpcUrl, infra.deployment.token, attacker.address, 1_000n * U);
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
        fiatAmount: '12300',
      })
      .expect(201);
    const order = await h
      .http()
      .post('/v1/p2p/orders')
      .set(bearer(business.testKey))
      .send({
        quoteId: quote.body.id,
        seller: seller.address,
        beneficiary: {
          holderName: 'Ana López',
          document: '27234567891',
          details: { alias: 'ana.lopez', cuit: '20123456786' },
        },
      })
      .expect(201);
    // The attacker opens its own order carrying OUR ref (to the same merchant).
    const amount = BigInt(order.body.tokenAmount);
    await devSend(infra.rpcUrl, attacker.privateKey, {
      to: infra.deployment.token,
      data: approveCalldata(infra.deployment.market, amount),
    });
    await devSend(infra.rpcUrl, attacker.privateKey, {
      to: infra.deployment.market,
      data: p2pCalldata.openWithDeposit({
        ref: orderRef(order.body.id),
        seller: attacker.address,
        buyer: order.body.buyerAddress,
        token: infra.deployment.token,
        amount,
        bond: BigInt(order.body.bond),
        acceptWindow: 300,
        paymentWindow: 1800,
        settleWindow: 21_600,
        integrator: '0x0000000000000000000000000000000000000000',
        integratorFeeBps: 0,
      }),
    });
    await tickChain(h);
    expect(await status(business.testKey, order.body.id)).toBe('pending');
    // The real seller signs: now it opens.
    for (const tx of order.body.transactions) await devSend(infra.rpcUrl, seller.privateKey, tx);
    await tickChain(h);
    expect(await status(business.testKey, order.body.id)).toBe('awaiting_acceptance');
  });
});

describe('a dispute', () => {
  it('reaches the arbiter, whose own wallet signs the resolution the API builds', async () => {
    const infra = inject('infra');
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
        fiatAmount: '18000',
      })
      .expect(201);
    const order = await h
      .http()
      .post('/v1/p2p/orders')
      .set(bearer(business.testKey))
      .send({
        quoteId: quote.body.id,
        recipient: randomWallet().address,
        payer: { name: 'Juan Pérez', document: '20123456786' },
      })
      .expect(201);
    const id = order.body.id as string;
    await tickChain(h);
    await h
      .http()
      .post(`/v1/p2p/orders/${id}/paid`)
      .set(bearer(business.testKey))
      .send({})
      .expect(200);
    await tickChain(h);
    await h.http().post(`/v1/p2p/orders/${id}/dispute`).set(bearer(business.testKey)).expect(200);
    await tickChain(h);
    expect(await status(business.testKey, id)).toBe('disputed');

    const admin = await signIn(h, wallet('owner'));
    const disputes = await h.http().get('/v1/admin/p2p/disputes').set(bearer(admin)).expect(200);
    expect(disputes.body.data.map((o: { id: string }) => o.id)).toContain(id);
    const full = await h.http().get(`/v1/admin/p2p/orders/${id}`).set(bearer(admin)).expect(200);
    expect(full.body.payer).toMatchObject({ name: 'Juan Pérez' });
    const resolution = await h
      .http()
      .post(`/v1/admin/p2p/orders/${id}/resolution`)
      .set(bearer(admin))
      .send({ toBuyer: order.body.tokenAmount })
      .expect(200);
    const arbiter = devWallet('arbiter');
    expect(resolution.body.arbiter).toBe(privateKeyToAccount(arbiter.privateKey).address);
    await devSend(infra.rpcUrl, arbiter.privateKey, resolution.body.transaction);
    await tickChain(h);
    expect(await status(business.testKey, id)).toBe('resolved');
    const account = await h.prisma.p2pAccount.findUniqueOrThrow({
      where: { id: merchant.accountId },
    });
    expect(account.disputesLost).toBe(1);
    expect(await h.prisma.auditLog.count({ where: { resourceId: id } })).toBe(2);
  });
});

describe('a payout batch', () => {
  it('opens from the business balance, the merchant pays, the business releases', async () => {
    const infra = inject('infra');
    for (const [action, args] of [
      ['approve', { token: 'tUSD', amount: (5_000n * U).toString() }],
      ['deposit', { token: 'tUSD', amount: (5_000n * U).toString() }],
      ['setMatcher', { maxPerOrder: (1_000n * U).toString(), autoSettle: false }],
    ] as const) {
      const tx = await h
        .http()
        .post('/v1/p2p/transactions')
        .set(bearer(business.testKey))
        .send({ network: 'local', from: businessAccountId, action, args })
        .expect(200);
      await devSend(infra.rpcUrl, businessWallet.privateKey, tx.body);
    }
    const batch = await h
      .http()
      .post('/v1/p2p/payouts')
      .set(bearer(business.testKey))
      .send({
        network: 'local',
        token: 'tUSD',
        accountId: businessAccountId,
        items: [
          {
            currency: 'ARS',
            fiatAmount: '61500',
            rail: 'ar_bank_transfer',
            externalReference: 'salary-1',
            beneficiary: {
              holderName: 'Luis Díaz',
              document: '20123456786',
              details: { alias: 'luis.diaz', cuit: '20123456786' },
            },
          },
        ],
      })
      .expect(201);
    expect(batch.body.orders).toHaveLength(1);
    const id = batch.body.orders[0].id as string;
    await tickChain(h);
    expect(await status(business.testKey, id)).toBe('awaiting_acceptance');
    await h.http().post(`/v1/dev/orders/${id}/simulate-transfer`).expect(200);
    await tickChain(h);
    expect(await status(business.testKey, id)).toBe('paid');
    const release = await h
      .http()
      .post('/v1/p2p/transactions')
      .set(bearer(business.testKey))
      .send({ network: 'local', from: businessAccountId, action: 'release', args: { orderId: id } })
      .expect(200);
    await devSend(infra.rpcUrl, businessWallet.privateKey, release.body);
    await tickChain(h);
    expect(await status(business.testKey, id)).toBe('completed');
    const after = await h
      .http()
      .get(`/v1/p2p/payouts/${batch.body.id}`)
      .set(bearer(business.testKey))
      .expect(200);
    expect(after.body.status).toBe('completed');
  });
});

describe('an order nobody paid', () => {
  it('is cancelled by the expiry job after its deadline and reads expired', async () => {
    const infra = inject('infra');
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
        fiatAmount: '15000',
      })
      .expect(201);
    const order = await h
      .http()
      .post('/v1/p2p/orders')
      .set(bearer(business.testKey))
      .send({
        quoteId: quote.body.id,
        recipient: randomWallet().address,
        payer: { name: 'Juan Pérez', document: '20123456786' },
      })
      .expect(201);
    const id = order.body.id as string;
    await tickChain(h);
    expect(await status(business.testKey, id)).toBe('awaiting_payment');
    // Time passes: on the chain (31 minutes) and for the job (the stored deadline).
    const rpc = (method: string, params: unknown[]) =>
      fetch(infra.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    await rpc('evm_increaseTime', [31 * 60]);
    await rpc('evm_mine', []);
    await h.prisma.p2pOrder.update({
      where: { id },
      data: { paymentDeadline: new Date(Date.now() - 10 * 60 * 1000) },
    });
    await h.app.get(ExpiryJob).tick();
    await tickChain(h);
    expect(await status(business.testKey, id)).toBe('expired');
  });
});
