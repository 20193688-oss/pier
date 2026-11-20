/* tx-verify.test.ts: a transaction the API built is decoded from its XDR and refused unless every
   field equals what the person agreed to (src/lib/p2p/tx-verify.ts): one case per field that
   could be swapped by a compromised or buggy API, ported rule by rule from the EVM checks, plus
   the envelope rules Stellar adds (fee-bump, passphrase, source, one operation, time bounds, fee,
   authorization entries, memo, the sponsored activation). */
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  Address,
  Asset,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  FeeBumpTransaction,
  hash,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk/base';
import {
  MAX_TRUST_LIMIT,
  saleTerms,
  verifyTransaction,
  type SaleTerms,
  type TxExpectation,
  type VerifyContext,
} from '@/lib/p2p/tx-verify';
import {
  integratorBpsFor,
  MAX_INTEGRATOR_FEE_BPS,
  trustQuote,
  type AcceptedQuote,
} from '@/lib/p2p/fees';
import { normalizeQuote } from '@/lib/p2p/normalize';
import { orderRef, toHex } from '@/lib/p2p/order-ref';
import {
  activation,
  contractTransfer,
  envelope,
  invocation,
  marketCall,
  openParams,
  openWithDeposit,
  payment,
  sc,
  sourceAuth,
  transferCall,
  type OpenParamsInput,
} from '@/lib/stellar/build';
import type { P2pToken, P2pTransaction } from '@/lib/p2p/types';
import { QR_PAY_WINDOWS } from '@/lib/p2p/qr-pay';

const enc = (s: string) => new TextEncoder().encode(s);
const account = (seed: string) => Keypair.fromRawEd25519Seed(hash(enc(seed))).publicKey();
const contract = (seed: string) => StrKey.encodeContract(hash(enc(seed)));

const PASSPHRASE = 'Test SDF Network ; September 2015';
const SELLER = account('seller');
const BUYER = account('buyer');
const OTHER = account('other');
const MATCHER = account('matcher');
const BOT = account('bot');
const SPONSOR = account('sponsor');
const ISSUER = account('issuer');
const MARKET = contract('market');
const SHOP = contract('a shop contract');
const USDC: P2pToken = {
  symbol: 'USDC',
  code: 'USDC',
  issuer: ISSUER,
  contract: contract('usdc'),
  decimals: 7,
};
const TUSD: P2pToken = {
  symbol: 'TUSD',
  code: 'TUSD',
  issuer: ISSUER,
  contract: contract('tusd'),
  decimals: 7,
};
const NETWORK = {
  id: 'testnet',
  networkPassphrase: PASSPHRASE,
  contract: MARKET,
  tokens: [USDC, TUSD],
};
const NOW = 1_800_000_000;
const CTX: VerifyContext = { network: NETWORK, wallet: SELLER, now: NOW };
const ORDER_ID = '0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e';
const REF = orderRef(ORDER_ID)!;
const MARKET_RULES = {
  bondBps: 1000,
  windows: { acceptSeconds: 300, paymentSeconds: 1800, settleSeconds: 21600 },
};

const build = (
  ops: xdr.Operation[],
  over: Partial<{ source: string; maxTime: number; fee: string; memo: string | null }> = {},
): P2pTransaction =>
  envelope(
    {
      source: over.source ?? SELLER,
      sequence: '41',
      networkId: 'testnet',
      passphrase: PASSPHRASE,
      maxTime: over.maxTime ?? NOW + 300,
      fee: over.fee,
      memo: over.memo,
    },
    ops,
    'test',
  );

const ACCEPTED: AcceptedQuote = {
  amountUnits: '1000000000',
  integratorFeeUnits: '0',
  buyer: BUYER,
  integrator: null,
};
const terms = (
  accepted: Partial<AcceptedQuote> | null = {},
  order: Partial<{ amountUnits: string; buyer: string | null }> = {},
) =>
  saleTerms({
    orderId: ORDER_ID,
    seller: SELLER,
    token: 'USDC',
    accepted: accepted === null ? null : { ...ACCEPTED, ...accepted },
    order: { amountUnits: '1000000000', buyer: BUYER, ...order },
    ...MARKET_RULES,
  });
const pinned = (r: ReturnType<typeof saleTerms>): SaleTerms => {
  assert.equal(r.problem, null);
  return r.terms!;
};

/* The terms the person accepted: a 100 USDC sale to BUYER, the market's bond and windows, no
   integrator fee. */
const expectOpen: TxExpectation = { action: 'open_with_deposit', ...pinned(terms()) };

const params = (over: Partial<OpenParamsInput> = {}): OpenParamsInput => ({
  ref: REF,
  seller: SELLER,
  buyer: BUYER,
  token: USDC.contract,
  amountUnits: '1000000000',
  bondUnits: '100000000',
  acceptWindow: 300,
  paymentWindow: 1800,
  settleWindow: 21600,
  integrator: null,
  integratorFeeBps: 0,
  ...over,
});
const open = (over: Partial<OpenParamsInput> = {}) => build([openWithDeposit(MARKET, params(over))]);

