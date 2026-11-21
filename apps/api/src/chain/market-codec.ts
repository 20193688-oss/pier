import { MARKET_ERRORS, MARKET_SPEC } from '@pier/contracts';
import { contract, Operation, StrKey, xdr } from '@stellar/stellar-sdk';

/**
 * The `P2PMarket` codec: arguments, results, events and errors, all through
 * stellar-sdk's `contract.Spec` over the committed artifact's spec (never
 * hand-encoded values). Names and shapes follow docs/STELLAR.md section 4.
 */

export const MARKET = new contract.Spec([...MARKET_SPEC]);

/** `OpenParams`, as `open` and `open_with_deposit` take it. */
export interface P2pOpenParams {
  /** 32 bytes, hex (no 0x). */
  refId: string;
  seller: string;
  buyer: string;
  token: string;
  amount: bigint;
  bond: bigint;
  acceptWindow: number;
  paymentWindow: number;
  settleWindow: number;
  /** Null for none. */
  integrator: string | null;
  integratorFeeBps: number;
}

/** The actions that take an acting address and an order id. */
export type P2pOrderAction = 'accept' | 'mark_paid' | 'release' | 'cancel' | 'dispute';

/** The market functions a wallet (or the matcher) may be sponsored for. */
export const MARKET_USER_FUNCTIONS = [
  'deposit',
  'withdraw',
  'withdraw_for',
  'set_operator',
  'set_matcher',
  'open',
  'open_with_deposit',
  'accept',
  'mark_paid',
  'release',
  'cancel',
  'dispute',
  'settle',
] as const;

export function openParamsArg(p: P2pOpenParams): Record<string, unknown> {
  return {
    ref_id: Buffer.from(p.refId, 'hex'),
    seller: p.seller,
    buyer: p.buyer,
    token: p.token,
    amount: p.amount,
    bond: p.bond,
    accept_window: p.acceptWindow,
    payment_window: p.paymentWindow,
    settle_window: p.settleWindow,
    integrator: p.integrator ?? undefined,
    integrator_fee_bps: p.integratorFeeBps,
  };
}

/** A function's arguments, by the spec's parameter names, as `ScVal`s. */
export function marketArgs(fn: string, args: Record<string, unknown>): xdr.ScVal[] {
  return MARKET.funcArgsToScVals(fn, args);
}

/** One `invokeContract` operation on the market. */
export function marketOperation(
  contractId: string,
  fn: string,
  args: Record<string, unknown> = {},
): xdr.Operation {
  return Operation.invokeContractFunction({
    contract: contractId,
    function: fn,
    args: marketArgs(fn, args),
  });
}

/** The market's calls, by what they do. */
export const p2pCall = {
  deposit: (c: string, account: string, token: string, amount: bigint) =>
    marketOperation(c, 'deposit', { account, token, amount }),
  withdraw: (c: string, account: string, token: string, amount: bigint) =>
    marketOperation(c, 'withdraw', { account, token, amount }),
  withdrawFor: (c: string, operator: string, account: string, token: string, amount: bigint) =>
    marketOperation(c, 'withdraw_for', { operator, account, token, amount }),
  setOperator: (c: string, account: string, operator: string, perms: number) =>
    marketOperation(c, 'set_operator', { account, operator, perms }),
  setMatcher: (
    c: string,
    seller: string,
    matcher: string,
    maxPerOrder: bigint,
    autoSettle: boolean,
  ) =>
    marketOperation(c, 'set_matcher', {
      seller,
      matcher,
      max_per_order: maxPerOrder,
      auto_settle: autoSettle,
    }),
  open: (c: string, caller: string, p: P2pOpenParams) =>
    marketOperation(c, 'open', { caller, p: openParamsArg(p) }),
  openWithDeposit: (c: string, p: P2pOpenParams) =>
    marketOperation(c, 'open_with_deposit', { p: openParamsArg(p) }),
  orderAction: (c: string, action: P2pOrderAction, caller: string, id: bigint) =>
    marketOperation(c, action, { caller, id }),
  settle: (c: string, id: bigint) => marketOperation(c, 'settle', { id }),
  resolve: (c: string, id: bigint, toBuyer: bigint, bondToSeller: bigint) =>
    marketOperation(c, 'resolve', { id, to_buyer: toBuyer, bond_to_seller: bondToSeller }),
  setToken: (c: string, token: string, allowed: boolean) =>
    marketOperation(c, 'set_token', { token, allowed }),
  transferOwnership: (c: string, to: string) => marketOperation(c, 'transfer_ownership', { to }),
  // views
  config: (c: string) => marketOperation(c, 'config'),
  getOrder: (c: string, id: bigint) => marketOperation(c, 'get_order', { id }),
  orderIdOf: (c: string, opener: string, refId: string) =>
    marketOperation(c, 'order_id_of', { opener, ref_id: Buffer.from(refId, 'hex') }),
  balanceOf: (c: string, account: string, token: string) =>
    marketOperation(c, 'balance_of', { account, token }),
  permissionsOf: (c: string, account: string, operator: string) =>
    marketOperation(c, 'permissions_of', { account, operator }),
  matcherTermsOf: (c: string, seller: string, matcher: string) =>
    marketOperation(c, 'matcher_terms_of', { seller, matcher }),
  tokenAllowed: (c: string, token: string) => marketOperation(c, 'token_allowed', { token }),
  orderCount: (c: string) => marketOperation(c, 'order_count'),
};

