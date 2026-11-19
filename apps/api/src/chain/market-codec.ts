import { P2P_MARKET_ARTIFACT } from '@pedospe/contracts';
import {
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  toEventSelector,
  zeroAddress,
  type AbiEvent,
  type Hex,
} from 'viem';

/**
 * The `P2PMarket` codec: calldata, views and events, all through viem over the
 * committed artifact's ABI (never hand-encoded words). A test runs this codec
 * against the contract itself in an in-process EVM.
 */

export const MARKET_ABI = P2P_MARKET_ARTIFACT.abi;
export const ZERO_ADDRESS = zeroAddress;

/** `OpenParams`, as `open` and `openWithDeposit` take it. */
export interface P2pOpenParams {
  ref: string;
  seller: string;
  buyer: string;
  token: string;
  amount: bigint;
  bond: bigint;
  acceptWindow: number;
  paymentWindow: number;
  settleWindow: number;
  /** The zero address for none. */
  integrator: string;
  integratorFeeBps: number;
}

/** The actions that take only an order id. */
export type P2pOrderAction = 'accept' | 'markPaid' | 'release' | 'settle' | 'cancel' | 'dispute';

const hex = (value: string) => value as Hex;
const addr = (value: string) => getAddress(value);

function openTuple(p: P2pOpenParams) {
  return {
    ref: hex(p.ref),
    seller: addr(p.seller),
    buyer: addr(p.buyer),
    token: addr(p.token),
    amount: p.amount,
    bond: p.bond,
    acceptWindow: p.acceptWindow,
    paymentWindow: p.paymentWindow,
    settleWindow: p.settleWindow,
    integrator: addr(p.integrator),
    integratorFeeBps: p.integratorFeeBps,
  };
}

function call(functionName: string, args: readonly unknown[] = []): Hex {
  return encodeFunctionData({
    abi: MARKET_ABI,
    functionName,
    args,
  } as Parameters<typeof encodeFunctionData>[0]);
}

export const p2pCalldata = {
  deposit: (token: string, amount: bigint) => call('deposit', [addr(token), amount]),
  withdraw: (token: string, amount: bigint) => call('withdraw', [addr(token), amount]),
  withdrawFor: (account: string, token: string, amount: bigint) =>
    call('withdrawFor', [addr(account), addr(token), amount]),
  setOperator: (operator: string, permissions: number) =>
    call('setOperator', [addr(operator), permissions]),
  setMatcher: (matcher: string, maxPerOrder: bigint, autoSettle: boolean) =>
    call('setMatcher', [addr(matcher), maxPerOrder, autoSettle]),
  open: (p: P2pOpenParams) => call('open', [openTuple(p)]),
  openWithDeposit: (p: P2pOpenParams) => call('openWithDeposit', [openTuple(p)]),
  orderAction: (action: P2pOrderAction, id: bigint) => call(action, [id]),
  resolve: (id: bigint, toBuyer: bigint, bondToSeller: bigint) =>
    call('resolve', [id, toBuyer, bondToSeller]),
  getOrder: (id: bigint) => call('getOrder', [id]),
  orderIdOf: (opener: string, ref: string) => call('orderIdOf', [addr(opener), hex(ref)]),
  balanceOf: (account: string, token: string) => call('balanceOf', [addr(account), addr(token)]),
  permissionsOf: (account: string, operator: string) =>
    call('permissionsOf', [addr(account), addr(operator)]),
  matcherTermsOf: (seller: string, matcher: string) =>
    call('matcherTermsOf', [addr(seller), addr(matcher)]),
  tokenAllowed: (token: string) => call('tokenAllowed', [addr(token)]),
  protocolFeeBps: () => call('protocolFeeBps'),
  paused: () => call('paused'),
  owner: () => call('owner'),
  arbiter: () => call('arbiter'),
  treasury: () => call('treasury'),
  setToken: (token: string, allowed: boolean) => call('setToken', [addr(token), allowed]),
  transferOwnership: (to: string) => call('transferOwnership', [addr(to)]),
};

/** An ERC-20 `approve(spender, amount)`: the exact amount, never unlimited. */
export function approveCalldata(spender: string, amount: bigint): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [addr(spender), amount],
  });
}