describe('a sale: open_with_deposit must carry every accepted term', () => {
  test('the accepted terms pass', () => {
    assert.equal(verifyTransaction(open(), CTX, expectOpen), null);
    const t = pinned(terms());
    assert.deepEqual(
      [
        t.bondUnits,
        t.acceptWindow,
        t.paymentWindow,
        t.settleWindow,
        t.integrator,
        t.integratorFeeBps,
      ],
      ['100000000', 300, 1800, 21600, null, 0],
      "the market's bond rate and windows, no integrator",
    );
  });

  const swaps: [string, Partial<OpenParamsInput>][] = [
    ['an integrator slipped in with a fee', { integrator: OTHER, integratorFeeBps: 500 }],
    ['an integrator address with no fee', { integrator: OTHER }],
    ['a fee with no integrator', { integratorFeeBps: 1 }],
    ['a different bond', { bondUnits: '200000000' }],
    ['no bond', { bondUnits: '0' }],
    ['a longer accept window', { acceptWindow: 86400 }],
    ['a different payment window', { paymentWindow: 7200 }],
    ['a different settle window', { settleWindow: 3600 }],
    ['no settle window', { settleWindow: 0 }],
    ['another buyer than the quoted merchant', { buyer: OTHER }],
    ['another seller', { seller: OTHER }],
    ['another token', { token: TUSD.contract }],
    ['another amount', { amountUnits: '1000000001' }],
    ['another ref', { ref: toHex(hash(enc('ord_2'))) }],
  ];
  for (const [name, over] of swaps) {
    test(`refused: ${name}`, () => {
      // The authorization follows the call (as a real simulation would), so only the argument
      // differs.
      const r = verifyTransaction(open(over), CTX, expectOpen);
      assert.ok(r === 'args' || r === 'auth', `${name}: ${r}`);
      assert.notEqual(r, null);
    });
  }

  test('refused: another contract, another function', () => {
    assert.equal(
      verifyTransaction(build([openWithDeposit(contract('evil'), params())]), CTX, expectOpen),
      'target',
    );
    assert.equal(
      verifyTransaction(
        build([marketCall(MARKET, 'open', [sc.address(SELLER), openParams(params())])]),
        CTX,
        expectOpen,
      ),
      'function',
    );
  });

  test('refused: an argument of another type than the interface declares', () => {
    const p = params();
    const wrong = sc.struct({
      ref_id: sc.bytes(p.ref),
      seller: sc.address(p.seller),
      buyer: sc.address(p.buyer),
      token: sc.address(p.token),
      amount: sc.u64(p.amountUnits), // u64, not i128
      bond: sc.i128(p.bondUnits),
      accept_window: sc.u32(p.acceptWindow),
      payment_window: sc.u32(p.paymentWindow),
      settle_window: sc.u32(p.settleWindow),
      integrator: sc.none(),
      integrator_fee_bps: sc.u32(0),
    });
    assert.equal(
      verifyTransaction(build([marketCall(MARKET, 'open_with_deposit', [wrong])]), CTX, expectOpen),
      'args',
    );
  });

  test('refused: a struct with an extra field', () => {
    const p = params();
    const extra = sc.struct({
      ref_id: sc.bytes(p.ref),
      seller: sc.address(p.seller),
      buyer: sc.address(p.buyer),
      token: sc.address(p.token),
      amount: sc.i128(p.amountUnits),
      bond: sc.i128(p.bondUnits),
      accept_window: sc.u32(p.acceptWindow),
      payment_window: sc.u32(p.paymentWindow),
      settle_window: sc.u32(p.settleWindow),
      integrator: sc.none(),
      integrator_fee_bps: sc.u32(0),
      zz_extra: sc.u32(1),
    });
    assert.equal(
      verifyTransaction(build([marketCall(MARKET, 'open_with_deposit', [extra])]), CTX, expectOpen),
      'args',
    );
  });
});

