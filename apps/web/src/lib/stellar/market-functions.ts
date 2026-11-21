/* The market functions the signing check decodes against: read from the contract's own interface,
   `MARKET_SPEC` of @pier/contracts (the committed wasm's contractspecv0 section). A function the
   spec does not declare, or declares with an argument type the check cannot hold, is absent here,
   so the check refuses it. tests/unit/market-interface.test.ts keeps this equal to
   docs/STELLAR.md section 4 (MARKET_INTERFACE). */
import { MARKET_SPEC } from '@pier/contracts';
import { describeSpec, type FunctionTable } from '@/lib/stellar/market-interface';

export const MARKET_FUNCTIONS: FunctionTable = describeSpec(MARKET_SPEC);
