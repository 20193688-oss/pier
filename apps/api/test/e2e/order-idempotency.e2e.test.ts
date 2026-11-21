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
 * A retried order action (pressed twice, or sent again after it went
 * through) is not an error: a buyer act the order already shows answers the
 * order (200) and sends nothing; a transaction the order already shows is a
 * 409 `already_done` naming its status, with nothing to sign. Both are
 * decided from the stored order before the chain is reached, so the fake
 * chain (which answers 503 to anything) shows which requests went further.
 */

let h: Harness;
let wallet: Keypair;
let session = '';
let org: Awaited<ReturnType<typeof organization>>;

async function insertOrder(input: {
  kind: 'BUY' | 'SELL';
  status: string;
  /** The app's wallet (an app order), or an organization's order with `organizationId`. */
  endUserAddress?: string;
  organizationId?: string;
  seller?: string;
}): Promise<string> {
  const id = randomUUID();
  const merchant = randomWallet().publicKey();
  const merchantOrg = await organization(h);
  const person = input.endUserAddress ?? input.seller ?? randomWallet().publicKey();
  const buy = input.kind === 'BUY';
  await h.prisma.p2pOrder.create({
    data: {
      id,
      ref: createHash('sha256').update(id).digest('hex'),
      organizationId: input.organizationId ?? APP_ORGANIZATION_ID,
      tier: 'test',
      kind: input.kind,
      endUserAddress: input.endUserAddress ?? null,
      network: 'testnet',
      contract: FAKE_CONTRACT,
      token: FAKE_CONTRACT,
      tokenSymbol: 'USDC',
      tokenDecimals: 7,
      merchantOrganizationId: merchantOrg.id,
      merchantAddress: merchant,
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
      sellerAddress: buy ? merchant : person,
      buyerAddress: buy ? person : merchant,
      bond: buy ? '0' : '10000000',
      acceptWindow: 300,
      paymentWindow: 1800,
      settleWindow: 21600,
      openerAddress: buy ? merchant : person,
      // Unique per contract: a fresh one per order (no chain reads it here).
      onchainId: input.status === 'pending' ? null : String(BigInt(`0x${id.slice(0, 8)}`) + 1n),
      status: input.status,
    },
  });
  return id;
}

const appOrder = (kind: 'BUY' | 'SELL', status: string) =>
  insertOrder({ kind, status, endUserAddress: wallet.publicKey() });

const act = (id: string, action: 'paid' | 'cancel' | 'dispute') =>
  h.http().post(`/v1/app/orders/${id}/${action}`).set(bearer(session)).send({});

const appTransaction = (id: string, action: string) =>
  h.http().post(`/v1/app/orders/${id}/transactions`).set(bearer(session)).send({ action });

beforeAll(async () => {
  h = await bootApp();
  wallet = randomWallet();
  session = await signIn(h, wallet);
  org = await organization(h);
});

afterAll(async () => {
  await h?.close();
});

describe('a buyer act the order already shows', () => {
  it('answers the order as it is (200), for each act', async () => {
    const cases = [
      ['paid', 'paid'],
      ['paid', 'completed'],
      ['cancel', 'cancelled'],
      ['cancel', 'expired'],
      ['dispute', 'disputed'],
      ['dispute', 'resolved'],
    ] as const;
    for (const [action, status] of cases) {
      const id = await appOrder('BUY', status);
      const res = await act(id, action);
      expect(res.status, `${action} on ${status}`).toBe(200);
      expect(res.body.id).toBe(id);
      expect(res.body.status).toBe(status);
    }
  });

  it('is the same on the organization’s route', async () => {
    const id = await insertOrder({ kind: 'BUY', status: 'paid', organizationId: org.id });
    const res = await h
      .http()
      .post(`/v1/p2p/orders/${id}/paid`)
      .set(bearer(org.testKey))
      .send({ reference: 'TRX-1' })
      .expect(200);
    expect(res.body.status).toBe('paid');
  });

  it('still refuses an act the order is past without showing it (400)', async () => {
    const cancelled = await appOrder('BUY', 'cancelled');
    const r1 = await act(cancelled, 'paid').expect(400);
    expect(r1.body.error.code).toBe('invalid_state');
    const unpaid = await appOrder('BUY', 'awaiting_payment');
    const r2 = await act(unpaid, 'dispute').expect(400);
    expect(r2.body.error.code).toBe('invalid_state');
    const completed = await appOrder('BUY', 'completed');
    const r3 = await act(completed, 'cancel').expect(400);
    expect(r3.body.error.code).toBe('invalid_state');
  });

  it('goes to the chain the first time', async () => {
    const id = await appOrder('BUY', 'awaiting_payment');
    // The checks passed: the fake chain has no live deployment to send on.
    await act(id, 'paid').expect(503);
  });
});

describe('a transaction the order already shows', () => {
  it('is a 409 already_done naming the status, on the app', async () => {
    const cases = [
      ['release', 'completed'],
      ['cancel', 'cancelled'],
      ['dispute', 'disputed'],
      ['dispute', 'resolved'],
      ['open', 'awaiting_acceptance'],
      ['open', 'completed'],
    ] as const;
    for (const [action, status] of cases) {
      const id = await appOrder('SELL', status);
      const res = await appTransaction(id, action);
      expect(res.status, `${action} on ${status}`).toBe(409);
      expect(res.body.error.code).toBe('already_done');
      expect(res.body.error.details).toEqual([`status: ${status}`]);
    }
  });

  it('still refuses a wrong-state action that is not done (400), and builds the right one', async () => {
    const offered = await appOrder('SELL', 'awaiting_acceptance');
    const r1 = await appTransaction(offered, 'release').expect(400);
    expect(r1.body.error.code).toBe('invalid_state');
    const cancelled = await appOrder('SELL', 'cancelled');
    const r2 = await appTransaction(cancelled, 'release').expect(400);
    expect(r2.body.error.code).toBe('invalid_state');
    const failed = await appOrder('SELL', 'failed');
    const r3 = await appTransaction(failed, 'open').expect(400);
    expect(r3.body.error.code).toBe('invalid_state');
    const paid = await appOrder('SELL', 'paid');
    await appTransaction(paid, 'release').expect(503);
  });

  it('is a 409 already_done on the organization’s build too', async () => {
    const seller = randomWallet().publicKey();
    const build = (orderId: string, action: string) =>
      h
        .http()
        .post('/v1/p2p/transactions')
        .set(bearer(org.testKey))
        .send({ network: 'testnet', from: seller, action, args: { orderId } });

    const completed = await insertOrder({
      kind: 'SELL',
      status: 'completed',
      organizationId: org.id,
      seller,
    });
    const r1 = await build(completed, 'release').expect(409);
    expect(r1.body.error.code).toBe('already_done');
    expect(r1.body.error.details).toEqual(['status: completed']);

    const paid = await insertOrder({
      kind: 'SELL',
      status: 'paid',
      organizationId: org.id,
      seller,
    });
    const r2 = await build(paid, 'markPaid').expect(409);
    expect(r2.body.error.details).toEqual(['status: paid']);

    const offered = await insertOrder({
      kind: 'SELL',
      status: 'awaiting_acceptance',
      organizationId: org.id,
      seller,
    });
    const r3 = await build(offered, 'release').expect(400);
    expect(r3.body.error.code).toBe('invalid_state');
    // The order checks passed: only then is the chain reached.
    await build(paid, 'release').expect(503);
  });
});