describe('a sale: the token pull it authorizes', () => {
  const callArgs = [openParams(params())];
  const withAuth = (auth: xdr.SorobanAuthorizationEntry[]) =>
    build([
      Operation.invokeContractFunction({
        contract: MARKET,
        function: 'open_with_deposit',
        args: callArgs,
        auth,
      }),
    ]);
  const root = (subs: xdr.SorobanAuthorizedInvocation[]) =>
    invocation(MARKET, 'open_with_deposit', callArgs, subs);
  const pull = (over: Partial<{ token: string; from: string; to: string; amount: string }> = {}) =>
    transferCall(
      over.token ?? USDC.contract,
      over.from ?? SELLER,
      over.to ?? MARKET,
      over.amount ?? '1000000000',
    );

  test('exactly the amount, from the wallet to the market, passes', () =>
    assert.equal(verifyTransaction(withAuth([sourceAuth(root([pull()]))]), CTX, expectOpen), null));
  const refusals: [string, xdr.SorobanAuthorizationEntry[]][] = [
    ['no authorization', []],
    ['two authorization entries', [sourceAuth(root([pull()])), sourceAuth(root([pull()]))]],
    ['a pull of more than the amount', [sourceAuth(root([pull({ amount: '1000000001' })]))]],
    ['a pull to another address', [sourceAuth(root([pull({ to: OTHER })]))]],
    ['a pull from another account', [sourceAuth(root([pull({ from: OTHER })]))]],
    ['a pull of another token', [sourceAuth(root([pull({ token: TUSD.contract })]))]],
    ['a second sub-invocation', [sourceAuth(root([pull(), pull({ to: OTHER, amount: '1' })]))]],
    ['no pull at all', [sourceAuth(root([]))]],
    [
      'a sub-invocation of another function',
      [
        sourceAuth(
          root([
            invocation(USDC.contract, 'approve', [
              sc.address(SELLER),
              sc.address(MARKET),
              sc.i128('1000000000'),
              sc.u32(999999),
            ]),
          ]),
        ),
      ],
    ],
    [
      'a pull that calls something else in turn',
      [
        sourceAuth(
          root([
            invocation(USDC.contract, 'transfer', [
              sc.address(SELLER),
              sc.address(MARKET),
              sc.i128('1000000000'),
            ], [pull({ to: OTHER })]),
          ]),
        ),
      ],
    ],
    [
      'a root that is another call than the operation',
      [sourceAuth(invocation(MARKET, 'withdraw', [sc.address(SELLER)], [pull()]))],
    ],
  ];
  for (const [name, auth] of refusals)
    test(`refused: ${name}`, () =>
      assert.equal(verifyTransaction(withAuth(auth), CTX, expectOpen), 'auth'));

  test('refused: credentials of another address than the source account', () => {
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(SELLER).toScAddress(),
          nonce: 1n,
          signatureExpirationLedger: 100,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: root([pull()]),
    });
    assert.equal(verifyTransaction(withAuth([entry]), CTX, expectOpen), 'auth');
  });
});

describe('the envelope', () => {
  test('refused: a fee-bump envelope', () => {
    const inner = TransactionBuilder.fromXDR(open().xdr, PASSPHRASE) as Transaction;
    const fb = TransactionBuilder.buildFeeBumpTransaction(SPONSOR, '200000', inner, PASSPHRASE);
    assert.ok(fb instanceof FeeBumpTransaction);
    assert.equal(
      verifyTransaction(
        { ...open(), xdr: fb.toXDR(), hash: toHex(fb.hash()) },
        CTX,
        expectOpen,
      ),
      'fee-bump',
    );
  });
  test("refused: another network's passphrase or id", () => {
    const main = envelope(
      {
        source: SELLER,
        sequence: '41',
        networkId: 'testnet',
        passphrase: 'Public Global Stellar Network ; September 2015',
        maxTime: NOW + 300,
      },
      [openWithDeposit(MARKET, params())],
      'x',
    );
    assert.equal(verifyTransaction(main, CTX, expectOpen), 'network');
    assert.equal(verifyTransaction({ ...open(), network: 'mainnet' }, CTX, expectOpen), 'network');
  });
  test('refused: a hash that is not the envelope', () =>
    assert.equal(verifyTransaction({ ...open(), hash: 'ab'.repeat(32) }, CTX, expectOpen), 'network'));
  test('refused: not an envelope', () => {
    assert.equal(verifyTransaction({ ...open(), xdr: 'AAAA' }, CTX, expectOpen), 'shape');
    assert.equal(verifyTransaction({ ...open(), xdr: '' }, CTX, expectOpen), 'shape');
  });
  test('refused: an envelope someone already signed', () => {
    const tx = TransactionBuilder.fromXDR(open().xdr, PASSPHRASE) as Transaction;
    tx.sign(Keypair.random());
    assert.equal(verifyTransaction({ ...open(), xdr: tx.toXDR() }, CTX, expectOpen), 'signed');
  });
  test('refused: another source account', () =>
    assert.equal(
      verifyTransaction(build([openWithDeposit(MARKET, params())], { source: OTHER }), CTX, expectOpen),
      'source',
    ));
  test('refused: an operation with another source', () => {
    const op = Operation.invokeContractFunction({
      contract: MARKET,
      function: 'release',
      args: [sc.address(SELLER), sc.u64(42)],
      auth: [],
      source: OTHER,
    });
    assert.equal(verifyTransaction(build([op]), CTX, { action: 'release', orderId: '42' }), 'source');
  });
  test('refused: a second operation', () =>
    assert.equal(
      verifyTransaction(
        build([openWithDeposit(MARKET, params()), payment(OTHER, USDC, '1')]),
        CTX,
        expectOpen,
      ),
      'operations',
    ));
  test('refused: no upper time bound, an expired one, or one more than ten minutes ahead', () => {
    assert.equal(verifyTransaction(build([openWithDeposit(MARKET, params())], { maxTime: 0 }), CTX, expectOpen), 'time');
    assert.equal(verifyTransaction(build([openWithDeposit(MARKET, params())], { maxTime: NOW - 1 }), CTX, expectOpen), 'time');
    assert.equal(verifyTransaction(build([openWithDeposit(MARKET, params())], { maxTime: NOW + 601 }), CTX, expectOpen), 'time');
    assert.equal(verifyTransaction(build([openWithDeposit(MARKET, params())], { maxTime: NOW + 600 }), CTX, expectOpen), null);
  });
  test('refused: a fee over the cap', () =>
    assert.equal(verifyTransaction(build([openWithDeposit(MARKET, params())], { fee: '20000001' }), CTX, expectOpen), 'fee'));
  test('refused: a memo on a contract call', () => {
    // The SDK's builder refuses one; a hand-made envelope can still carry it.
    const t = open();
    const wire = xdr.TransactionEnvelope.fromXdr(t.xdr, 'base64').toXdrObject() as {
      v1: { tx: { memo: unknown } };
    };
    wire.v1.tx.memo = { type: 1, text: 'hi' };
    const env = xdr.TransactionEnvelope.fromXdrObject(wire as never);
    const tx = TransactionBuilder.fromXDR(env.toXdr('base64'), PASSPHRASE) as Transaction;
    assert.equal(
      verifyTransaction({ ...t, xdr: env.toXdr('base64'), hash: toHex(tx.hash()) }, CTX, expectOpen),
      'memo',
    );
  });
  test('refused: no expectation, or a wallet that is no account', () => {
    assert.equal(verifyTransaction(open(), CTX, null), 'args');
    assert.equal(verifyTransaction(open(), { ...CTX, wallet: MARKET }, expectOpen), 'args');
  });
});

