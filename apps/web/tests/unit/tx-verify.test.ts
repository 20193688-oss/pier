/* tx-verify.test.ts: a transaction the API built is decoded with the contract's ABI and refused
   unless it does exactly what the screen promised (src/lib/p2p/tx-verify.ts). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { encodeFunctionData, erc20Abi, keccak256, stringToHex, type Hex } from 'viem';
import { MARKET_ABI, verifyTransaction } from '@/lib/p2p/tx-verify';
import type { P2pTransaction } from '@/lib/p2p/types';

const NETWORK = {
  chainId: 8453,
  contract: '0x5eed00000000000000000000000000000000ba5e' as Hex,
  tokens: [
    { symbol: 'USDC', address: '0xc0c0000000000000000000000000000000000001' as Hex, decimals: 6 },
  ],
};
const SELLER = '0x11ce00000000000000000000000000000000f0e1';
const BUYER = '0x9e77000000000000000000000000000000000c4a';
const REF = keccak256(stringToHex('ord_1'));
const tx = (to: string, data: Hex, action?: string): P2pTransaction => ({
  chainId: 8453,
  to,
  data,
  value: '0',
  action,
});
const market = (fn: string, args: readonly unknown[]) =>
  encodeFunctionData({ abi: MARKET_ABI, functionName: fn as never, args: args as never });

const open = (over: Record<string, unknown> = {}) =>
  market('openWithDeposit', [
    {
      ref: REF,
      seller: SELLER,
      buyer: BUYER,
      token: NETWORK.tokens[0].address,
      amount: 100_000_000n,
      bond: 10_000_000n,
      acceptWindow: 300,
      paymentWindow: 1800,
      settleWindow: 21600,
      integrator: '0x0000000000000000000000000000000000000000',
      integratorFeeBps: 0,
      ...over,
    },
  ]);

test('a sale: the approval names the market and the exact amount', () => {
  const ok = tx(
    NETWORK.tokens[0].address,
    encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [NETWORK.contract, 100_000_000n],
    }),
    'approve',
  );
  const expect = {
    action: 'approve' as const,
    token: 'USDC',
    spender: NETWORK.contract,
    amountUnits: '100000000',
  };
  assert.equal(verifyTransaction(ok, NETWORK, expect), null);
  assert.equal(
    verifyTransaction(ok, NETWORK, { ...expect, amountUnits: '1' }),
    'args',
    'another amount',
  );
  const unlimited = tx(
    NETWORK.tokens[0].address,
    encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [NETWORK.contract, 2n ** 256n - 1n],
    }),
    'approve',
  );
  assert.equal(
    verifyTransaction(unlimited, NETWORK, expect),
    'args',
    'never an unlimited approval',
  );
  const transfer = tx(
    NETWORK.tokens[0].address,
    encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [NETWORK.contract, 1n] }),
    'approve',
  );
  assert.equal(
    verifyTransaction(transfer, NETWORK, expect),
    'function',
    'a transfer dressed as an approval',
  );
});

test('a sale: openWithDeposit from this seller, of this token and amount, for this order', () => {
  const expect = {
    action: 'openWithDeposit' as const,
    seller: SELLER,
    token: 'USDC',
    amountUnits: '100000000',
    buyer: BUYER,
    ref: REF,
  };
  assert.equal(verifyTransaction(tx(NETWORK.contract, open()), NETWORK, expect), null);
  assert.equal(
    verifyTransaction(tx(NETWORK.contract, open({ amount: 100_000_001n })), NETWORK, expect),
    'args',
  );
  assert.equal(
    verifyTransaction(tx(NETWORK.contract, open({ seller: BUYER })), NETWORK, expect),
    'args',
  );
  assert.equal(
    verifyTransaction(tx(NETWORK.contract, open({ buyer: SELLER })), NETWORK, expect),
    'args',
    'the order goes to its merchant',
  );
  assert.equal(
    verifyTransaction(
      tx(NETWORK.contract, open({ ref: keccak256(stringToHex('other')) })),
      NETWORK,
      expect,
    ),
    'args',
  );
  assert.equal(
    verifyTransaction(tx(NETWORK.contract, open()), NETWORK, { ...expect, buyer: null, ref: null }),
    null,
    'unknown fields are not compared',
  );
  assert.equal(
    verifyTransaction(tx('0x00000000000000000000000000000000000000ee', open()), NETWORK, expect),
    'target',
  );
  assert.equal(
    verifyTransaction({ ...tx(NETWORK.contract, open()), chainId: 1 }, NETWORK, expect),
    'chain',
  );
});

test('an order action: that function, on that on-chain order', () => {
  const release = tx(NETWORK.contract, market('release', [42n]));
  assert.equal(verifyTransaction(release, NETWORK, { action: 'release', orderId: '42' }), null);
  assert.equal(verifyTransaction(release, NETWORK, { action: 'release', orderId: '43' }), 'args');
  assert.equal(
    verifyTransaction(release, NETWORK, { action: 'cancel', orderId: '42' }),
    'function',
    'a release is not a cancel',
  );
  assert.equal(verifyTransaction(release, NETWORK, { action: 'release', orderId: null }), null);
  assert.equal(
    verifyTransaction(tx(NETWORK.contract, '0xdeadbeef00'), NETWORK, { action: 'release' }),
    'function',
  );
});

test('liquidity: deposit, withdraw, a bot and the matcher, as typed', () => {
  const token = NETWORK.tokens[0].address;
  assert.equal(
    verifyTransaction(tx(NETWORK.contract, market('deposit', [token, 5_000_000n])), NETWORK, {
      action: 'deposit',
      token: 'USDC',
      amountUnits: '5000000',
    }),
    null,
  );
  assert.equal(
    verifyTransaction(tx(NETWORK.contract, market('withdraw', [token, 5_000_000n])), NETWORK, {
      action: 'deposit',
      token: 'USDC',
      amountUnits: '5000000',
    }),
    'function',
  );
  assert.equal(
    verifyTransaction(tx(NETWORK.contract, market('withdraw', [token, 6_000_000n])), NETWORK, {
      action: 'withdraw',
      token: 'USDC',
      amountUnits: '5000000',
    }),
    'args',
  );
  const bot = '0xb07000000000000000000000000000000000b075';
  assert.equal(
    verifyTransaction(tx(NETWORK.contract, market('setOperator', [bot, 6])), NETWORK, {
      action: 'setOperator',
      operator: bot,
      perms: 6,
    }),
    null,
  );
  assert.equal(
    verifyTransaction(tx(NETWORK.contract, market('setOperator', [bot, 15])), NETWORK, {
      action: 'setOperator',
      operator: bot,
      perms: 6,
    }),
    'args',
    'more permissions than ticked',
  );
  const matcher = '0x3a7c4e000000000000000000000000000000beef';
  const setMatcher = tx(NETWORK.contract, market('setMatcher', [matcher, 2_000_000_000n, false]));
  assert.equal(
    verifyTransaction(setMatcher, NETWORK, {
      action: 'setMatcher',
      matcher,
      maxPerOrderUnits: '2000000000',
      autoSettle: false,
    }),
    null,
  );
  assert.equal(
    verifyTransaction(setMatcher, NETWORK, {
      action: 'setMatcher',
      matcher: bot,
      maxPerOrderUnits: '2000000000',
    }),
    'args',
    "only the market's own matcher",
  );
  assert.equal(
    verifyTransaction(setMatcher, NETWORK, {
      action: 'setMatcher',
      matcher,
      maxPerOrderUnits: '2000000000',
      autoSettle: true,
    }),
    'args',
  );
});
