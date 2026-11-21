import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { p2pCall } from '@/chain/market-codec';
import { nativeTokenOf } from '@/chain/networks';
import type { DevApi } from '@/dev/dev-api';
import {
  describeSync,
  offerKey,
  planMethods,
  planOffers,
  setUpCallProblem,
  syncMerchantMarket,
  type ListedOffer,
  type MerchantOffer,
  type MerchantSession,
} from '@/dev/merchant-sync';

const MARKET = StrKey.encodeContract(Buffer.alloc(32, 9));
const XLM = nativeTokenOf('testnet');
const MERCHANT = Keypair.random().publicKey();
const MATCHER = Keypair.random().publicKey();
/** TUSD's SAC as the API lists an offer in it once TUSD is no longer listed. */
const TUSD_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));

const offer = (over: Partial<MerchantOffer> = {}): MerchantOffer => ({
  side: 'SELL_TOKEN',
  token: 'USDC',
  currency: 'BOB',
  rails: ['bo_bank_transfer'],
  price: '12',
  minFiat: '12.00',
  maxFiat: '24000.00',
  priceTtlSeconds: 900,
  ...over,
});

const listed = (id: string, over: Partial<ListedOffer> = {}): ListedOffer => ({
  id,
  side: 'SELL_TOKEN',
  tokenSymbol: 'USDC',
  currency: 'BOB',
  rails: ['bo_bank_transfer'],
  minFiat: '12.00',
  maxFiat: '24000.00',
  active: true,
  ...over,
});

describe('offerKey', () => {
  it('is the side, token, currency and rails (in any order)', () => {
    expect(offerKey({ side: 'BUY_TOKEN', token: 'XLM', currency: 'ARS', rails: ['b', 'a'] })).toBe(
      offerKey({ side: 'BUY_TOKEN', token: 'XLM', currency: 'ARS', rails: ['a', 'b'] }),
    );
    expect(offerKey(offer())).not.toBe(offerKey(offer({ side: 'BUY_TOKEN' })));
    expect(offerKey(offer())).not.toBe(offerKey(offer({ token: 'XLM' })));
  });
});

describe('planOffers', () => {
  it('creates what is missing and leaves what is there', () => {
    const plan = planOffers([listed('o1')], [offer(), offer({ side: 'BUY_TOKEN' })], ['USDC']);
    expect(plan).toEqual({ create: [offer({ side: 'BUY_TOKEN' })], deactivate: [], resize: [] });
  });

  it('deactivates active offers in a token no longer traded (TUSD), never inactive ones', () => {
    const plan = planOffers(
      [
        listed('tusd-1', { tokenSymbol: TUSD_CONTRACT }),
        listed('tusd-2', { tokenSymbol: 'TUSD', side: 'BUY_TOKEN' }),
        listed('tusd-3', { tokenSymbol: TUSD_CONTRACT, active: false }),
        listed('usdc'),
      ],
      [offer()],
      ['USDC', 'XLM'],
    );
    expect(plan.deactivate).toEqual(['tusd-1', 'tusd-2']);
    expect(plan.create).toEqual([]);
  });

  it('does not create an offer again because it is inactive', () => {
    const plan = planOffers([listed('o1', { active: false })], [offer()], ['USDC']);
    expect(plan).toEqual({ create: [], deactivate: [], resize: [] });
  });

  it('resizes active offers whose bounds drifted by more than a quarter (a new maximum)', () => {
    const plan = planOffers(
      [
        listed('small', { maxFiat: '1195.00' }),
        listed('close', { side: 'BUY_TOKEN', maxFiat: '23000.00' }),
        listed('off', { tokenSymbol: 'XLM', maxFiat: '10.00', active: false }),
      ],
      [offer(), offer({ side: 'BUY_TOKEN' }), offer({ token: 'XLM' })],
      ['USDC', 'XLM'],
    );
    expect(plan.resize).toEqual([{ id: 'small', minFiat: '12.00', maxFiat: '24000.00' }]);
  });
});

describe('planMethods', () => {
  it('adds the methods a merchant lacks by currency and rail', () => {
    const bob = {
      currency: 'BOB' as const,
      rail: 'bo_bank_transfer',
      holderName: 'Andes Cambio SRL',
      details: {},
    };
    const ars = { ...bob, currency: 'ARS' as const, rail: 'ar_bank_transfer' };
    expect(planMethods([{ currency: 'ARS', rail: 'ar_bank_transfer' }], [bob, ars])).toEqual([bob]);
    expect(planMethods([{ currency: 'BOB', rail: 'bo_bank_transfer' }], [bob])).toEqual([]);
  });
});