describe('a sale: terms come only from what the person saw and what the market publishes', () => {
  test("the bond is the market's sale bond rate of the amount, whatever a quote says", () => {
    const t = pinned(terms({ amountUnits: '2500000000' }));
    assert.equal(t.bondUnits, '250000000');
    assert.equal(t.amountUnits, '2500000000', 'the amount the person typed');
  });

  test("the windows are the market's (or a QR payment's constants)", () => {
    const t = pinned(
      saleTerms({
        orderId: ORDER_ID,
        seller: SELLER,
        token: 'USDC',
        accepted: ACCEPTED,
        order: { amountUnits: '1', buyer: BUYER },
        bondBps: 500,
        windows: QR_PAY_WINDOWS,
      }),
    );
    assert.deepEqual(
      [t.acceptWindow, t.paymentWindow, t.settleWindow, t.bondUnits],
      [120, 600, 3600, '50000000'],
    );
  });

  test("no saved acceptance: the order's own buyer and amount, no fee", () => {
    const t = pinned(terms(null));
    assert.deepEqual(
      [t.buyer, t.amountUnits, t.integrator, t.integratorFeeBps],
      [BUYER, '1000000000', null, 0],
    );
    const e: TxExpectation = { action: 'open_with_deposit', ...t };
    assert.notEqual(verifyTransaction(open({ buyer: OTHER }), CTX, e), null, 'a mismatched buyer');
    assert.notEqual(
      verifyTransaction(open({ integrator: OTHER, integratorFeeBps: 5 }), CTX, e),
      null,
      'no fee was shown',
    );
  });

  test('no trusted source names the buyer: refused before any signature', () => {
    assert.deepEqual(terms(null, { buyer: null }), { terms: null, problem: 'buyer' });
    assert.deepEqual(terms({ buyer: null }, { buyer: null }), { terms: null, problem: 'buyer' });
    assert.deepEqual(terms(null, { buyer: MARKET }), { terms: null, problem: 'buyer' });
    assert.deepEqual(terms(null, { buyer: 'nope' }), { terms: null, problem: 'buyer' });
    assert.deepEqual(terms({ buyer: SELLER }), { terms: null, problem: 'buyer' }, 'to oneself');
  });

  test('the buyer the quote named wins over a later answer', () => {
    const t = pinned(terms({ buyer: BUYER }, { buyer: OTHER }));
    assert.equal(t.buyer, BUYER);
    assert.notEqual(
      verifyTransaction(open({ buyer: OTHER }), CTX, { action: 'open_with_deposit', ...t }),
      null,
    );
  });

  test('an integrator fee: the rate that reproduces the fee shown, to the named recipient', () => {
    // 0.5% of 100 USDC, shown as 0.5 USDC.
    const t = pinned(terms({ integratorFeeUnits: '5000000', integrator: OTHER }));
    assert.deepEqual([t.integrator, t.integratorFeeBps], [OTHER, 50]);
    const e: TxExpectation = { action: 'open_with_deposit', ...t };
    assert.equal(verifyTransaction(open({ integrator: OTHER, integratorFeeBps: 50 }), CTX, e), null);
    assert.equal(verifyTransaction(open({ integrator: OTHER, integratorFeeBps: 51 }), CTX, e), 'args');
    assert.equal(verifyTransaction(open({ integrator: BOT, integratorFeeBps: 50 }), CTX, e), 'args');
    assert.deepEqual(
      terms({ integratorFeeUnits: '5000000', integrator: null }),
      { terms: null, problem: 'fee' },
      'a fee with no named recipient',
    );
    assert.deepEqual(
      terms({ integratorFeeUnits: '60000000', integrator: OTHER }),
      { terms: null, problem: 'fee' },
      'above the contract cap',
    );
    assert.deepEqual(
      terms({ integratorFeeUnits: '7', integrator: OTHER }),
      { terms: null, problem: 'fee' },
      'no rate reproduces it',
    );
  });

  test('the rate that reproduces a fee, as the contract rounds it', () => {
    assert.equal(integratorBpsFor('100000000', '0'), 0);
    assert.equal(integratorBpsFor('100000000', '500000'), 50);
    assert.equal(integratorBpsFor('100000000', '5000000'), 500);
    assert.equal(integratorBpsFor('100000000', '5010000'), null, 'over the 500 bps cap');
    assert.equal(integratorBpsFor('333333333', '1666666'), 50, 'rounded down like the contract');
    assert.equal(integratorBpsFor('100000000', '123'), null);
    assert.equal(integratorBpsFor('0', '1'), null);
    assert.equal(integratorBpsFor('x', '0'), null);
    assert.equal(MAX_INTEGRATOR_FEE_BPS, 500);
  });
});