/** The init code of a P2PMarket with these constructor arguments. */
export function marketInitCode(args: {
  owner: string;
  treasury: string;
  arbiter: string;
  feeBps: number;
}): Hex {
  return encodeDeployData({
    abi: MARKET_ABI,
    bytecode: P2P_MARKET_ARTIFACT.bytecode as Hex,
    args: [addr(args.owner), addr(args.treasury), addr(args.arbiter), args.feeBps],
  } as Parameters<typeof encodeDeployData>[0]);
}

// --- views ---------------------------------------------------------------------

/** The contract's order statuses, in declaration order. */
export const P2P_CHAIN_STATUSES = [
  'None',
  'Offered',
  'Active',
  'Paid',
  'Disputed',
  'Released',
  'Cancelled',
  'Resolved',
] as const;
export type P2pChainStatus = (typeof P2P_CHAIN_STATUSES)[number];

/** `getOrder(id)`, as the contract stores it. */
export interface P2pChainOrder {
  seller: string;
  acceptDeadline: number;
  paymentDeadline: number;
  status: P2pChainStatus;
  fromBalance: boolean;
  buyer: string;
  paidAt: number;
  paymentWindow: number;
  feeBps: number;
  viaMatcher: boolean;
  token: string;
  settleWindow: number;
  integratorFeeBps: number;
  opener: string;
  integrator: string;
  amount: bigint;
  bond: bigint;
  ref: string;
}

function decodeResult(functionName: string, data: string): unknown {
  return decodeFunctionResult({
    abi: MARKET_ABI,
    functionName,
    data: hex(data),
  } as Parameters<typeof decodeFunctionResult>[0]);
}

export function decodeChainOrder(data: string): P2pChainOrder {
  const o = decodeResult('getOrder', data) as Record<string, unknown>;
  const status = P2P_CHAIN_STATUSES[Number(o.status)];
  if (!status) throw new Error(`unknown order status ${String(o.status)}`);
  return {
    seller: o.seller as string,
    acceptDeadline: Number(o.acceptDeadline),
    paymentDeadline: Number(o.paymentDeadline),
    status,
    fromBalance: o.fromBalance as boolean,
    buyer: o.buyer as string,
    paidAt: Number(o.paidAt),
    paymentWindow: Number(o.paymentWindow),
    feeBps: Number(o.feeBps),
    viaMatcher: o.viaMatcher as boolean,
    token: o.token as string,
    settleWindow: Number(o.settleWindow),
    integratorFeeBps: Number(o.integratorFeeBps),
    opener: o.opener as string,
    integrator: o.integrator as string,
    amount: o.amount as bigint,
    bond: o.bond as bigint,
    ref: o.ref as string,
  };
}

export interface P2pMatcherTerms {
  maxPerOrder: bigint;
  autoSettle: boolean;
}

export function decodeMatcherTerms(data: string): P2pMatcherTerms {
  const t = decodeResult('matcherTermsOf', data) as { maxPerOrder: bigint; autoSettle: boolean };
  return { maxPerOrder: t.maxPerOrder, autoSettle: t.autoSettle };
}

/** A view's single return value (`balanceOf`, `protocolFeeBps`, `paused`, `arbiter`...). */
export function decodeView<T>(functionName: string, data: string): T {
  return decodeResult(functionName, data) as T;
}

// --- events ----------------------------------------------------------------------

export type P2pMarketEvent =
  | { name: 'OperatorSet'; account: string; operator: string; permissions: number }
  | {
      name: 'MatcherSet';
      seller: string;
      matcher: string;
      maxPerOrder: bigint;
      autoSettle: boolean;
    }
  | {
      name: 'OrderOpened';
      id: bigint;
      opener: string;
      ref: string;
      seller: string;
      buyer: string;
      token: string;
      amount: bigint;
      bond: bigint;
      viaMatcher: boolean;
    }
  | { name: 'OrderAccepted'; id: bigint; paymentDeadline: number }
  | { name: 'OrderPaid'; id: bigint; by: string }
  | {
      name: 'OrderReleased';
      id: bigint;
      by: string;
      toBuyer: bigint;
      protocolFee: bigint;
      integratorFee: bigint;
    }
  | { name: 'OrderCancelled'; id: bigint; by: string }
  | { name: 'OrderDisputed'; id: bigint; by: string }
  | {
      name: 'OrderResolved';
      id: bigint;
      toBuyer: bigint;
      toSeller: bigint;
      bondToSeller: bigint;
      protocolFee: bigint;
      integratorFee: bigint;
    };
export type P2pMarketEventName = P2pMarketEvent['name'];

