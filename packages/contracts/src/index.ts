/**
 * `@pedospe/contracts`: the P2PMarket Soroban contract's committed wasm, its
 * interface spec and error codes, and its constants and value shapes. No
 * runtime dependency: decode with stellar-sdk's `new contract.Spec(MARKET_SPEC)`.
 */
export {
  MARKET_BUILD,
  MARKET_ERRORS,
  MARKET_SPEC,
  MARKET_WASM_BASE64,
  MARKET_WASM_HASH,
} from '@/p2p-market.artifact';
export {
  LIMITS,
  ORDER_STATUS,
  PERMISSIONS,
  type MarketConfig,
  type MatcherTerms,
  type OpenParams,
  type Order,
  type OrderStatus,
  type OrderStatusName,
} from '@/market';