/** A function's return value as a JS value (bigint for i128/u64). */
export function decodeResult<T>(fn: string, value: xdr.ScVal): T {
  return MARKET.funcResToNative(fn, value) as T;
}

// --- native value helpers --------------------------------------------------------

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v));
const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : BigInt(str(v)));
const num = (v: unknown): number => Number(v);
const optStr = (v: unknown): string | null => (v === undefined || v === null ? null : str(v));
const hex = (v: unknown): string =>
  v instanceof Uint8Array
    ? Buffer.from(v).toString('hex')
    : str(v).replace(/^0x/, '').toLowerCase();

// --- views ------------------------------------------------------------------------

/** The contract's order statuses, by their `#[repr(u32)]` value. */
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

function statusOf(v: unknown): P2pChainStatus {
  if (typeof v === 'string' && (P2P_CHAIN_STATUSES as readonly string[]).includes(v)) {
    return v as P2pChainStatus;
  }
  const status = P2P_CHAIN_STATUSES[num(v)];
  if (!status) throw new Error(`unknown order status ${str(v)}`);
  return status;
}

/** `get_order(id)`, as the contract stores it. */
export interface P2pChainOrder {
  seller: string;
  buyer: string;
  token: string;
  opener: string;
  integrator: string | null;
  amount: bigint;
  bond: bigint;
  status: P2pChainStatus;
  fromBalance: boolean;
  viaMatcher: boolean;
  feeBps: number;
  integratorFeeBps: number;
  acceptDeadline: number;
  paymentDeadline: number;
  paidAt: number;
  paymentWindow: number;
  settleWindow: number;
  /** Hex, no 0x. */
  refId: string;
}

export function toChainOrder(o: Record<string, unknown>): P2pChainOrder {
  return {
    seller: str(o.seller),
    buyer: str(o.buyer),
    token: str(o.token),
    opener: str(o.opener),
    integrator: optStr(o.integrator),
    amount: big(o.amount),
    bond: big(o.bond),
    status: statusOf(o.status),
    fromBalance: Boolean(o.from_balance),
    viaMatcher: Boolean(o.via_matcher),
    feeBps: num(o.fee_bps),
    integratorFeeBps: num(o.integrator_fee_bps),
    acceptDeadline: num(o.accept_deadline),
    paymentDeadline: num(o.payment_deadline),
    paidAt: num(o.paid_at ?? 0),
    paymentWindow: num(o.payment_window),
    settleWindow: num(o.settle_window),
    refId: hex(o.ref_id),
  };
}

export interface P2pMatcherTerms {
  maxPerOrder: bigint;
  autoSettle: boolean;
}

export function toMatcherTerms(t: Record<string, unknown>): P2pMatcherTerms {
  return { maxPerOrder: big(t.max_per_order), autoSettle: Boolean(t.auto_settle) };
}