describe('syncMerchantMarket', () => {
  it('adds the BOB method and offers, deactivates TUSD offers, through the API', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const api = {
      call: vi.fn(async (method: string, path: string, _key: string, body?: unknown) => {
        calls.push({ method, path, body });
        return {};
      }),
      all: vi.fn(async (path: string) =>
        path.startsWith('/v1/p2p/payment-methods')
          ? [{ id: 'm1', currency: 'ARS', rail: 'ar_bank_transfer', active: true }]
          : [listed('tusd', { tokenSymbol: TUSD_CONTRACT }), listed('usdc')],
      ),
    } as unknown as DevApi;
    const session = {
      api,
      apiKey: 'pk_test_x',
      accountId: 'acc 1',
      chain: { network: 'testnet' },
    } as unknown as MerchantSession;
    const bob = {
      currency: 'BOB' as const,
      rail: 'bo_bank_transfer',
      holderName: 'Andes Cambio SRL',
      details: { bank: 'Banco Unión' },
    };
    const result = await syncMerchantMarket(
      session,
      [bob, { ...bob, currency: 'ARS', rail: 'ar_bank_transfer' }],
      [offer(), offer({ token: 'XLM' })],
      ['USDC', 'XLM'],
    );
    expect(result).toEqual({
      methodsAdded: 1,
      offersCreated: 1,
      offersDeactivated: 1,
      offersResized: 0,
      activeOffers: 2,
    });
    expect(api.all).toHaveBeenCalledWith('/v1/p2p/offers?accountId=acc%201', 'pk_test_x');
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/p2p/payment-methods',
        body: {
          accountId: 'acc 1',
          currency: 'BOB',
          rail: 'bo_bank_transfer',
          holderName: 'Andes Cambio SRL',
          details: { bank: 'Banco Unión' },
          label: 'BOB account',
        },
      },
      { method: 'PATCH', path: '/v1/p2p/offers/tusd', body: { active: false } },
      {
        method: 'POST',
        path: '/v1/p2p/offers',
        body: { accountId: 'acc 1', network: 'testnet', ...offer({ token: 'XLM' }) },
      },
    ]);
    expect(describeSync(result)).toBe(
      '1 payment methods added, 1 offers published, 1 offers deactivated (tokens no longer traded)',
    );
  });

  it('says nothing when nothing changed', () => {
    expect(
      describeSync({
        methodsAdded: 0,
        offersCreated: 0,
        offersDeactivated: 0,
        offersResized: 0,
        activeOffers: 9,
      }),
    ).toBeNull();
  });
});

describe('setUpCallProblem', () => {
  const amount = 7_000n * 10_000_000n;

  function built(
    op: xdr.Operation,
    options: { source?: string; auth?: xdr.SorobanAuthorizationEntry[] } = {},
  ): { xdr: string } {
    const source = options.source ?? MERCHANT;
    let operation = op;
    if (options.auth) {
      const parsed = new TransactionBuilder(new Account(source, '1'), {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(op)
        .setTimeout(60)
        .build().operations[0];
      if (parsed.type !== 'invokeHostFunction') throw new Error('not a call');
      operation = Operation.invokeHostFunction({ func: parsed.func, auth: options.auth });
    }
    return {
      xdr: new TransactionBuilder(new Account(source, '1'), {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(operation)
        .setTimeout(300)
        .build()
        .toXDR(),
    };
  }

  const fn = (contract: string, name: string, args: xdr.ScVal[]) =>
    xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: name,
        args,
      }),
    );
  const deposit = p2pCall.deposit(MARKET, MERCHANT, XLM.contract, amount);
  const root = fn(MARKET, 'deposit', [
    nativeToScVal(MERCHANT, { type: 'address' }),
    nativeToScVal(XLM.contract, { type: 'address' }),
    nativeToScVal(amount, { type: 'i128' }),
  ]);
  const pullFn = (to: string, value: bigint) =>
    fn(XLM.contract, 'transfer', [
      nativeToScVal(MERCHANT, { type: 'address' }),
      nativeToScVal(to, { type: 'address' }),
      nativeToScVal(value, { type: 'i128' }),
    ]);
  const entry = (subs: xdr.SorobanAuthorizedFunction[]) =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: root,
        subInvocations: subs.map(
          (f) => new xdr.SorobanAuthorizedInvocation({ function: f, subInvocations: [] }),
        ),
      }),
    });
  const check = (b: { xdr: string }) =>
    setUpCallProblem(b, {
      passphrase: Networks.TESTNET,
      signer: MERCHANT,
      expected: deposit,
      pull: { token: XLM.contract, market: MARKET, amount },
    });

  it('signs exactly the expected deposit with its own token pull', () => {
    expect(check(built(deposit, { auth: [entry([pullFn(MARKET, amount)])] }))).toBeNull();
    expect(check(built(deposit))).toBeNull();
  });

  it('refuses another amount, contract, source, or a pull to someone else', () => {
    expect(check(built(p2pCall.deposit(MARKET, MERCHANT, XLM.contract, amount + 1n)))).toBe(
      'not the expected call',
    );
    const other = StrKey.encodeContract(Buffer.alloc(32, 3));
    expect(check(built(p2pCall.deposit(other, MERCHANT, XLM.contract, amount)))).toBe(
      'not the expected call',
    );
    expect(check(built(deposit, { source: Keypair.random().publicKey() }))).toMatch(/source/);
    const thief = Keypair.random().publicKey();
    expect(check(built(deposit, { auth: [entry([pullFn(thief, amount)])] }))).toBe(
      'the authorisation covers another call',
    );
  });

  it('refuses a set_matcher for another matcher, and any sub-invocation on it', () => {
    const expected = p2pCall.setMatcher(MARKET, MERCHANT, MATCHER, 5n, false);
    const problem = (b: { xdr: string }) =>
      setUpCallProblem(b, { passphrase: Networks.TESTNET, signer: MERCHANT, expected });
    expect(problem(built(expected))).toBeNull();
    const rogue = p2pCall.setMatcher(MARKET, MERCHANT, Keypair.random().publicKey(), 5n, false);
    expect(problem(built(rogue))).toBe('not the expected call');
    expect(problem(built(expected, { auth: [entry([pullFn(MARKET, 1n)])] }))).toBe(
      'the authorisation covers another call',
    );
  });

  it('refuses what is not an envelope', () => {
    expect(check({ xdr: 'not-xdr' })).toBe('not a transaction envelope');
  });
});
