import { P2P_MARKET_ARTIFACT } from '@pedospe/contracts';
import {
  InProcessEvm,
  addressOf,
  compileContract,
  type CompiledContract,
  type DeployedContract,
  type RawLog,
} from '@pedospe/contracts/testing';
import { encodeDeployData, keccak256, toHex, zeroAddress, type Abi, type Hex } from 'viem';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MARKET_ABI,
  approveCalldata,
  decodeChainOrder,
  decodeMatcherTerms,
  decodeP2pMarketLog,
  decodeView,
  marketInitCode,
  p2pCalldata,
  p2pRevertName,
  P2P_EVENT_TOPICS,
  type P2pMarketEvent,
  type P2pOpenParams,
} from '@/chain/market-codec';

/**
 * The API's codec run against the contract itself: every call below is OUR
 * calldata (`p2pCalldata`, `approveCalldata`) executed raw in an in-process
 * EVM, and every log is read back by OUR decoder, field by field. A codec
 * that drifted from the deployed bytecode fails here, not on a real chain.
 */

const U = 1_000_000n;
const OWNER = addressOf('owner');
const TREASURY = addressOf('treasury');
const ARBITER = addressOf('arbiter');
const MATCHER = addressOf('matcher');
const MERCHANT = addressOf('merchant');
const BUYER = addressOf('buyer');
const USER = addressOf('user');
const INTEGRATOR = addressOf('integrator');
const BOT = addressOf('bot');

let TOKEN_SOURCE: CompiledContract;
let evm: InProcessEvm;
let market: DeployedContract;
let token: DeployedContract;

const ARTIFACT: CompiledContract = {
  abi: P2P_MARKET_ARTIFACT.abi as unknown as Abi,
  bytecode: P2P_MARKET_ARTIFACT.bytecode as Hex,
};

async function raw(from: Hex, to: Hex, data: Hex) {
  const result = await evm.callRaw(from, to, data);
  if (!result.ok) {
    throw new Error(`call reverted: ${p2pRevertName(result.returned) ?? result.returned}`);
  }
  return result;
}

function events(logs: RawLog[]): P2pMarketEvent[] {
  return logs
    .filter((l) => l.address.toLowerCase() === market.address.toLowerCase())
    .map((l) => decodeP2pMarketLog(l))
    .filter((e): e is P2pMarketEvent => e !== null);
}

function params(overrides: Partial<P2pOpenParams> = {}): P2pOpenParams {
  return {
    ref: keccak256(toHex('order-1')),
    seller: MERCHANT,
    buyer: BUYER,
    token: token.address,
    amount: 100n * U,
    bond: 0n,
    acceptWindow: 0,
    paymentWindow: 1800,
    settleWindow: 0,
    integrator: INTEGRATOR,
    integratorFeeBps: 25,
    ...overrides,
  };
}

beforeAll(() => {
  TOKEN_SOURCE = compileContract('test/P2PTestToken.sol', 'P2PTestToken');
});

beforeEach(async () => {
  evm = await InProcessEvm.create();
  market = await evm.deploy(OWNER, ARTIFACT, [OWNER, TREASURY, ARBITER, 50]);
  token = await evm.deploy(OWNER, TOKEN_SOURCE);
  await raw(OWNER, market.address, p2pCalldata.setToken(token.address, true));
  for (const who of [MERCHANT, USER]) {
    await token.must(OWNER, 'mint', [who, 1_000n * U]);
  }
  // The merchant funds its balance with our approve + deposit calldata.
  await raw(MERCHANT, token.address, approveCalldata(market.address, 500n * U));
  await raw(MERCHANT, market.address, p2pCalldata.deposit(token.address, 500n * U));
});