describe('a quote is trusted only for what was asked and what it shows', () => {
  const asked = {
    side: 'SELL',
    network: 'testnet',
    token: 'USDC',
    currency: 'ARS',
    rail: 'ar_bank_transfer',
    tokenAmount: '1000000000',
  };
  const q = normalizeQuote({
    id: 'q',
    side: 'SELL',
    network: 'testnet',
    tokenSymbol: 'USDC',
    tokenDecimals: 7,
    currency: 'ARS',
    rail: 'ar_bank_transfer',
    price: '1452',
    fiatAmount: '145200.00',
    tokenAmount: '1000000000',
    protocolFee: '3000000',
    integratorFee: '0',
    netAmount: '997000000',
    merchantAddress: BUYER,
    expiresAt: '2026-11-19T12:00:00Z',
  });
  test('a quote that answers what was asked', () =>
    assert.deepEqual(trustQuote(q, asked, 7), {
      amountUnits: '1000000000',
      integratorFeeUnits: '0',
      buyer: BUYER,
      integrator: null,
    }));
  test('refused: another amount than typed', () =>
    assert.equal(trustQuote({ ...q, tokenAmount: '101' }, asked, 7), null));
  test('refused: another network, token, currency, rail or side', () => {
    for (const over of [
      { network: 'mainnet' },
      { token: 'TUSD' },
      { currency: 'BRL' },
      { rail: 'br_pix' },
      { side: 'BUY' as const },
    ])
      assert.equal(trustQuote({ ...q, ...over }, asked, 7), null, JSON.stringify(over));
  });
  test('refused: a purchase quoting another local amount than typed', () =>
    assert.equal(
      trustQuote(
        { ...q, side: 'BUY', fiatAmount: '150001' },
        {
          side: 'BUY',
          network: 'testnet',
          token: 'USDC',
          currency: 'ARS',
          rail: 'ar_bank_transfer',
          fiatAmount: '150000',
        },
        7,
      ),
      null,
    ));
  test('refused: an integrator fee no rate reproduces, over the cap, or with no recipient', () => {
    assert.equal(
      trustQuote({ ...q, integratorFee: '0.0000007', integrator: OTHER }, asked, 7),
      null,
    );
    assert.equal(trustQuote({ ...q, integratorFee: '6', integrator: OTHER }, asked, 7), null);
    assert.equal(trustQuote({ ...q, integratorFee: '0.5', integrator: null }, asked, 7), null);
    assert.equal(
      trustQuote({ ...q, integratorFee: '0.5', integrator: OTHER }, asked, 7)?.integratorFeeUnits,
      '5000000',
    );
  });
});

