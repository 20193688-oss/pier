import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { tokenOf } from '@/chain/networks';
import {
  buildBalanceAction,
  buildOrderAction,
  isBalanceAction,
  MAX_I128,
  P2P_TRANSACTION_ACTIONS,
  permissionBits,
  type P2pBalanceContext,
  type P2pOrderContext,
} from '@/p2p/domain/transaction-actions';
import { call as fullCall } from '@test/unit/helpers/ops';

const call = (op: Parameters<typeof fullCall>[0]) => {
  const { fn, args } = fullCall(op);
  return { fn, args };
};

const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 1));
const MATCHER = Keypair.random().publicKey();
const ACCOUNT = Keypair.random().publicKey();
const BUYER = Keypair.random().publicKey();
const BOT = Keypair.random().publicKey();
const USDC = tokenOf('testnet', 'USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');

const balance = (overrides: Partial<P2pBalanceContext> = {}): P2pBalanceContext => ({
  contract: CONTRACT,
  from: ACCOUNT,
  matcher: MATCHER,
  token: (v) => (v.toUpperCase() === 'USDC' || v === USDC.contract ? USDC : null),
  sellsLiquidity: false,
  ...overrides,
});

const NOW = new Date('2026-11-19T12:00:00Z');

const orderCtx = (
  from: string,
  overrides: Partial<P2pOrderContext['order']> = {},
): P2pOrderContext => ({
  contract: CONTRACT,
  from,
  now: NOW,
  order: {
    id: 'o1',
    onchainId: '7',
    status: 'awaiting_payment',
    sellerAddress: ACCOUNT,
    buyerAddress: BUYER,
    tokenAmount: '1000000000',
    netAmount: '995000000',
    tokenSymbol: 'USDC',
    tokenDecimals: 7,
    acceptDeadline: null,
    paymentDeadline: new Date(NOW.getTime() + 60_000),
    ...overrides,
  },
});

describe('P2P transaction actions', () => {
  it('sorts every action into balance or order, and has no approve', () => {
    expect(P2P_TRANSACTION_ACTIONS.filter(isBalanceAction)).toEqual([
      'deposit',
      'withdraw',
      'setOperator',
      'setMatcher',
    ]);
    expect(P2P_TRANSACTION_ACTIONS).not.toContain('approve');
  });

  it('deposits and withdraws only listed tokens and positive i128 amounts, as the account', () => {
    const built = buildBalanceAction('deposit', { token: 'USDC', amount: '250000000' }, balance());
    if (!built.ok) throw new Error(built.error);
    expect(built.value.fn).toBe('deposit');
    expect(call(built.value.operation)).toEqual({
      fn: 'deposit',
      args: [ACCOUNT, USDC.contract, 250000000n],
    });
    expect(buildBalanceAction('withdraw', { token: 'DAI', amount: '1' }, balance()).ok).toBe(false);
    expect(buildBalanceAction('deposit', { token: 'USDC', amount: '0' }, balance()).ok).toBe(false);
    expect(
      buildBalanceAction(
        'deposit',
        { token: 'USDC', amount: (MAX_I128 + 1n).toString() },
        balance(),
      ).ok,
    ).toBe(false);
  });

  it('grants operator bits by number or by name, never to the account itself', () => {
    expect(permissionBits(['release', 'open'])).toBe(3);
    expect(permissionBits(16)).toBeNull();
    const built = buildBalanceAction(
      'setOperator',
      { operator: BOT, permissions: ['release'] },
      balance(),
    );
    if (!built.ok) throw new Error(built.error);
    expect(call(built.value.operation)).toEqual({ fn: 'set_operator', args: [ACCOUNT, BOT, 2] });
    expect(
      buildBalanceAction('setOperator', { operator: ACCOUNT, permissions: 2 }, balance()).ok,
    ).toBe(false);
    expect(
      buildBalanceAction('setOperator', { operator: '0xabc', permissions: 2 }, balance()).ok,
    ).toBe(false);
  });

  it('authorises only our matcher, and refuses autoSettle to a liquidity merchant', () => {
    const built = buildBalanceAction('setMatcher', { maxPerOrder: '50000000000' }, balance());
    if (!built.ok) throw new Error(built.error);
    expect(call(built.value.operation)).toEqual({
      fn: 'set_matcher',
      args: [ACCOUNT, MATCHER, 50000000000n, false],
    });
    expect(
      buildBalanceAction('setMatcher', { maxPerOrder: '1' }, balance({ matcher: null })).ok,
    ).toBe(false);
    expect(
      buildBalanceAction(
        'setMatcher',
        { maxPerOrder: '1', autoSettle: true },
        balance({ sellsLiquidity: true }),
      ).ok,
    ).toBe(false);
  });

  it('lets only the seller release, only the buyer mark paid, each as the acting address', () => {
    const release = buildOrderAction('release', orderCtx(ACCOUNT));
    if (!release.ok) throw new Error(release.error);
    expect(call(release.value.operation)).toEqual({ fn: 'release', args: [ACCOUNT, 7n] });
    expect(release.value.description).toContain('99.5 USDC');
    expect(buildOrderAction('release', orderCtx(BUYER)).ok).toBe(false);
    const paid = buildOrderAction('markPaid', orderCtx(BUYER));
    if (!paid.ok) throw new Error(paid.error);
    expect(call(paid.value.operation)).toEqual({ fn: 'mark_paid', args: [BUYER, 7n] });
    expect(buildOrderAction('markPaid', orderCtx(ACCOUNT)).ok).toBe(false);
  });

  it('lets a release operator release as itself, never anyone else', () => {
    const asBot = buildOrderAction('release', { ...orderCtx(BOT), releaseOperator: true });
    if (!asBot.ok) throw new Error(asBot.error);
    expect(call(asBot.value.operation)).toEqual({ fn: 'release', args: [BOT, 7n] });
    expect(buildOrderAction('release', orderCtx(BOT)).ok).toBe(false);
    expect(buildOrderAction('markPaid', { ...orderCtx(BOT), releaseOperator: true }).ok).toBe(
      false,
    );
  });

  it('follows the contract’s cancel rules', () => {
    expect(buildOrderAction('cancel', orderCtx(BUYER)).ok).toBe(true);
    expect(buildOrderAction('cancel', orderCtx(ACCOUNT)).ok).toBe(false);
    expect(
      buildOrderAction(
        'cancel',
        orderCtx(ACCOUNT, { paymentDeadline: new Date(NOW.getTime() - 1) }),
      ).ok,
    ).toBe(true);
    expect(buildOrderAction('cancel', orderCtx(ACCOUNT, { status: 'paid' })).ok).toBe(false);
    expect(buildOrderAction('cancel', orderCtx(BOT)).ok).toBe(false);
  });

  it('accepts and disputes only from the right status, and never before the order is open', () => {
    expect(buildOrderAction('accept', orderCtx(BUYER, { status: 'awaiting_acceptance' })).ok).toBe(
      true,
    );
    expect(buildOrderAction('accept', orderCtx(BUYER)).ok).toBe(false);
    expect(buildOrderAction('dispute', orderCtx(ACCOUNT, { status: 'paid' })).ok).toBe(true);
    expect(buildOrderAction('dispute', orderCtx(ACCOUNT)).ok).toBe(false);
    expect(buildOrderAction('release', orderCtx(ACCOUNT, { onchainId: null })).ok).toBe(false);
  });
});
