/* checkout.test.ts: the hosted charge page's trust boundary (src/lib/p2p/checkout.ts) and the shape
   check a transaction passes before a wallet is asked to send it (tx-check.ts). The page tells
   people where to send money: a malformed answer is an error, never half-shown, and a transaction
   aimed anywhere but the order's network and contract is never sent. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseAccount,
  parseCheckoutCharge,
  parseCheckoutOrder,
  parseCreatedOrder,
} from '@/lib/p2p/checkout';
import { checkTransaction, evmChainOf, explorerTx } from '@/lib/p2p/tx-check';

/* The checkout routes' charge and order, as the API answers them. */
const CHARGE = {
  id: 'cm3p2pchg0001l70g8v5q3z2w',
  network: 'base',
  tokenSymbol: 'USDC',
  currency: 'ARS',
  fiatAmount: '85000.00',
  description: 'Order #1042',
  merchantName: 'Tienda Salta',
  status: 'open',
  rails: ['ar_bank_transfer'],
  expiresAt: '2026-11-26T12:00:00.000Z',
};
const ORDER = {
  id: '5f0c2a9e-1b3d-4e5f-8a7b-9c0d1e2f3a4b',
  chargeId: CHARGE.id,
  status: 'awaiting_payment',
  currency: 'ARS',
  fiatAmount: '85000.00',
  rail: 'ar_bank_transfer',
  merchantName: 'Lumio Exchange',
  paymentDeadline: '2026-11-19T12:30:00.000Z',
  paymentDetails: {
    rail: 'ar_bank_transfer',
    holderName: 'Lumio Exchange SRL',
    details: { alias: 'lumio.pagos.ars', cuit: '30714209879' },
  },
  paidAt: null,
  createdAt: '2026-11-19T12:00:00.000Z',
};

test('a charge: every field checked, the symbol from tokenSymbol, rails possibly none', () => {
  assert.deepEqual(parseCheckoutCharge(CHARGE), {
    id: CHARGE.id,
    network: 'base',
    token: 'USDC',
    currency: 'ARS',
    fiatAmount: '85000.00',
    description: 'Order #1042',
    payeeName: 'Tienda Salta',
    status: 'open',
    rails: ['ar_bank_transfer'],
    expiresAt: CHARGE.expiresAt,
  });
  assert.equal(
    parseCheckoutCharge({ ...CHARGE, merchantName: undefined })?.payeeName,
    null,
    "the payee is the charge creator's name, when given",
  );
  assert.equal(
    parseCheckoutCharge({ ...CHARGE, merchantName: 'x'.repeat(61) }),
    null,
    '60 characters at most',
  );
  assert.deepEqual(
    parseCheckoutCharge({ ...CHARGE, rails: [] })?.rails,
    [],
    'no merchant takes it right now',
  );
  assert.equal(parseCheckoutCharge({ ...CHARGE, description: null })?.description, null);
  for (const bad of [
    { ...CHARGE, status: 'PENDING' },
    { ...CHARGE, currency: 'ars' },
    { ...CHARGE, fiatAmount: '1e5' },
    { ...CHARGE, fiatAmount: '1.234' },
    { ...CHARGE, rails: ['<x>'] },
    { ...CHARGE, rails: 'ar_bank_transfer' },
    { ...CHARGE, description: 'a\u0000b' },
    { ...CHARGE, expiresAt: 'soon' },
    { ...CHARGE, id: '../x' },
    { ...CHARGE, network: 'Base Main' },
    { ...CHARGE, tokenSymbol: undefined },
    null,
    [],
  ])
    assert.equal(parseCheckoutCharge(bad), null, JSON.stringify(bad));
});

test("the payer's order and the account to pay into: plain short strings under plain keys", () => {
  const o = parseCheckoutOrder(ORDER);
  assert.ok(o);
  assert.equal(o!.payBy, ORDER.paymentDeadline);
  assert.equal(o!.paymentDetails?.details.alias, 'lumio.pagos.ars');
  assert.equal(o!.paymentDetails?.document, null);
  assert.equal(o!.merchantName, 'Lumio Exchange');
  assert.equal(
    parseCheckoutOrder({ ...ORDER, paymentDetails: null })?.paymentDetails,
    null,
    'an order that ended shows no account',
  );
  for (const bad of [
    { ...ORDER, status: 'PAID' },
    { ...ORDER, paymentDetails: { ...ORDER.paymentDetails, details: { '<b>': 'x' } } },
    { ...ORDER, paymentDetails: { ...ORDER.paymentDetails, details: { alias: 'a\nb' } } },
    { ...ORDER, paymentDetails: { rail: 'x' } },
    { ...ORDER, paymentDeadline: 'tomorrow' },
    { ...ORDER, fiatAmount: 85000 },
    { ...ORDER, chargeId: '../x' },
  ])
    assert.equal(parseCheckoutOrder(bad), null, JSON.stringify(bad));
  assert.equal(
    parseAccount({ rail: 'br_pix', holderName: 'João', details: {} }),
    null,
    'an account has details',
  );
  // Opening it answers the order's own fields with the token beside them.
  const created = parseCreatedOrder({
    ...ORDER,
    payerToken: 'q3Jx8b2mNfV0tq9Lr5sD1uYc7wHk4eAa6zPgT0oXiEM',
  });
  assert.equal(created?.order.id, ORDER.id);
  assert.equal(created?.payerToken, 'q3Jx8b2mNfV0tq9Lr5sD1uYc7wHk4eAa6zPgT0oXiEM');
  assert.equal(parseCreatedOrder({ ...ORDER, payerToken: 'short' }), null);
  assert.equal(
    parseCreatedOrder({ order: ORDER, payerToken: 'q3Jx8b2mNfV0tq9Lr5sD1uYc7wHk4eAa6zPgT0oXiEM' }),
    null,
    'the answer is flat',
  );
});

