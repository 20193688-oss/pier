/**
 * The P2PMarket contract's constants and value shapes, as JavaScript sees them
 * through stellar-sdk's `contract.Spec(MARKET_SPEC)`: an `Address` is its
 * StrKey string, `i128`/`u64` are `bigint`, `u32` is `number`, `BytesN<32>` is
 * a `Uint8Array` and an `Option` that is None is `null`. Field names are the
 * contract's own (snake_case), so these objects go to and come from the spec
 * as they are. `test/market.test.ts` pins every name and value to the
 * contract's source and spec.
 */

/** `Status`: where an order stands. */
export const ORDER_STATUS = {
  None: 0,
  Offered: 1,
  Active: 2,
  Paid: 3,
  Disputed: 4,
  Released: 5,
  Cancelled: 6,
  Resolved: 7,
} as const;
export type OrderStatusName = keyof typeof ORDER_STATUS;
export type OrderStatus = (typeof ORDER_STATUS)[OrderStatusName];

/** Operator permission bits, as `set_operator` takes them. */
export const PERMISSIONS = {
  /** Open orders on the account's balance. */
  PERM_OPEN: 1,
  /** Release the account's orders (pays their buyer). */
  PERM_RELEASE: 2,
  /** Accept, mark paid, cancel and dispute for the account. */
  PERM_TRADE: 4,
  /** Withdraw the account's balance to the account. */
  PERM_WITHDRAW: 8,
  /** Every bit; anything above is refused (`InvalidPermissions`). */
  PERM_ALL: 15,
} as const;

/** The contract's bounds. Windows are seconds; fees are basis points. */
export const LIMITS = {
  MAX_PROTOCOL_FEE_BPS: 300,
  MAX_INTEGRATOR_FEE_BPS: 500,
  MIN_PAYMENT_WINDOW: 5 * 60,
  MAX_PAYMENT_WINDOW: 2 * 24 * 60 * 60,
  MIN_ACCEPT_WINDOW: 60,
  MAX_ACCEPT_WINDOW: 24 * 60 * 60,
  MIN_SETTLE_WINDOW: 60 * 60,
  MAX_SETTLE_WINDOW: 14 * 24 * 60 * 60,
  /** Basis points in one whole. */
  BPS: 10_000,
} as const;

/** What `open` and `open_with_deposit` take (`OpenParams`). */
export interface OpenParams {
  /** The opener's own reference, unique per opener; never all zeros. */
  ref_id: Uint8Array;
  seller: string;
  buyer: string;
  /** An allowed Stellar Asset Contract (`C...`). */
  token: string;
  amount: bigint;
  /** 0n = no acceptance step. */
  bond: bigint;
  /** Must be 0 when there is no bond. */
  accept_window: number;
  payment_window: number;
  /** 0, or the settle window. */
  settle_window: number;
  /** null = no integrator fee. */
  integrator: string | null;
  /** 0 exactly when `integrator` is null; at most 500. */
  integrator_fee_bps: number;
}

/** An order (`get_order`). Times are ledger timestamps in seconds. */
export interface Order {
  seller: string;
  buyer: string;
  token: string;
  opener: string;
  integrator: string | null;
  amount: bigint;
  bond: bigint;
  status: OrderStatus;
  from_balance: boolean;
  via_matcher: boolean;
  fee_bps: number;
  integrator_fee_bps: number;
  accept_deadline: bigint;
  payment_deadline: bigint;
  paid_at: bigint;
  payment_window: number;
  settle_window: number;
  ref_id: Uint8Array;
}

/** What a seller lets a matcher do (`matcher_terms_of`); max_per_order 0n = none. */
export interface MatcherTerms {
  max_per_order: bigint;
  auto_settle: boolean;
}

/** The contract's `Config` (`config`). */
export interface MarketConfig {
  owner: string;
  pending_owner: string | null;
  treasury: string;
  arbiter: string;
  protocol_fee_bps: number;
  paused: boolean;
}