describe('market codec against the contract', () => {
  it('builds init code that deploys the committed artifact', () => {
    const args = { owner: OWNER, treasury: TREASURY, arbiter: ARBITER, feeBps: 50 };
    expect(marketInitCode(args)).toBe(
      encodeDeployData({
        abi: ARTIFACT.abi,
        bytecode: ARTIFACT.bytecode,
        args: [OWNER, TREASURY, ARBITER, 50],
      }),
    );
  });

  it('reads the views it encodes', async () => {
    const balance = await raw(USER, market.address, p2pCalldata.balanceOf(MERCHANT, token.address));
    expect(decodeView<bigint>('balanceOf', balance.returned)).toBe(500n * U);
    const fee = await raw(USER, market.address, p2pCalldata.protocolFeeBps());
    expect(decodeView<number>('protocolFeeBps', fee.returned)).toBe(50);
    const allowed = await raw(USER, market.address, p2pCalldata.tokenAllowed(token.address));
    expect(decodeView<boolean>('tokenAllowed', allowed.returned)).toBe(true);
    const arbiter = await raw(USER, market.address, p2pCalldata.arbiter());
    expect(decodeView<string>('arbiter', arbiter.returned)).toBe(ARBITER);
  });

  it('authorises the matcher and decodes MatcherSet and the terms', async () => {
    const set = await raw(
      MERCHANT,
      market.address,
      p2pCalldata.setMatcher(MATCHER, 200n * U, false),
    );
    expect(events(set.logs)).toEqual([
      {
        name: 'MatcherSet',
        seller: MERCHANT,
        matcher: MATCHER,
        maxPerOrder: 200n * U,
        autoSettle: false,
      },
    ]);
    const terms = await raw(USER, market.address, p2pCalldata.matcherTermsOf(MERCHANT, MATCHER));
    expect(decodeMatcherTerms(terms.returned)).toEqual({
      maxPerOrder: 200n * U,
      autoSettle: false,
    });
  });

  it('opens a purchase through the matcher and reads every event back', async () => {
    await raw(MERCHANT, market.address, p2pCalldata.setMatcher(MATCHER, 200n * U, false));
    const p = params();
    const opened = await raw(MATCHER, market.address, p2pCalldata.open(p));
    const [openedEvent, accepted] = events(opened.logs);
    expect(openedEvent).toEqual({
      name: 'OrderOpened',
      id: 1n,
      opener: MATCHER,
      ref: p.ref.toLowerCase(),
      seller: MERCHANT,
      buyer: BUYER,
      token: token.address,
      amount: 100n * U,
      bond: 0n,
      viaMatcher: true,
    });
    expect(accepted).toMatchObject({ name: 'OrderAccepted', id: 1n });

    const idOf = await raw(USER, market.address, p2pCalldata.orderIdOf(MATCHER, p.ref));
    expect(decodeView<bigint>('orderIdOf', idOf.returned)).toBe(1n);
    const stored = decodeChainOrder(
      (await raw(USER, market.address, p2pCalldata.getOrder(1n))).returned,
    );
    expect(stored).toMatchObject({
      seller: MERCHANT,
      buyer: BUYER,
      status: 'Active',
      fromBalance: true,
      viaMatcher: true,
      paymentWindow: 1800,
      settleWindow: 0,
      feeBps: 50,
      integrator: INTEGRATOR,
      integratorFeeBps: 25,
      opener: MATCHER,
      amount: 100n * U,
      bond: 0n,
      ref: p.ref.toLowerCase(),
    });

    const paid = await raw(MATCHER, market.address, p2pCalldata.orderAction('markPaid', 1n));
    expect(events(paid.logs)).toEqual([{ name: 'OrderPaid', id: 1n, by: MATCHER }]);
    const released = await raw(MERCHANT, market.address, p2pCalldata.orderAction('release', 1n));
    expect(events(released.logs)).toEqual([
      {
        name: 'OrderReleased',
        id: 1n,
        by: MERCHANT,
        toBuyer: 100n * U - (100n * U * 75n) / 10_000n,
        protocolFee: (100n * U * 50n) / 10_000n,
        integratorFee: (100n * U * 25n) / 10_000n,
      },
    ]);
  });

  it('opens a sale with a deposit, then accept, dispute and resolve', async () => {
    const p = params({
      ref: keccak256(toHex('sale-1')),
      seller: USER,
      buyer: MERCHANT,
      bond: 10n * U,
      acceptWindow: 300,
      settleWindow: 6 * 3600,
      integrator: zeroAddress,
      integratorFeeBps: 0,
    });
    await raw(USER, token.address, approveCalldata(market.address, p.amount));
    const opened = await raw(USER, market.address, p2pCalldata.openWithDeposit(p));
    expect(events(opened.logs)).toEqual([
      {
        name: 'OrderOpened',
        id: 1n,
        opener: USER,
        ref: p.ref.toLowerCase(),
        seller: USER,
        buyer: MERCHANT,
        token: token.address,
        amount: 100n * U,
        bond: 10n * U,
        viaMatcher: false,
      },
    ]);
    const accepted = await raw(MERCHANT, market.address, p2pCalldata.orderAction('accept', 1n));
    expect(events(accepted.logs)).toEqual([
      { name: 'OrderAccepted', id: 1n, paymentDeadline: Number(evm.now) + 1800 },
    ]);
    await raw(MERCHANT, market.address, p2pCalldata.orderAction('markPaid', 1n));
    const disputed = await raw(USER, market.address, p2pCalldata.orderAction('dispute', 1n));
    expect(events(disputed.logs)).toEqual([{ name: 'OrderDisputed', id: 1n, by: USER }]);
    const resolved = await raw(ARBITER, market.address, p2pCalldata.resolve(1n, 40n * U, 5n * U));
    expect(events(resolved.logs)).toEqual([
      {
        name: 'OrderResolved',
        id: 1n,
        toBuyer: 40n * U,
        toSeller: 60n * U,
        bondToSeller: 5n * U,
        protocolFee: (40n * U * 50n) / 10_000n,
        integratorFee: 0n,
      },
    ]);
  });

  it('decodes cancellations and operator grants', async () => {
    const granted = await raw(MERCHANT, market.address, p2pCalldata.setOperator(BOT, 2 | 4));
    expect(events(granted.logs)).toEqual([
      { name: 'OperatorSet', account: MERCHANT, operator: BOT, permissions: 6 },
    ]);
    await raw(MERCHANT, market.address, p2pCalldata.setMatcher(MATCHER, 200n * U, false));
    await raw(MATCHER, market.address, p2pCalldata.open(params()));
    const cancelled = await raw(MATCHER, market.address, p2pCalldata.orderAction('cancel', 1n));
    expect(events(cancelled.logs)).toEqual([{ name: 'OrderCancelled', id: 1n, by: MATCHER }]);
  });

  it('names the contract error of a revert', async () => {
    const over = await evm.callRaw(MATCHER, market.address, p2pCalldata.open(params()));
    expect(over.ok).toBe(false);
    expect(p2pRevertName(over.returned)).toBe('NotAuthorized');
    await raw(MERCHANT, market.address, p2pCalldata.setMatcher(MATCHER, 10_000n * U, false));
    const short = await evm.callRaw(
      MATCHER,
      market.address,
      p2pCalldata.open(params({ amount: 900n * U })),
    );
    expect(p2pRevertName(short.returned)).toBe('InsufficientBalance');
    expect(p2pRevertName('0x')).toBeNull();
    expect(p2pRevertName('0xdeadbeef')).toBeNull();
  });

  it('ignores foreign logs and refuses a malformed log of its own events', () => {
    expect(decodeP2pMarketLog({ topics: [keccak256(toHex('Other()'))], data: '0x' })).toBeNull();
    expect(() =>
      decodeP2pMarketLog({ topics: [P2P_EVENT_TOPICS.OrderPaid], data: '0x' }),
    ).toThrow();
  });

  it('carries a topic for every event the indexer reads', () => {
    const fromAbi = MARKET_ABI.filter((i) => i.type === 'event').map((i) => i.name);
    for (const name of Object.keys(P2P_EVENT_TOPICS)) expect(fromAbi).toContain(name);
  });
});
