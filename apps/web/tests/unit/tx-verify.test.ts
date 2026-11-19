/* tx-verify.test.ts: a transaction the API built is decoded with the contract's ABI and refused
   unless every field equals what the person agreed to (src/lib/p2p/tx-verify.ts): one case per
   field that could be swapped by a compromised or buggy API. */
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  encodeFunctionData,
  erc20Abi,
  keccak256,
  maxUint256,
  stringToHex,
  zeroAddress,
  type Hex,
} from 'viem';
import { MARKET_ABI, saleTerms, verifyTransaction, type SaleTerms } from '@/lib/p2p/tx-verify';
import {
  integratorBpsFor,
  MAX_INTEGRATOR_FEE_BPS,
  trustQuote,
  type AcceptedQuote,
} from '@/lib/p2p/fees';
import { normalizeQuote } from '@/lib/p2p/normalize';
import { orderRef } from '@/lib/p2p/order-ref';
import type { P2pTransaction } from '@/lib/p2p/types';

const NETWORK = {
  chainId: 8453,
  contract: '0x5eed00000000000000000000000000000000ba5e' as Hex,
  tokens: [
    { symbol: 'USDC', address: '0xc0c0000000000000000000000000000000000001' as Hex, decimals: 6 },
    { symbol: 'USDT', address: '0xc0c0000000000000000000000000000000000002' as Hex, decimals: 6 },
  ],
};
const USDC = NETWORK.tokens[0].address;
const SELLER = '0x11ce00000000000000000000000000000000f0e1' as Hex;
const BUYER = '0x9e77000000000000000000000000000000000c4a' as Hex;
const OTHER = '0x0bad000000000000000000000000000000000bad' as Hex;
const MATCHER = '0x3a7c4e000000000000000000000000000000beef' as Hex;
const BOT = '0xb07000000000000000000000000000000000b075' as Hex;
const REF = keccak256(stringToHex('ord_1'));
const MARKET = {
  sellBondBps: 1000,
  windows: { acceptSeconds: 300, sellPaymentSeconds: 1800, settleSeconds: 21600 },
};

const tx = (to: string, data: Hex, chainId = 8453): P2pTransaction => ({
  chainId,
  to,
  data,
  value: '0',
});
const call = (fn: string, args: readonly unknown[]) =>
  encodeFunctionData({ abi: MARKET_ABI, functionName: fn as never, args: args as never });
const ACCEPTED: AcceptedQuote = {
  amountUnits: '100000000',
  integratorFeeUnits: '0',
  buyer: BUYER,
  integrator: null,
};
const terms = (
  accepted: Partial<AcceptedQuote> | null = {},
  order: Partial<{ amountUnits: string; buyer: string | null }> = {},
) =>
  saleTerms({
    ref: REF,
    seller: SELLER,
    token: 'USDC',
    accepted: accepted === null ? null : { ...ACCEPTED, ...accepted },
    order: { amountUnits: '100000000', buyer: BUYER, ...order },
    market: MARKET,
  });
const pinned = (r: ReturnType<typeof saleTerms>): SaleTerms => {
  assert.equal(r.problem, null);
  return r.terms!;
};

/* The terms the person accepted: a 100 USDC sale to BUYER, the market's bond and windows, no
   integrator fee. */
const expectOpen = { action: 'openWithDeposit' as const, ...pinned(terms()) };

const params = (over: Record<string, unknown> = {}) => ({
  ref: REF,
  seller: SELLER,
  buyer: BUYER,
  token: USDC,
  amount: 100_000_000n,
  bond: 10_000_000n,
  acceptWindow: 300,
  paymentWindow: 1800,
  settleWindow: 21600,
  integrator: zeroAddress,
  integratorFeeBps: 0,
  ...over,
});
const open = (over: Record<string, unknown> = {}) =>
  tx(NETWORK.contract, call('openWithDeposit', [params(over)]));