export const P2P_EVENT_NAMES = [
  'OperatorSet',
  'MatcherSet',
  'OrderOpened',
  'OrderAccepted',
  'OrderPaid',
  'OrderReleased',
  'OrderCancelled',
  'OrderDisputed',
  'OrderResolved',
] as const satisfies readonly P2pMarketEventName[];

/** topic0 of each event the indexer reads. */
export const P2P_EVENT_TOPICS = Object.fromEntries(
  P2P_EVENT_NAMES.map((name) => {
    const event = MARKET_ABI.find((item) => item.type === 'event' && item.name === name) as
      AbiEvent | undefined;
    if (!event) throw new Error(`P2PMarket ABI has no event ${name}`);
    return [name, toEventSelector(event)];
  }),
) as Record<P2pMarketEventName, Hex>;

const NAME_BY_TOPIC = new Map(
  Object.entries(P2P_EVENT_TOPICS).map(([name, topic]) => [topic.toLowerCase(), name]),
);

/** A log as `eth_getLogs` answers it (only the parts decoding reads). */
export interface P2pRawLog {
  topics: readonly string[];
  data: string;
}

/**
 * Decodes one of the contract's logs, or answers null for a log that is not
 * one of {@link P2P_EVENT_NAMES}. Throws on a log whose topic0 matches but
 * whose shape does not (strict decoding): that is not this contract, and the
 * indexer must not guess.
 */
export function decodeP2pMarketLog(log: P2pRawLog): P2pMarketEvent | null {
  const topic0 = (log.topics[0] ?? '').toLowerCase();
  if (!NAME_BY_TOPIC.has(topic0)) return null;
  const decoded = decodeEventLog({
    abi: MARKET_ABI,
    topics: log.topics as [Hex, ...Hex[]],
    data: hex(log.data),
    strict: true,
  } as Parameters<typeof decodeEventLog>[0]) as {
    eventName: string;
    args: Record<string, unknown>;
  };
  const a = decoded.args;
  switch (decoded.eventName) {
    case 'OperatorSet':
      return {
        name: 'OperatorSet',
        account: a.account as string,
        operator: a.operator as string,
        permissions: Number(a.permissions),
      };
    case 'MatcherSet':
      return {
        name: 'MatcherSet',
        seller: a.seller as string,
        matcher: a.matcher as string,
        maxPerOrder: a.maxPerOrder as bigint,
        autoSettle: a.autoSettle as boolean,
      };
    case 'OrderOpened':
      return {
        name: 'OrderOpened',
        id: a.id as bigint,
        opener: a.opener as string,
        ref: (a.ref as string).toLowerCase(),
        seller: a.seller as string,
        buyer: a.buyer as string,
        token: a.token as string,
        amount: a.amount as bigint,
        bond: a.bond as bigint,
        viaMatcher: a.viaMatcher as boolean,
      };
    case 'OrderAccepted':
      return {
        name: 'OrderAccepted',
        id: a.id as bigint,
        paymentDeadline: Number(a.paymentDeadline),
      };
    case 'OrderPaid':
    case 'OrderCancelled':
    case 'OrderDisputed':
      return { name: decoded.eventName, id: a.id as bigint, by: a.by as string };
    case 'OrderReleased':
      return {
        name: 'OrderReleased',
        id: a.id as bigint,
        by: a.by as string,
        toBuyer: a.toBuyer as bigint,
        protocolFee: a.protocolFee as bigint,
        integratorFee: a.integratorFee as bigint,
      };
    case 'OrderResolved':
      return {
        name: 'OrderResolved',
        id: a.id as bigint,
        toBuyer: a.toBuyer as bigint,
        toSeller: a.toSeller as bigint,
        bondToSeller: a.bondToSeller as bigint,
        protocolFee: a.protocolFee as bigint,
        integratorFee: a.integratorFee as bigint,
      };
    default:
      return null;
  }
}

/**
 * The name of the contract error a revert carries (`InsufficientBalance`), or
 * null when the data is not one of them.
 */
export function p2pRevertName(data: unknown): string | null {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{8}/.test(data)) return null;
  try {
    const decoded = decodeErrorResult({ abi: MARKET_ABI, data: hex(data) } as Parameters<
      typeof decodeErrorResult
    >[0]);
    return decoded.errorName === 'Error' ? null : decoded.errorName;
  } catch {
    return null;
  }
}