describe('an order action: that function, by the wallet, on the order on screen', () => {
  const call = (fn: string, caller = SELLER, id: bigint | number = 42) =>
    build([marketCall(MARKET, fn, [sc.address(caller), sc.u64(id)])]);
  const release = call('release');
  test('the order on screen passes', () =>
    assert.equal(verifyTransaction(release, CTX, { action: 'release', orderId: '42' }), null));
  test('refused: another order', () =>
    assert.equal(verifyTransaction(release, CTX, { action: 'release', orderId: '43' }), 'args'));
  test('refused: an order whose on-chain id is not known', () =>
    assert.equal(verifyTransaction(release, CTX, { action: 'release', orderId: null }), 'args'));
  test('refused: another caller than the wallet', () =>
    assert.equal(
      verifyTransaction(call('release', OTHER), CTX, { action: 'release', orderId: '42' }),
      'args',
    ));
  test('refused: a release when the person pressed cancel', () =>
    assert.equal(verifyTransaction(release, CTX, { action: 'cancel', orderId: '42' }), 'function'));
  test('refused: a dispute when the person pressed release', () =>
    assert.equal(
      verifyTransaction(call('dispute'), CTX, { action: 'release', orderId: '42' }),
      'function',
    ));
  test('refused: a call that is not a market function', () =>
    assert.equal(
      verifyTransaction(
        build([marketCall(MARKET, 'upgrade', [sc.address(SELLER), sc.u64(42)])]),
        CTX,
        { action: 'release', orderId: '42' },
      ),
      'function',
    ));
  test('refused: a classic operation where a call was expected', () =>
    assert.equal(
      verifyTransaction(build([payment(OTHER, USDC, '1')]), CTX, {
        action: 'release',
        orderId: '42',
      }),
      'function',
    ));
  test('refused: another contract', () =>
    assert.equal(
      verifyTransaction(
        build([marketCall(contract('evil'), 'release', [sc.address(SELLER), sc.u64(42)])]),
        CTX,
        { action: 'release', orderId: '42' },
      ),
      'target',
    ));
  test('refused: an id of another type', () =>
    assert.equal(
      verifyTransaction(
        build([marketCall(MARKET, 'release', [sc.address(SELLER), sc.u32(42)])]),
        CTX,
        { action: 'release', orderId: '42' },
      ),
      'args',
    ));
  test('refused: an action that pulls tokens it should not', () =>
    assert.equal(
      verifyTransaction(
        build([
          marketCall(MARKET, 'release', [sc.address(SELLER), sc.u64(42)], {
            token: USDC.contract,
            from: SELLER,
            amountUnits: '1',
          }),
        ]),
        CTX,
        { action: 'release', orderId: '42' },
      ),
      'auth',
    ));
});

describe('liquidity: what the person typed and ticked', () => {
  const deposit = { action: 'deposit' as const, token: 'USDC', amountUnits: '50000000' };
  const dep = (amount: string, token = USDC.contract, pullAmount = amount, who = SELLER) =>
    build([
      marketCall(MARKET, 'deposit', [sc.address(who), sc.address(token), sc.i128(amount)], {
        token,
        from: who,
        amountUnits: pullAmount,
      }),
    ]);
  test('a deposit as typed passes', () =>
    assert.equal(verifyTransaction(dep('50000000'), CTX, deposit), null));
  test('refused: a deposit of another amount', () =>
    assert.equal(verifyTransaction(dep('50000001'), CTX, deposit), 'args'));
  test('refused: a deposit that pulls more than it credits', () =>
    assert.equal(verifyTransaction(dep('50000000', USDC.contract, '90000000'), CTX, deposit), 'auth'));
  test('refused: a deposit of another token', () =>
    assert.equal(verifyTransaction(dep('50000000', TUSD.contract), CTX, deposit), 'args'));
  test('refused: a deposit for another account', () =>
    assert.equal(verifyTransaction(dep('50000000', USDC.contract, '50000000', OTHER), CTX, deposit), 'args'));
  test('refused: a withdrawal when the person deposits', () =>
    assert.equal(
      verifyTransaction(
        build([marketCall(MARKET, 'withdraw', [sc.address(SELLER), sc.address(USDC.contract), sc.i128('50000000')])]),
        CTX,
        deposit,
      ),
      'function',
    ));
  test('a withdrawal as typed passes; another amount is refused', () => {
    const w = (amount: string) =>
      build([marketCall(MARKET, 'withdraw', [sc.address(SELLER), sc.address(USDC.contract), sc.i128(amount)])]);
    const e = { action: 'withdraw' as const, token: 'USDC', amountUnits: '50000000' };
    assert.equal(verifyTransaction(w('50000000'), CTX, e), null);
    assert.equal(verifyTransaction(w('60000000'), CTX, e), 'args');
  });

  const op = { action: 'set_operator' as const, operator: BOT, perms: 6 };
  const setOp = (who: string, perms: number) =>
    build([marketCall(MARKET, 'set_operator', [sc.address(SELLER), sc.address(who), sc.u32(perms)])]);
  test('a bot with the ticked bits passes', () =>
    assert.equal(verifyTransaction(setOp(BOT, 6), CTX, op), null));
  test('refused: more bits than ticked', () =>
    assert.equal(verifyTransaction(setOp(BOT, 15), CTX, op), 'args'));
  test('refused: another bot address', () =>
    assert.equal(verifyTransaction(setOp(OTHER, 6), CTX, op), 'args'));

  const matcher = {
    action: 'set_matcher' as const,
    matcher: MATCHER,
    maxPerOrderUnits: '20000000000',
    autoSettle: false,
  };
  const setMatcher = (m: string, cap: string, auto: boolean) =>
    build([
      marketCall(MARKET, 'set_matcher', [sc.address(SELLER), sc.address(m), sc.i128(cap), sc.bool(auto)]),
    ]);
  test("the market's matcher with the typed cap passes", () =>
    assert.equal(verifyTransaction(setMatcher(MATCHER, '20000000000', false), CTX, matcher), null));
  test('refused: another matcher address', () =>
    assert.equal(verifyTransaction(setMatcher(OTHER, '20000000000', false), CTX, matcher), 'args'));
  test('refused: another cap', () =>
    assert.equal(verifyTransaction(setMatcher(MATCHER, '20000000001', false), CTX, matcher), 'args'));
  test('refused: auto-settle the person did not choose', () =>
    assert.equal(verifyTransaction(setMatcher(MATCHER, '20000000000', true), CTX, matcher), 'args'));
});