describe('a sale: openWithDeposit must carry every accepted term', () => {
  test('the accepted terms pass', () => {
    assert.equal(verifyTransaction(open(), NETWORK, expectOpen), null);
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
      ['10000000', 300, 1800, 21600, zeroAddress, 0],
      "the market's bond rate and windows, no integrator",
    );
  });

  const swaps: [string, Record<string, unknown>][] = [
    ['an integrator slipped in with a fee', { integrator: OTHER, integratorFeeBps: 500 }],
    ['an integrator address with no fee', { integrator: OTHER }],
    ['a fee with the zero integrator', { integratorFeeBps: 1 }],
    ['a different bond', { bond: 20_000_000n }],
    ['no bond', { bond: 0n }],
    ['a longer accept window', { acceptWindow: 86400 }],
    ['a different payment window', { paymentWindow: 7200 }],
    ['a different settle window', { settleWindow: 3600 }],
    ['no settle window', { settleWindow: 0 }],
    ['another buyer than the quoted merchant', { buyer: OTHER }],
    ['another seller', { seller: OTHER }],
    ['another token', { token: NETWORK.tokens[1].address }],
    ['another amount', { amount: 100_000_001n }],
    ['another ref', { ref: keccak256(stringToHex('ord_2')) }],
  ];
  for (const [name, over] of swaps) {
    test(`refused: ${name}`, () =>
      assert.equal(verifyTransaction(open(over), NETWORK, expectOpen), 'args'));
  }

  test('refused: another contract, another chain, a native value, another function', () => {
    assert.equal(verifyTransaction({ ...open(), to: OTHER }, NETWORK, expectOpen), 'target');
    assert.equal(verifyTransaction({ ...open(), chainId: 1 }, NETWORK, expectOpen), 'chain');
    assert.equal(verifyTransaction({ ...open(), value: '1' }, NETWORK, expectOpen), 'value');
    assert.equal(
      verifyTransaction(tx(NETWORK.contract, call('open', [params()])), NETWORK, expectOpen),
      'function',
    );
  });
});