export interface P2pMarketConfig {
  owner: string;
  pendingOwner: string | null;
  treasury: string;
  arbiter: string;
  protocolFeeBps: number;
  paused: boolean;
}

export function toMarketConfig(c: Record<string, unknown>): P2pMarketConfig {
  return {
    owner: str(c.owner),
    pendingOwner: optStr(c.pending_owner),
    treasury: str(c.treasury),
    arbiter: str(c.arbiter),
    protocolFeeBps: num(c.protocol_fee_bps),
    paused: Boolean(c.paused),
  };
}

// --- events ----------------------------------------------------------------------

export type P2pMarketEvent =
  | { name: 'operator_set'; account: string; operator: string; permissions: number }
  | {
      name: 'matcher_set';
      seller: string;
      matcher: string;
      maxPerOrder: bigint;
      autoSettle: boolean;
    }
  | ({ name: 'order_opened'; id: bigint } & Omit<P2pChainOrder, 'paidAt'>)
  | { name: 'order_accepted'; id: bigint; paymentDeadline: number }
  | { name: 'order_paid'; id: bigint; by: string | null }
  | {
      name: 'order_released';
      id: bigint;
      by: string | null;
      toBuyer: bigint;
      protocolFee: bigint;
      integratorFee: bigint;
    }
  | { name: 'order_cancelled'; id: bigint; by: string | null }
  | { name: 'order_disputed'; id: bigint; by: string | null }
  | {
      name: 'order_resolved';
      id: bigint;
      toBuyer: bigint;
      toSeller: bigint;
      bondToSeller: bigint;
      protocolFee: bigint;
      integratorFee: bigint;
    };
export type P2pMarketEventName = P2pMarketEvent['name'];

/** The events the indexer reads (`matcher_set` is read live, never stored). */
export const P2P_INDEXED_EVENTS = [
  'operator_set',
  'order_opened',
  'order_accepted',
  'order_paid',
  'order_released',
  'order_cancelled',
  'order_disputed',
  'order_resolved',
] as const satisfies readonly P2pMarketEventName[];

/** `OrderOpened` → `order_opened`; snake_case stays. */
export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Decodes one of the market's events, or answers null for an event that is
 * not one the indexer reads. Throws on an event whose name matches but whose
 * shape does not: that is not this contract, and the indexer must not guess.
 */
export function decodeMarketEvent(
  topics: xdr.ScVal[] | string[],
  value: xdr.ScVal | string,
): P2pMarketEvent | null {
  const parsed = MARKET.parseEvent(topics, value);
  if (!parsed) return null;
  const name = snakeCase(parsed.name);
  const d = parsed.data;
  switch (name) {
    case 'operator_set':
      return {
        name,
        account: str(d.account),
        operator: str(d.operator),
        permissions: num(d.permissions ?? d.perms),
      };
    case 'matcher_set':
      return {
        name,
        seller: str(d.seller),
        matcher: str(d.matcher),
        maxPerOrder: big(d.max_per_order),
        autoSettle: Boolean(d.auto_settle),
      };
    case 'order_opened': {
      const { paidAt: _paidAt, ...order } = toChainOrder({ ...d, paid_at: 0 });
      return { name, id: big(d.id), ...order };
    }
    case 'order_accepted':
      return { name, id: big(d.id), paymentDeadline: num(d.payment_deadline) };
    case 'order_paid':
    case 'order_cancelled':
    case 'order_disputed':
      return { name, id: big(d.id), by: optStr(d.by) };
    case 'order_released':
      return {
        name,
        id: big(d.id),
        by: optStr(d.by),
        toBuyer: big(d.to_buyer),
        protocolFee: big(d.protocol_fee),
        integratorFee: big(d.integrator_fee),
      };
    case 'order_resolved':
      return {
        name,
        id: big(d.id),
        toBuyer: big(d.to_buyer),
        toSeller: big(d.to_seller),
        bondToSeller: big(d.bond_to_seller),
        protocolFee: big(d.protocol_fee),
        integratorFee: big(d.integrator_fee),
      };
    default:
      return null;
  }
}

