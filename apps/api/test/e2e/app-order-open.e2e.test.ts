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
 * `POST /v1/app/orders/:id/transactions { action: 'open' }`: a pending sale's
 * (or QR payment's) `open_with_deposit`, simulated when the seller is about to
 * sign. One simulated at creation can go stale (another order takes the order
 * id its footprint names), so the app asks for a fresh one. Only the seller's
 * own pending sale gets one; the fake chain answers 503 once the checks pass.
 */

let h: Harness;
let wallet: Keypair;
let session = '';

async function insertOrder(input: {
  endUserAddress: string;
  kind?: 'SELL' | 'BUY' | 'QR_PAY';
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  const merchant = randomWallet().publicKey();
  const merchantOrg = await organization(h);
  const buy = input.kind === 'BUY';
  await h.prisma.p2pOrder.create({
    data: {
      id,
      ref: createHash('sha256').update(id).digest('hex'),
      organizationId: APP_ORGANIZATION_ID,
      tier: 'test',
      kind: input.kind ?? 'SELL',
      endUserAddress: input.endUserAddress,
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
      sellerAddress: buy ? merchant : input.endUserAddress,
      buyerAddress: buy ? input.endUserAddress : merchant,
      bond: '10000000',
      acceptWindow: 300,
      paymentWindow: 1800,
      settleWindow: 21600,
      openerAddress: buy ? merchant : input.endUserAddress,
      status: input.status ?? 'pending',
    },
  });
  return id;
}

const open = (id: string, token = session) =>
  h.http().post(`/v1/app/orders/${id}/transactions`).set(bearer(token)).send({ action: 'open' });

beforeAll(async () => {
  h = await bootApp();
  wallet = randomWallet();
  session = await signIn(h, wallet);
});

afterAll(async () => {
  await h?.close();
});

describe("a pending sale's open transaction, built when the seller signs", () => {
  it('goes to the chain for the seller’s own pending sale or QR payment', async () => {
    for (const kind of ['SELL', 'QR_PAY'] as const) {
      const id = await insertOrder({ endUserAddress: wallet.publicKey(), kind });
      const res = await open(id);
      // The checks passed: the fake chain has no live deployment to simulate on.
      expect(res.status, kind).toBe(503);
    }
  });

  it('is already done once the sale is open, and refused for a purchase', async () => {
    const opened = await insertOrder({
      endUserAddress: wallet.publicKey(),
      status: 'awaiting_acceptance',
    });
    const r1 = await open(opened).expect(409);
    expect(r1.body.error.code).toBe('already_done');
    expect(r1.body.error.details).toEqual(['status: awaiting_acceptance']);
    const buy = await insertOrder({ endUserAddress: wallet.publicKey(), kind: 'BUY' });
    const r2 = await open(buy).expect(400);
    expect(r2.body.error.code).toBe('invalid_state');
  });

  it('is another wallet’s order: not found', async () => {
    const other = randomWallet();
    const id = await insertOrder({ endUserAddress: other.publicKey() });
    await open(id).expect(404);
  });

  it('takes only the listed actions', async () => {
    const id = await insertOrder({ endUserAddress: wallet.publicKey() });
    await h
      .http()
      .post(`/v1/app/orders/${id}/transactions`)
      .set(bearer(session))
      .send({ action: 'openWithDeposit' })
      .expect(400);
  });
});