describe('a sale: terms come only from what the person saw and what the market publishes', () => {
  test("the bond is the market's sale bond rate of the amount, whatever a quote says", () => {
    const t = pinned(terms({ amountUnits: '250000000' }));
    assert.equal(t.bondUnits, '25000000');
    assert.equal(t.amountUnits, '250000000', 'the amount the person typed');
  });

  test("the windows are the market's", () => {
    const t = pinned(
      saleTerms({
        ref: REF,
        seller: SELLER,
        token: 'USDC',
        accepted: ACCEPTED,
        order: { amountUnits: '1', buyer: BUYER },
        market: {
          sellBondBps: 500,
          windows: { acceptSeconds: 60, sellPaymentSeconds: 600, settleSeconds: 0 },
        },
      }),
    );
    assert.deepEqual(
      [t.acceptWindow, t.paymentWindow, t.settleWindow, t.bondUnits],
      [60, 600, 0, '5000000'],
    );
  });

  test("no saved acceptance: the order's own buyer and amount, no fee", () => {
    const t = pinned(terms(null));
    assert.deepEqual(
      [t.buyer, t.amountUnits, t.integrator, t.integratorFeeBps],
      [BUYER, '100000000', zeroAddress, 0],
    );
    const e = { action: 'openWithDeposit' as const, ...t };
    assert.equal(
      verifyTransaction(open({ buyer: OTHER }), NETWORK, e),
      'args',
      'a mismatched buyer is refused',
    );
    assert.equal(
      verifyTransaction(open({ integrator: OTHER, integratorFeeBps: 5 }), NETWORK, e),
      'args',
      'no fee was shown',
    );
  });

  test('no trusted source names the buyer: refused before any signature', () => {
    assert.deepEqual(terms(null, { buyer: null }), { terms: null, problem: 'buyer' });
    assert.deepEqual(terms({ buyer: null }, { buyer: null }), { terms: null, problem: 'buyer' });
    assert.deepEqual(terms(null, { buyer: zeroAddress }), { terms: null, problem: 'buyer' });
    assert.deepEqual(terms(null, { buyer: 'nope' }), { terms: null, problem: 'buyer' });
  });

  test('the buyer the quote named wins over a later answer', () => {
    const t = pinned(terms({ buyer: BUYER }, { buyer: OTHER }));
    assert.equal(t.buyer, BUYER);
    assert.equal(
      verifyTransaction(open({ buyer: OTHER }), NETWORK, { action: 'openWithDeposit', ...t }),
      'args',
    );
  });

  test('an integrator fee: the rate that reproduces the fee shown, to the named recipient', () => {
    // 0.5% of 100 USDC, shown as 0.5 USDC.
    const t = pinned(terms({ integratorFeeUnits: '500000', integrator: OTHER }));
    assert.deepEqual([t.integrator, t.integratorFeeBps], [OTHER, 50]);
    const e = { action: 'openWithDeposit' as const, ...t };
    assert.equal(
      verifyTransaction(open({ integrator: OTHER, integratorFeeBps: 50 }), NETWORK, e),
      null,
    );
    assert.equal(
      verifyTransaction(open({ integrator: OTHER, integratorFeeBps: 51 }), NETWORK, e),
      'args',
    );
    assert.equal(
      verifyTransaction(open({ integrator: BOT, integratorFeeBps: 50 }), NETWORK, e),
      'args',
    );
    assert.deepEqual(
      terms({ integratorFeeUnits: '500000', integrator: null }),
      { terms: null, problem: 'fee' },
      'a fee with no named recipient',
    );
    assert.deepEqual(
      terms({ integratorFeeUnits: '6000000', integrator: OTHER }),
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
    network: 'base',
    token: 'USDC',
    currency: 'ARS',
    rail: 'ar_bank_transfer',
    tokenAmount: '100000000',
  };
  const q = normalizeQuote({
    id: 'q',
    side: 'SELL',
    network: 'base',
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    currency: 'ARS',
    rail: 'ar_bank_transfer',
    price: '1452',
    fiatAmount: '145200.00',
    tokenAmount: '100000000',
    protocolFee: '300000',
    integratorFee: '0',
    netAmount: '99700000',
    merchantAddress: BUYER,
    expiresAt: '2026-11-19T12:00:00Z',
  });
  test('a quote that answers what was asked', () =>
    assert.deepEqual(trustQuote(q, asked, 6), {
      amountUnits: '100000000',
      integratorFeeUnits: '0',
      buyer: BUYER,
      integrator: null,
    }));
  test('refused: another amount than typed', () =>
    assert.equal(trustQuote({ ...q, tokenAmount: '101' }, asked, 6), null));
  test('refused: another network, token, currency, rail or side', () => {
    for (const over of [
      { network: 'arbitrum' },
      { token: 'USDT' },
      { currency: 'BRL' },
      { rail: 'br_pix' },
      { side: 'BUY' as const },
    ])
      assert.equal(trustQuote({ ...q, ...over }, asked, 6), null, JSON.stringify(over));
  });
  test('refused: a purchase quoting another local amount than typed', () =>
    assert.equal(
      trustQuote(
        { ...q, side: 'BUY', fiatAmount: '150001' },
        {
          side: 'BUY',
          network: 'base',
          token: 'USDC',
          currency: 'ARS',
          rail: 'ar_bank_transfer',
          fiatAmount: '150000',
        },
        6,
      ),
      null,
    ));
  test('refused: an integrator fee no rate reproduces, over the cap, or with no recipient', () => {
    assert.equal(
      trustQuote({ ...q, integratorFee: '0.000007', integrator: OTHER }, asked, 6),
      null,
    );
    assert.equal(trustQuote({ ...q, integratorFee: '6', integrator: OTHER }, asked, 6), null);
    assert.equal(trustQuote({ ...q, integratorFee: '0.5', integrator: null }, asked, 6), null);
    assert.equal(
      trustQuote({ ...q, integratorFee: '0.5', integrator: OTHER }, asked, 6)?.integratorFeeUnits,
      '500000',
    );
  });
});

describe('a sale: the approval', () => {
  const approve = (spender: Hex, amount: bigint, to: Hex = USDC) =>
    tx(to, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }));
  const e = {
    action: 'approve' as const,
    token: 'USDC',
    spender: NETWORK.contract,
    amountUnits: '100000000',
  };
  test('the market contract, exactly the order amount', () =>
    assert.equal(verifyTransaction(approve(NETWORK.contract, 100_000_000n), NETWORK, e), null));
  test('refused: another amount', () =>
    assert.equal(verifyTransaction(approve(NETWORK.contract, 100_000_001n), NETWORK, e), 'args'));
  test('refused: an unlimited approval', () =>
    assert.equal(verifyTransaction(approve(NETWORK.contract, maxUint256), NETWORK, e), 'args'));
  test('refused: another spender', () =>
    assert.notEqual(verifyTransaction(approve(OTHER, 100_000_000n), NETWORK, e), null));
  test('refused: another spender even if the screen named it', () =>
    assert.notEqual(
      verifyTransaction(approve(OTHER, 100_000_000n), NETWORK, { ...e, spender: OTHER }),
      null,
    ));
  test('refused: another token', () =>
    assert.notEqual(
      verifyTransaction(
        approve(NETWORK.contract, 100_000_000n, NETWORK.tokens[1].address),
        NETWORK,
        e,
      ),
      null,
    ));
  test('refused: another chain', () =>
    assert.equal(
      verifyTransaction({ ...approve(NETWORK.contract, 100_000_000n), chainId: 10 }, NETWORK, e),
      'chain',
    ));
  test('refused: a transfer dressed as an approval', () =>
    assert.notEqual(
      verifyTransaction(
        tx(
          USDC,
          encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [NETWORK.contract, 1n],
          }),
        ),
        NETWORK,
        e,
      ),
      null,
    ));
});