describe('a payment: destination, asset, amount and memo as confirmed', () => {
  const pay = { action: 'payment' as const, to: BUYER, token: 'USDC', amountUnits: '125000000', memo: 'pizza' };
  const send = (to: string, token: P2pToken, amount: string, memo: string | null = 'pizza') =>
    build([payment(to, token, amount)], { memo });
  test('the confirmed payment passes', () =>
    assert.equal(verifyTransaction(send(BUYER, USDC, '125000000'), CTX, pay), null));
  test('refused: another destination', () =>
    assert.equal(verifyTransaction(send(OTHER, USDC, '125000000'), CTX, pay), 'args'));
  test('refused: another asset with the same code', () =>
    assert.equal(
      verifyTransaction(send(BUYER, { ...USDC, issuer: OTHER }, '125000000'), CTX, pay),
      'args',
    ));
  test('refused: another token', () =>
    assert.equal(verifyTransaction(send(BUYER, TUSD, '125000000'), CTX, pay), 'args'));
  test('refused: another amount', () =>
    assert.equal(verifyTransaction(send(BUYER, USDC, '125000001'), CTX, pay), 'args'));
  test('refused: another memo, or none', () => {
    assert.equal(verifyTransaction(send(BUYER, USDC, '125000000', 'pizzas'), CTX, pay), 'memo');
    assert.equal(verifyTransaction(send(BUYER, USDC, '125000000', null), CTX, pay), 'memo');
    assert.equal(
      verifyTransaction(send(BUYER, USDC, '125000000', 'x'), CTX, { ...pay, memo: null }),
      'memo',
    );
  });
  test('a muxed destination must be the same muxed address', () => {
    const base = Keypair.fromPublicKey(BUYER);
    const m = StrKey.encodeMed25519PublicKey(
      new Uint8Array([...base.rawPublicKey(), 0, 0, 0, 0, 0, 0, 0, 7]),
    );
    const m2 = StrKey.encodeMed25519PublicKey(
      new Uint8Array([...base.rawPublicKey(), 0, 0, 0, 0, 0, 0, 0, 8]),
    );
    assert.equal(verifyTransaction(send(m, USDC, '125000000'), CTX, { ...pay, to: m }), null);
    assert.equal(verifyTransaction(send(m2, USDC, '125000000'), CTX, { ...pay, to: m }), 'args');
    assert.equal(verifyTransaction(send(BUYER, USDC, '125000000'), CTX, { ...pay, to: m }), 'args');
  });
  test('refused: a payment to oneself', () =>
    assert.equal(verifyTransaction(send(SELLER, USDC, '125000000'), CTX, { ...pay, to: SELLER }), 'args'));
  test('to a contract: the token contract transfer, no memo', () => {
    const e = { ...pay, to: SHOP, memo: null };
    assert.equal(verifyTransaction(build([contractTransfer(SELLER, SHOP, USDC, '125000000')]), CTX, e), null);
    assert.equal(
      verifyTransaction(build([contractTransfer(SELLER, contract('x'), USDC, '125000000')]), CTX, e),
      'args',
    );
    assert.equal(
      verifyTransaction(build([contractTransfer(SELLER, SHOP, TUSD, '125000000')]), CTX, e),
      'target',
    );
    assert.equal(
      verifyTransaction(build([contractTransfer(SELLER, SHOP, USDC, '125000000')]), CTX, { ...e, memo: 'pizza' }),
      'memo',
    );
  });
});