/** The topic filter (`getEvents`) that matches one event by its name topic. */
export function eventNameTopic(name: string): string {
  return xdr.ScVal.scvSymbol(name).toXdr('base64');
}

// --- errors ------------------------------------------------------------------------

/**
 * The name of the market error a simulation or result carries
 * (`Error(Contract, #14)` → `InsufficientBalance`), or null when it is not one.
 */
export function marketErrorName(text: string): string | null {
  const match = /Error\(Contract, #(\d+)\)/.exec(text);
  if (!match) return null;
  return (MARKET_ERRORS as Readonly<Record<number, string>>)[Number(match[1])] ?? null;
}

/**
 * The Stellar Asset Contract's own errors (soroban-env-host `ContractError`),
 * named with a `Token` prefix so they never read as the market's: code 13 is a
 * missing trustline for the token, not the market's `EmptyRef`.
 */
export const TOKEN_ERRORS: Readonly<Record<number, string>> = {
  1: 'TokenInternalError',
  2: 'TokenOperationNotSupported',
  3: 'TokenAlreadyInitialized',
  4: 'TokenUnauthorized',
  5: 'TokenAuthentication',
  6: 'TokenAccountMissing',
  7: 'TokenAccountIsNotClassic',
  8: 'TokenNegativeAmount',
  9: 'TokenAllowance',
  10: 'TokenBalance',
  11: 'TokenBalanceDeauthorized',
  12: 'TokenOverflow',
  13: 'TokenTrustlineMissing',
};

export interface ContractErrorOrigin {
  /** The contract that raised it (C...), or null when the event names none. */
  contract: string | null;
  code: number;
}

interface DiagnosticLike {
  event?: {
    contractId?: unknown;
    body?: { v0?: { topics?: readonly unknown[] } };
  };
}

const bytesOf = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  const inner = (value as { value?: unknown; bytes?: unknown } | null) ?? null;
  if (inner?.value instanceof Uint8Array) return inner.value;
  if (inner?.bytes instanceof Uint8Array) return inner.bytes;
  return null;
};

/**
 * The first contract error in a simulation's diagnostic events, in emission
 * order, with the contract that raised it. When the market's call into a token
 * fails, the token's `error` event comes first and the market's are only the
 * same code propagated (checked on testnet against a missing trustline).
 */
export function contractErrorOrigin(
  events: readonly unknown[] | undefined,
): ContractErrorOrigin | null {
  for (const raw of events ?? []) {
    const event = (raw as DiagnosticLike).event;
    const topics = event?.body?.v0?.topics;
    if (!topics || topics.length < 2) continue;
    const [name, error] = topics as [
      { type?: string; sym?: unknown },
      { type?: string; error?: { type?: string; contractCode?: number } },
    ];
    const symbol = name?.type === 'scvSymbol' ? bytesOf(name.sym) : null;
    if (!symbol || new TextDecoder().decode(symbol) !== 'error') continue;
    if (error?.type !== 'scvError' || error.error?.type !== 'sceContract') continue;
    const code = Number(error.error.contractCode);
    if (!Number.isInteger(code)) continue;
    const id = bytesOf(event?.contractId);
    return {
      contract: id && id.length === 32 ? StrKey.encodeContract(Buffer.from(id)) : null,
      code,
    };
  }
  return null;
}

/**
 * Names a simulated refusal by who raised it: the market's own error when a
 * market contract raised it, a `Token…` error when anything else did (the
 * market only calls Stellar Asset Contracts), or, with no diagnostic events
 * to tell, the market's name for the code in the error text.
 */
export function refusalName(
  sim: { error: string; events?: readonly unknown[] },
  isMarket: (contractId: string) => boolean,
): string | null {
  const origin = contractErrorOrigin(sim.events);
  if (!origin) return marketErrorName(sim.error);
  if (origin.contract && isMarket(origin.contract)) {
    return (MARKET_ERRORS as Readonly<Record<number, string>>)[origin.code] ?? null;
  }
  return TOKEN_ERRORS[origin.code] ?? null;
}