describe('an order action: that function, on the order on screen', () => {
  const release = tx(NETWORK.contract, call('release', [42n]));
  test('the order on screen passes', () =>
    assert.equal(verifyTransaction(release, NETWORK, { action: 'release', orderId: '42' }), null));
  test('refused: another order', () =>
    assert.equal(
      verifyTransaction(release, NETWORK, { action: 'release', orderId: '43' }),
      'args',
    ));
  test('refused: an order whose on-chain id is not known', () =>
    assert.equal(
      verifyTransaction(release, NETWORK, { action: 'release', orderId: null }),
      'args',
    ));
  test('refused: a release when the person pressed cancel', () =>
    assert.equal(
      verifyTransaction(release, NETWORK, { action: 'cancel', orderId: '42' }),
      'function',
    ));
  test('refused: a dispute when the person pressed release', () =>
    assert.equal(
      verifyTransaction(tx(NETWORK.contract, call('dispute', [42n])), NETWORK, {
        action: 'release',
        orderId: '42',
      }),
      'function',
    ));
  test('refused: calldata that is no market function', () =>
    assert.equal(
      verifyTransaction(tx(NETWORK.contract, '0xdeadbeef00'), NETWORK, {
        action: 'release',
        orderId: '42',
      }),
      'function',
    ));
  test('refused: another contract', () =>
    assert.equal(
      verifyTransaction({ ...release, to: OTHER }, NETWORK, { action: 'release', orderId: '42' }),
      'target',
    ));
});