describe('the sponsored activation', () => {
  const act = (over: Partial<{ create: boolean; source: string; token: P2pToken; extra: xdr.Operation[] }> = {}) =>
    build(
      [
        ...activation({
          sponsor: SPONSOR,
          account: SELLER,
          token: over.token ?? USDC,
          createAccount: over.create ?? false,
        }),
        ...(over.extra ?? []),
      ],
      { source: over.source ?? SELLER },
    );
  const e = { action: 'activate' as const, token: 'USDC' };
  test('opening the trustline of an existing account passes', () =>
    assert.equal(verifyTransaction(act(), CTX, e), null));
  test("creating a missing account passes only as the sponsor's transaction", () => {
    assert.equal(verifyTransaction(act({ create: true, source: SPONSOR }), CTX, e), null);
    assert.equal(verifyTransaction(act({ create: true, source: SELLER }), CTX, e), 'source');
  });
  test('refused: another asset', () =>
    assert.equal(verifyTransaction(act({ token: TUSD }), CTX, e), 'args'));
  test('refused: an extra operation', () =>
    assert.equal(verifyTransaction(act({ extra: [payment(OTHER, USDC, '1')] }), CTX, e), 'operations'));
  test('refused: a limited trustline or a removal', () => {
    for (const limit of ['0', '1000']) {
      const ops = activation({ sponsor: SPONSOR, account: SELLER, token: USDC, createAccount: false });
      ops[1] = Operation.changeTrust({ asset: new Asset('USDC', ISSUER), limit, source: SELLER });
      assert.equal(verifyTransaction(build(ops), CTX, e), 'args', limit);
    }
  });
  test('refused: a source that is neither the wallet nor the sponsor', () =>
    assert.equal(verifyTransaction(act({ source: OTHER }), CTX, e), 'source'));
  test('refused: the wallet sponsoring itself', () =>
    assert.equal(
      verifyTransaction(
        build(activation({ sponsor: SELLER, account: SELLER, token: USDC, createAccount: false })),
        CTX,
        e,
      ),
      'source',
    ));
  test('refused: a starting balance', () => {
    const ops = activation({ sponsor: SPONSOR, account: SELLER, token: USDC, createAccount: true });
    ops[1] = Operation.createAccount({ destination: SELLER, startingBalance: '5', source: SPONSOR });
    assert.equal(verifyTransaction(build(ops, { source: SPONSOR }), CTX, e), 'args');
  });
  test('refused: an activation where a payment was expected', () =>
    assert.equal(
      verifyTransaction(act(), CTX, { action: 'payment', to: BUYER, token: 'USDC', amountUnits: '1', memo: null }),
      'operations',
    ));
  test('the trust limit is the classic maximum', () => assert.equal(MAX_TRUST_LIMIT, '922337203685.4775807'));
});

test("an order's on-chain ref is derived from its uuid as the API derives it", () => {
  const id = '0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e';
  const bytes = new Uint8Array(id.replace(/-/g, '').match(/../g)!.map((h) => Number.parseInt(h, 16)));
  assert.equal(orderRef(id), toHex(hash(bytes)));
  assert.equal(orderRef(id.toUpperCase()), orderRef(id));
  assert.equal(orderRef('ord_123'), null, 'not a uuid: no ref to pin, the sale is refused');
});

test("the ref is only ever derived from the order's id, never taken from an answer", () => {
  const serverRef = toHex(hash(enc('what the server says')));
  const r = saleTerms({
    orderId: 'ord_123',
    seller: SELLER,
    token: 'USDC',
    accepted: ACCEPTED,
    order: { amountUnits: '1000000000', buyer: BUYER },
    ...MARKET_RULES,
  });
  assert.deepEqual(r, { terms: null, problem: 'ref' });
  const t = pinned(terms());
  assert.equal(t.ref, orderRef(ORDER_ID));
  assert.notEqual(
    verifyTransaction(open({ ref: serverRef }), CTX, { action: 'open_with_deposit', ...t }),
    null,
  );
  assert.equal(verifyTransaction(open(), CTX, { action: 'open_with_deposit', ...t }), null);
});

test('a quote carries the terms the sale is pinned to', () => {
  const q = normalizeQuote({
    id: 'q',
    side: 'SELL',
    network: 'testnet',
    tokenSymbol: 'USDC',
    tokenDecimals: 7,
    tokenAmount: '1000000000',
    protocolFee: '0',
    integratorFee: '0',
    netAmount: '1000000000',
    merchantAddress: BUYER,
    bond: '100000000',
    integrator: OTHER,
    integratorFeeBps: 50,
    expiresAt: '2026-11-19T12:00:00Z',
  });
  assert.deepEqual(
    [q.merchantAddress, q.bondUnits, q.integrator, q.integratorFeeBps],
    [BUYER, '100000000', OTHER, 50],
  );
  const bare = normalizeQuote({ id: 'q', integrator: MARKET, integratorFeeBps: -1, bond: '1.5' });
  assert.deepEqual(
    [bare.merchantAddress, bare.bondUnits, bare.integrator, bare.integratorFeeBps],
    [null, null, null, 0],
  );
});
