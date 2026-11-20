import {
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import type { P2pMarketEvent } from '@/chain/market-codec';
import { tokenOf } from '@/chain/networks';
import { TxBuilder } from '@/chain/tx-builder.service';
import { orderRef } from '@/p2p/domain/order-ref';
import { checkSubmission } from '@/p2p/domain/submit-policy';
import { missedEvents, openedMismatch } from '@/p2p/indexer.job';
import type { P2pOrderRow } from '@/p2p/views';

const SELLER = Keypair.random().publicKey();
const BUYER = Keypair.random().publicKey();
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 7));
const ID = '0b6c9a3e-2f1d-4c5b-8a7e-6d5c4b3a2f10';
const AT = 1_800_000_000;

const ROW = {
  id: ID,
  kind: 'SELL',
  openerAddress: SELLER,
  sellerAddress: SELLER,
  buyerAddress: BUYER,
  token: TOKEN,
  tokenAmount: '1000000000',
  bond: '100000000',
  acceptWindow: 300,
  paymentWindow: 1800,
  settleWindow: 21_600,
  integratorAddress: null,
  integratorFeeBps: 0,
  protocolFeeBps: 50,
} as unknown as P2pOrderRow;

const opened = (overrides: Partial<Extract<P2pMarketEvent, { name: 'order_opened' }>> = {}) =>
  ({
    name: 'order_opened',
    id: 7n,
    seller: SELLER,
    buyer: BUYER,
    token: TOKEN,
    opener: SELLER,
    integrator: null,
    amount: 1_000_000_000n,
    bond: 100_000_000n,
    status: 'Offered',
    fromBalance: false,
    viaMatcher: false,
    feeBps: 50,
    integratorFeeBps: 0,
    acceptDeadline: AT + 300,
    paymentDeadline: 0,
    paymentWindow: 1800,
    settleWindow: 21_600,
    refId: orderRef(ID),
    ...overrides,
  }) as Extract<P2pMarketEvent, { name: 'order_opened' }>;

describe('the indexer’s check of order_opened', () => {
  it('accepts exactly our sale’s terms', () => {
    expect(openedMismatch(ROW, opened(), AT)).toEqual([]);
  });

  it('names every field that differs', () => {
    expect(openedMismatch(ROW, opened({ opener: BUYER }), AT)).toEqual(['opener']);
    expect(openedMismatch(ROW, opened({ amount: 1n, settleWindow: 0 }), AT)).toEqual([
      'amount',
      'settle_window',
    ]);
    expect(openedMismatch(ROW, opened({ integrator: BUYER, integratorFeeBps: 100 }), AT)).toEqual([
      'integrator_fee_bps',
      'integrator',
    ]);
    expect(openedMismatch(ROW, opened({ fromBalance: true, viaMatcher: true }), AT)).toEqual([
      'via_matcher',
      'from_balance',
    ]);
    expect(openedMismatch(ROW, opened({ feeBps: 0 }), AT)).toEqual(['fee_bps']);
    expect(openedMismatch(ROW, opened({ acceptDeadline: AT + 3600 }), AT)).toEqual([
      'accept_deadline',
    ]);
  });

  it('expects a purchase from the matcher, on its balance', () => {
    const buy = {
      ...ROW,
      kind: 'BUY',
      bond: '0',
      acceptWindow: 0,
      settleWindow: 0,
      openerAddress: BUYER,
    };
    expect(
      openedMismatch(
        buy as P2pOrderRow,
        opened({ opener: BUYER, bond: 0n, fromBalance: true, viaMatcher: true, settleWindow: 0 }),
        AT,
      ),
    ).toEqual([]);
  });

  it('rebuilds the moves a stopped indexer missed from the chain status', () => {
    const chain = { ...opened(), status: 'Paid', paidAt: AT } as never;
    expect(missedEvents(7n, chain, '995').map((e) => e.name)).toEqual([
      'order_accepted',
      'order_paid',
    ]);
    expect(missedEvents(7n, { ...opened(), status: 'Offered', paidAt: 0 } as never, '1')).toEqual(
      [],
    );
  });
});

describe('the sponsored activation the API builds', () => {
  const sponsor = Keypair.random();
  const usdc = tokenOf(
    'testnet',
    'USDC',
    'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  );
  const n = { network: 'testnet', passphrase: Networks.TESTNET, name: 'Stellar Testnet' } as never;
  const builder = (exists: boolean, trustline: boolean) =>
    new TxBuilder(
      {
        account: async (_n: unknown, a: string) =>
          exists || a === sponsor.publicKey()
            ? { address: a, sequence: 41n, balance: 0n, thresholds: {}, signers: [], subentries: 0 }
            : null,
        loadAccount: async (_n: unknown, a: string) =>
          ({
            accountId: () => a,
            sequenceNumber: () => '41',
            incrementSequenceNumber() {},
          }) as never,
        trustlines: async () => [trustline ? { balance: 0n, limit: 1n, authorized: true } : null],
      } as never,
      { sponsorAddress: () => sponsor.publicKey(), sponsorKey: () => sponsor } as never,
    );
  const policy = (xdr: string) =>
    checkSubmission(TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction, {
      contract: TOKEN,
      tokens: [usdc],
      sponsor: sponsor.publicKey(),
      now: Math.floor(Date.now() / 1000),
      maxFeeStroops: 2_000_000,
      maxTtlSeconds: 360,
    });

  it('creates a missing account from the sponsor, with 0 XLM, and passes the policy', async () => {
    const user = Keypair.random().publicKey();
    const built = await builder(false, false).activation(n, user, usdc);
    if (!built) throw new Error('nothing built');
    const tx = TransactionBuilder.fromXDR(built.xdr, Networks.TESTNET) as Transaction;
    expect(tx.source).toBe(sponsor.publicKey());
    expect(tx.operations.map((o) => o.type)).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'changeTrust',
      'endSponsoringFutureReserves',
    ]);
    expect(policy(built.xdr)).toMatchObject({ ok: true, kind: 'activation', account: user });
  });

  it('opens only the trustline of an existing account, from the account, and nothing when it has one', async () => {
    const user = Keypair.random().publicKey();
    const built = await builder(true, false).activation(n, user, usdc);
    if (!built) throw new Error('nothing built');
    const tx = TransactionBuilder.fromXDR(built.xdr, Networks.TESTNET) as Transaction;
    expect(tx.source).toBe(user);
    expect(tx.operations).toHaveLength(3);
    expect(policy(built.xdr)).toMatchObject({ ok: true, kind: 'activation' });
    expect(await builder(true, true).activation(n, user, usdc)).toBeNull();
  });
});