describe('liquidity: what the person typed and ticked', () => {
  const deposit = { action: 'deposit' as const, token: 'USDC', amountUnits: '5000000' };
  test('a deposit as typed passes', () =>
    assert.equal(
      verifyTransaction(
        tx(NETWORK.contract, call('deposit', [USDC, 5_000_000n])),
        NETWORK,
        deposit,
      ),
      null,
    ));
  test('refused: a deposit of another amount', () =>
    assert.equal(
      verifyTransaction(
        tx(NETWORK.contract, call('deposit', [USDC, 5_000_001n])),
        NETWORK,
        deposit,
      ),
      'args',
    ));
  test('refused: a deposit of another token', () =>
    assert.equal(
      verifyTransaction(
        tx(NETWORK.contract, call('deposit', [NETWORK.tokens[1].address, 5_000_000n])),
        NETWORK,
        deposit,
      ),
      'args',
    ));
  test('refused: a withdrawal when the person deposits', () =>
    assert.equal(
      verifyTransaction(
        tx(NETWORK.contract, call('withdraw', [USDC, 5_000_000n])),
        NETWORK,
        deposit,
      ),
      'function',
    ));
  test('refused: a withdrawal of another amount', () =>
    assert.equal(
      verifyTransaction(tx(NETWORK.contract, call('withdraw', [USDC, 6_000_000n])), NETWORK, {
        action: 'withdraw',
        token: 'USDC',
        amountUnits: '5000000',
      }),
      'args',
    ));

  const op = { action: 'setOperator' as const, operator: BOT, perms: 6 };
  test('a bot with the ticked bits passes', () =>
    assert.equal(
      verifyTransaction(tx(NETWORK.contract, call('setOperator', [BOT, 6])), NETWORK, op),
      null,
    ));
  test('refused: more bits than ticked', () =>
    assert.equal(
      verifyTransaction(tx(NETWORK.contract, call('setOperator', [BOT, 15])), NETWORK, op),
      'args',
    ));
  test('refused: another bot address', () =>
    assert.equal(
      verifyTransaction(tx(NETWORK.contract, call('setOperator', [OTHER, 6])), NETWORK, op),
      'args',
    ));

  const matcher = {
    action: 'setMatcher' as const,
    matcher: MATCHER,
    maxPerOrderUnits: '2000000000',
    autoSettle: false,
  };
  const setMatcher = (m: Hex, cap: bigint, auto: boolean) =>
    tx(NETWORK.contract, call('setMatcher', [m, cap, auto]));
  test("the market's matcher with the typed cap passes", () =>
    assert.equal(
      verifyTransaction(setMatcher(MATCHER, 2_000_000_000n, false), NETWORK, matcher),
      null,
    ));
  test('refused: another matcher address', () =>
    assert.equal(
      verifyTransaction(setMatcher(OTHER, 2_000_000_000n, false), NETWORK, matcher),
      'args',
    ));
  test('refused: another cap', () =>
    assert.equal(
      verifyTransaction(setMatcher(MATCHER, 2_000_000_001n, false), NETWORK, matcher),
      'args',
    ));
  test('refused: auto-settle the person did not choose', () =>
    assert.equal(
      verifyTransaction(setMatcher(MATCHER, 2_000_000_000n, true), NETWORK, matcher),
      'args',
    ));
});

test('a quote carries the terms the sale is pinned to', () => {
  const q = normalizeQuote({
    id: 'q',
    side: 'SELL',
    network: 'base',
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    tokenAmount: '100000000',
    protocolFee: '0',
    integratorFee: '0',
    netAmount: '100000000',
    merchantAddress: BUYER,
    bond: '10000000',
    integrator: OTHER,
    integratorFeeBps: 50,
    expiresAt: '2026-11-19T12:00:00Z',
  });
  assert.deepEqual(
    [q.merchantAddress, q.bondUnits, q.integrator, q.integratorFeeBps],
    [BUYER, '10000000', OTHER, 50],
  );
  const bare = normalizeQuote({
    id: 'q',
    integrator: zeroAddress,
    integratorFeeBps: -1,
    bond: '1.5',
  });
  assert.deepEqual(
    [bare.merchantAddress, bare.bondUnits, bare.integrator, bare.integratorFeeBps],
    [null, null, null, 0],
  );
});

test("an order's on-chain ref is derived from its uuid as the API derives it", () => {
  const id = '0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e';
  assert.equal(orderRef(id), keccak256('0x0b5e8f1c2d3a4b5c8d9e0f1a2b3c4d5e'));
  assert.equal(orderRef(id.toUpperCase()), orderRef(id));
  assert.equal(orderRef('ord_123'), null, 'not a uuid: no ref to pin, the sale is refused');
});
