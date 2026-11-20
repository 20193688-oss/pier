import { readFileSync } from 'node:fs';
import { contract, Keypair, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  MARKET_SPEC,
  ORDER_STATUS,
  PERMISSIONS,
  type MarketConfig,
  type MatcherTerms,
  type OpenParams,
  type Order,
} from '@/index';

/**
 * The hand-written constants and shapes in src/market.ts are pinned to the
 * contract: the constants to its Rust source, the shapes to its spec (every
 * field, and a round trip through stellar-sdk's `contract.Spec`).
 */

const LIB_RS = readFileSync(new URL('../contracts/p2p-market/src/lib.rs', import.meta.url), 'utf8');

/** `pub const NAME: u32 = <expr>;` from lib.rs, evaluated. */
function rustConst(name: string): number {
  const m = new RegExp(`pub const ${name}: (?:u32|i128) = ([^;]+);`).exec(LIB_RS);
  if (!m) throw new Error(`lib.rs: no ${name}`);
  const expr = m[1].replace(/_/g, '');
  if (!/^[\d\s*+]+$/.test(expr)) throw new Error(`lib.rs: ${name} is not a plain number`);
  return expr
    .split('+')
    .map((term) => term.split('*').reduce((a, b) => a * Number(b.trim()), 1))
    .reduce((a, b) => a + b, 0);
}

const spec = new contract.Spec([...MARKET_SPEC]);
const udt = (name: string) => xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name }));

function structFields(name: string): string[] {
  const entry = MARKET_SPEC.map((b64) => xdr.ScSpecEntry.fromXdr(b64, 'base64')).find(
    (e) => e.type === 'scSpecEntryUdtStructV0' && e.udtStructV0.name.toString() === name,
  );
  if (!entry || entry.type !== 'scSpecEntryUdtStructV0') throw new Error(`no struct ${name}`);
  return entry.udtStructV0.fields.map((f) => f.name.toString());
}

/** Encodes with the spec and decodes back. */
function roundTrip<T>(value: T, type: string): T {
  return spec.scValToNative<T>(spec.nativeToScVal(value, udt(type)), udt(type));
}

const G1 = Keypair.random().publicKey();
const G2 = Keypair.random().publicKey();
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

describe('constants', () => {
  it('match the contract source', () => {
    for (const [name, value] of Object.entries(PERMISSIONS)) expect(rustConst(name)).toBe(value);
    for (const [name, value] of Object.entries(LIMITS)) expect(rustConst(name)).toBe(value);
  });

  it('ORDER_STATUS is the spec Status enum', () => {
    const status = MARKET_SPEC.map((b64) => xdr.ScSpecEntry.fromXdr(b64, 'base64')).find(
      (e) => e.type === 'scSpecEntryUdtEnumV0' && e.udtEnumV0.name.toString() === 'Status',
    );
    if (!status || status.type !== 'scSpecEntryUdtEnumV0') throw new Error('no Status');
    expect(
      Object.fromEntries(status.udtEnumV0.cases.map((c) => [c.name.toString(), c.value])),
    ).toEqual(ORDER_STATUS);
  });
});

describe('value shapes', () => {
  it('OpenParams has every spec field and round-trips', () => {
    const p: OpenParams = {
      ref_id: new Uint8Array(32).fill(7),
      seller: G1,
      buyer: G2,
      token: SAC,
      amount: 100_0000000n,
      bond: 0n,
      accept_window: 0,
      payment_window: 1800,
      settle_window: 0,
      integrator: null,
      integrator_fee_bps: 0,
    };
    expect(Object.keys(p).sort()).toEqual(structFields('OpenParams').sort());
    expect(roundTrip(p, 'OpenParams')).toEqual(p);
    expect(
      roundTrip({ ...p, integrator: G2, integrator_fee_bps: 50 }, 'OpenParams').integrator,
    ).toBe(G2);
  });

  it('Order has every spec field and round-trips', () => {
    const o: Order = {
      seller: G1,
      buyer: G2,
      token: SAC,
      opener: G1,
      integrator: null,
      amount: 5n,
      bond: 1n,
      status: ORDER_STATUS.Offered,
      from_balance: true,
      via_matcher: false,
      fee_bps: 100,
      integrator_fee_bps: 0,
      accept_deadline: 1_900_000_000n,
      payment_deadline: 0n,
      paid_at: 0n,
      payment_window: 1800,
      settle_window: 3600,
      ref_id: new Uint8Array(32).fill(9),
    };
    expect(Object.keys(o).sort()).toEqual(structFields('Order').sort());
    expect(roundTrip(o, 'Order')).toEqual(o);
  });

  it('MatcherTerms and MarketConfig have every spec field and round-trip', () => {
    const t: MatcherTerms = { max_per_order: 500_0000000n, auto_settle: true };
    expect(Object.keys(t).sort()).toEqual(structFields('MatcherTerms').sort());
    expect(roundTrip(t, 'MatcherTerms')).toEqual(t);
    const c: MarketConfig = {
      owner: G1,
      pending_owner: null,
      treasury: G2,
      arbiter: G1,
      protocol_fee_bps: 100,
      paused: false,
    };
    expect(Object.keys(c).sort()).toEqual(structFields('Config').sort());
    expect(roundTrip(c, 'Config')).toEqual(c);
  });

  it('encodes a call with the spec as the API will', () => {
    const args = spec.funcArgsToScVals('open', {
      caller: G1,
      p: {
        ref_id: new Uint8Array(32).fill(1),
        seller: G1,
        buyer: G2,
        token: SAC,
        amount: 1n,
        bond: 0n,
        accept_window: 0,
        payment_window: 1800,
        settle_window: 0,
        integrator: null,
        integrator_fee_bps: 0,
      } satisfies OpenParams,
    });
    expect(args).toHaveLength(2);
    expect(spec.funcResToNative('order_count', xdr.ScVal.scvU64(3n))).toBe(3n);
  });
});
