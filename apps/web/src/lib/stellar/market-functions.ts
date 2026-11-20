/* The market functions the signing check decodes against. Until @pedospe/contracts exports
   `MARKET_SPEC`, the table written from docs/STELLAR.md section 4 (MARKET_INTERFACE). */
import { MARKET_INTERFACE, type FunctionTable } from '@/lib/stellar/market-interface';

export const MARKET_FUNCTIONS: FunctionTable = MARKET_INTERFACE;
