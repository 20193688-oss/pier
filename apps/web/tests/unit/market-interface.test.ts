/* market-interface.test.ts: the functions the signing check decodes (read from the contract's
   committed spec, MARKET_SPEC) are exactly those docs/STELLAR.md section 4 names, with the same
   argument names and types; the spec reader refuses what it cannot hold. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { MARKET_SPEC, MARKET_ERRORS } from '@midpoint/contracts';
import {
  describeSpec,
  MARKET_INTERFACE,
  type ArgType,
  type FunctionTable,
} from '@/lib/stellar/market-interface';
import { MARKET_FUNCTIONS } from '@/lib/stellar/market-functions';

/* A struct's fields are matched by name (a Soroban struct is a map with sorted keys), so their order
   in a table does not matter. */
const norm = (t: ArgType): unknown =>
  typeof t === 'object'
    ? { struct: t.struct, fields: [...t.fields].sort(([a], [b]) => a.localeCompare(b)).map(([n, f]) => [n, norm(f)]) }
    : t;
const normal = (table: FunctionTable) =>
  Object.fromEntries(
    Object.entries(table)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fn, args]) => [fn, args.map(([n, t]) => [n, norm(t)])]),
  );

test('the committed spec declares every function a wallet signs, as section 4 specifies', () => {
  assert.deepEqual(normal(MARKET_FUNCTIONS), normal(MARKET_INTERFACE));
});

test('a function the spec lacks is absent, so the check refuses it', () => {
  const t = describeSpec(MARKET_SPEC, ['release', 'no_such_function']);
  assert.deepEqual(Object.keys(t), ['release']);
  assert.deepEqual(describeSpec([], ['release']), {});
});

test('the error codes the web may show are the binding ones', () => {
  assert.equal(MARKET_ERRORS[17], 'WrongStatus');
  assert.equal(MARKET_ERRORS[22], 'NegativeAmount');
});