const NETWORK = {
  id: 'base',
  name: 'Base',
  chainId: 8453,
  contract: '0x00000000000000000000000000000000000000c0',
  tokens: [{ symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 }],
  explorer: 'https://basescan.org',
  rpcUrl: 'https://mainnet.base.org',
  nativeSymbol: 'ETH',
};
const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');

test("a transaction is sent only to the order's network and contract (or, to approve, the token)", () => {
  const release = {
    chainId: 8453,
    to: NETWORK.contract,
    data: `0x37bdc99b${word('1')}`,
    value: '0',
    action: 'release',
  };
  assert.equal(checkTransaction(release, NETWORK), null);
  assert.equal(checkTransaction({ ...release, chainId: 1 }, NETWORK), 'chain');
  assert.equal(
    checkTransaction({ ...release, to: '0x00000000000000000000000000000000000000c1' }, NETWORK),
    'target',
  );
  assert.equal(checkTransaction({ ...release, value: '1000' }, NETWORK), 'value');
  assert.equal(checkTransaction({ ...release, data: '0x' }, NETWORK), 'shape');
  assert.equal(checkTransaction(null, NETWORK), 'shape');
  const approve = {
    chainId: 8453,
    to: NETWORK.tokens[0].address,
    data: `0x095ea7b3${word(NETWORK.contract)}${word('ff')}`,
    value: '0',
    action: 'approve',
  };
  assert.equal(checkTransaction(approve, NETWORK, 'USDC'), null);
  assert.equal(
    checkTransaction(approve, NETWORK),
    'target',
    'an approval needs the token it may approve',
  );
  assert.equal(
    checkTransaction(
      {
        ...approve,
        data: `0x095ea7b3${word('0x00000000000000000000000000000000000000ee')}${word('ff')}`,
      },
      NETWORK,
      'USDC',
    ),
    'target',
    'the spender must be the market',
  );
  assert.equal(checkTransaction({ ...approve, to: NETWORK.contract }, NETWORK, 'USDC'), 'target');
  assert.deepEqual(evmChainOf(NETWORK), {
    chainId: 8453,
    chainName: 'Base',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorerUrls: ['https://basescan.org'],
  });
  assert.equal(evmChainOf({ ...NETWORK, rpcUrl: 'http://x' }), undefined);
  assert.equal(
    explorerTx(NETWORK, `0x${'a'.repeat(64)}`),
    `https://basescan.org/tx/0x${'a'.repeat(64)}`,
  );
  assert.equal(explorerTx(NETWORK, '0x1'), null);
  assert.equal(explorerTx({ explorer: 'javascript:alert(1)' }, `0x${'a'.repeat(64)}`), null);
});

test('the payee may come as payeeName; ids may use underscores', () => {
  assert.equal(
    parseCheckoutCharge({ ...CHARGE, merchantName: undefined, payeeName: 'Tienda Lerma' })
      ?.payeeName,
    'Tienda Lerma',
  );
  assert.equal(parseCheckoutCharge({ ...CHARGE, id: 'ch_pedido1042' })?.id, 'ch_pedido1042');
});

test('the local development chain may use an http RPC on this machine, nothing else may', () => {
  const local = {
    ...NETWORK,
    chainId: 31337,
    name: 'Local',
    rpcUrl: 'http://127.0.0.1:8545',
    explorer: null,
  };
  assert.equal(evmChainOf(local)?.rpcUrls[0], 'http://127.0.0.1:8545');
  assert.equal(evmChainOf({ ...local, rpcUrl: 'http://10.0.0.2:8545' }), undefined);
  assert.equal(evmChainOf({ ...local, chainId: 1 }), undefined);
});
