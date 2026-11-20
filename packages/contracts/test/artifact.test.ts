import { contract, xdr } from '@stellar/stellar-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MARKET_BUILD,
  MARKET_ERRORS,
  MARKET_SPEC,
  MARKET_WASM_BASE64,
  MARKET_WASM_HASH,
} from '@/index';
import {
  buildWasm,
  customSection,
  errorsOf,
  hostPaths,
  sha256Hex,
  specBase64,
  specEntries,
} from '@scripts/compile';

/**
 * The committed artifact is what the pipeline builds from the committed
 * source, and its interface is the binding one (docs/STELLAR.md section 4).
 */

const committed = Buffer.from(MARKET_WASM_BASE64, 'base64');
const entries = MARKET_SPEC.map((b64) => xdr.ScSpecEntry.fromXdr(b64, 'base64'));

function entry<T extends xdr.ScSpecEntry['type']>(type: T, name: string) {
  const found = entries.find((e) => {
    if (e.type !== type) return false;
    const value = (e as unknown as Record<string, { name: { toString(): string } }>)[
      type.replace('scSpecEntry', '').replace(/^./, (c) => c.toLowerCase())
    ];
    return value.name.toString() === name;
  });
  if (!found) throw new Error(`no ${type} ${name}`);
  return found as Extract<xdr.ScSpecEntry, { type: T }>;
}

describe('the committed artifact', () => {
  let fresh: Buffer;
  beforeAll(() => {
    fresh = buildWasm();
  });

  it('is a fresh build of the contract', () => {
    expect(sha256Hex(fresh)).toBe(MARKET_WASM_HASH);
    expect(fresh.equals(committed)).toBe(true);
    expect(MARKET_BUILD.bytes).toBe(committed.length);
  });

  it('records the hash of its own wasm, with no host path in it', () => {
    expect(sha256Hex(committed)).toBe(MARKET_WASM_HASH);
    expect(hostPaths(committed)).toEqual([]);
  });

  it('has as MARKET_SPEC the wasm spec section, one entry per item', () => {
    expect(specBase64(fresh)).toEqual(MARKET_SPEC);
    const section = customSection(committed, 'contractspecv0');
    expect(Buffer.concat(MARKET_SPEC.map((b64) => Buffer.from(b64, 'base64')))).toEqual(section);
    expect(specEntries(section)).toHaveLength(MARKET_SPEC.length);
  });

  it('has as MARKET_ERRORS the spec error enum', () => {
    expect(errorsOf(MARKET_SPEC)).toEqual(MARKET_ERRORS);
  });
});

describe('the interface (docs/STELLAR.md section 4)', () => {
  it('has the binding error codes', () => {
    expect(MARKET_ERRORS).toEqual({
      1: 'NotOwner',
      2: 'NotPendingOwner',
      3: 'NotArbiter',
      4: 'NotAuthorized',
      5: 'IsPaused',
      6: 'ZeroAmount',
      7: 'TokenNotAllowed',
      8: 'FeeTooHigh',
      9: 'BadWindow',
      10: 'BadIntegrator',
      11: 'SameParty',
      12: 'RefTaken',
      13: 'EmptyRef',
      14: 'InsufficientBalance',
      15: 'ShortDeposit',
      16: 'UnknownOrder',
      17: 'WrongStatus',
      18: 'Expired',
      19: 'NotYet',
      20: 'BadSplit',
      21: 'InvalidPermissions',
      22: 'NegativeAmount',
    });
  });

  it('has exactly the binding functions, arguments in order, and outputs', () => {
    const spec = new contract.Spec([...MARKET_SPEC]);
    const signature = (f: xdr.ScSpecFunctionV0) =>
      `${f.name.toString()}(${f.inputs.map((i) => i.name.toString()).join(', ')})${
        f.outputs.length === 0 ? '' : ` -> ${f.outputs.map((o) => typeName(o)).join(', ')}`
      }`;
    expect(spec.funcs().map(signature).sort()).toEqual(
      [
        '__constructor(owner, treasury, arbiter, protocol_fee_bps)',
        'set_protocol_fee(bps)',
        'set_treasury(treasury)',
        'set_arbiter(arbiter)',
        'set_token(token, allowed)',
        'set_paused(paused)',
        'transfer_ownership(to)',
        'accept_ownership()',
        'deposit(account, token, amount)',
        'withdraw(account, token, amount)',
        'withdraw_for(operator, account, token, amount)',
        'set_operator(account, operator, perms)',
        'set_matcher(seller, matcher, max_per_order, auto_settle)',
        'open(caller, p) -> u64',
        'open_with_deposit(p) -> u64',
        'accept(caller, id)',
        'mark_paid(caller, id)',
        'release(caller, id)',
        'cancel(caller, id)',
        'dispute(caller, id)',
        'settle(id)',
        'resolve(id, to_buyer, bond_to_seller)',
        'config() -> Config',
        'get_order(id) -> Order',
        'order_id_of(opener, ref_id) -> u64',
        'balance_of(account, token) -> i128',
        'permissions_of(account, operator) -> u32',
        'matcher_terms_of(seller, matcher) -> MatcherTerms',
        'token_allowed(token) -> bool',
        'order_count() -> u64',
      ].sort(),
    );
    // not upgradeable: nothing can replace the code
    expect(spec.funcs().some((f) => /upgrade|update|wasm/i.test(f.name.toString()))).toBe(false);
  });

  it('has the binding types', () => {
    // a struct is a map on-chain, so the spec lists its fields by name
    const fields = (name: string) =>
      entry('scSpecEntryUdtStructV0', name).udtStructV0.fields.map(
        (f) => `${f.name.toString()}: ${typeName(f.type)}`,
      );
    const sorted = (xs: string[]) => [...xs].sort();
    expect(fields('OpenParams')).toEqual(
      sorted([
        'ref_id: BytesN<32>',
        'seller: Address',
        'buyer: Address',
        'token: Address',
        'amount: i128',
        'bond: i128',
        'accept_window: u32',
        'payment_window: u32',
        'settle_window: u32',
        'integrator: Option<Address>',
        'integrator_fee_bps: u32',
      ]),
    );
    expect(fields('Order')).toEqual(
      sorted([
        'seller: Address',
        'buyer: Address',
        'token: Address',
        'opener: Address',
        'integrator: Option<Address>',
        'amount: i128',
        'bond: i128',
        'status: Status',
        'from_balance: bool',
        'via_matcher: bool',
        'fee_bps: u32',
        'integrator_fee_bps: u32',
        'accept_deadline: u64',
        'payment_deadline: u64',
        'paid_at: u64',
        'payment_window: u32',
        'settle_window: u32',
        'ref_id: BytesN<32>',
      ]),
    );
    expect(fields('MatcherTerms')).toEqual(sorted(['max_per_order: i128', 'auto_settle: bool']));
    expect(fields('Config')).toEqual(
      sorted([
        'owner: Address',
        'pending_owner: Option<Address>',
        'treasury: Address',
        'arbiter: Address',
        'protocol_fee_bps: u32',
        'paused: bool',
      ]),
    );
    expect(
      entry('scSpecEntryUdtEnumV0', 'Status').udtEnumV0.cases.map(
        (c) => `${c.name.toString()}=${c.value}`,
      ),
    ).toEqual([
      'None=0',
      'Offered=1',
      'Active=2',
      'Paid=3',
      'Disputed=4',
      'Released=5',
      'Cancelled=6',
      'Resolved=7',
    ]);
  });

  it('has one event per EVM event: prefix topic, topics, then a data map', () => {
    const events = entries
      .filter(
        (e): e is Extract<xdr.ScSpecEntry, { type: 'scSpecEntryEventV0' }> =>
          e.type === 'scSpecEntryEventV0',
      )
      .map(({ eventV0: e }) => {
        const params = (location: 'topic' | 'data') =>
          e.params
            .filter((p) => p.location.value === (location === 'topic' ? 1 : 0))
            .map((p) => `${p.name.toString()}: ${typeName(p.type)}`);
        expect(e.dataFormat.name).toBe('scSpecEventDataFormatMap');
        return `${e.prefixTopics.map(String).join(',')} [${params('topic').join(', ')}] {${params(
          'data',
        ).join(', ')}}`;
      });
    expect(events.sort()).toEqual(
      [
        'deposited [account: Address, token: Address] {amount: i128}',
        'withdrawn [account: Address, token: Address] {amount: i128}',
        'credited [account: Address, token: Address] {amount: i128}',
        'operator_set [account: Address, operator: Address] {permissions: u32}',
        'matcher_set [seller: Address, matcher: Address] {max_per_order: i128, auto_settle: bool}',
        'order_opened [id: u64] {seller: Address, buyer: Address, token: Address, opener: Address, ' +
          'integrator: Option<Address>, amount: i128, bond: i128, status: Status, from_balance: bool, ' +
          'via_matcher: bool, fee_bps: u32, integrator_fee_bps: u32, accept_deadline: u64, ' +
          'payment_deadline: u64, payment_window: u32, settle_window: u32, ref_id: BytesN<32>}',
        'order_accepted [id: u64] {payment_deadline: u64}',
        'order_paid [id: u64] {by: Address}',
        'order_released [id: u64] {by: Option<Address>, to_buyer: i128, protocol_fee: i128, integrator_fee: i128}',
        'order_cancelled [id: u64] {by: Option<Address>}',
        'order_disputed [id: u64] {by: Address}',
        'order_resolved [id: u64] {to_buyer: i128, to_seller: i128, bond_to_seller: i128, protocol_fee: i128, integrator_fee: i128}',
        'protocol_fee_set [] {bps: u32}',
        'treasury_set [] {treasury: Address}',
        'arbiter_set [] {arbiter: Address}',
        'token_set [token: Address] {allowed: bool}',
        'paused_set [] {paused: bool}',
        'ownership_transfer_started [from: Address, to: Address] {}',
        'ownership_transferred [from: Option<Address>, to: Address] {}',
      ].sort(),
    );
  });
});

/** A spec type as Rust writes it. */
function typeName(t: xdr.ScSpecTypeDef): string {
  switch (t.type) {
    case 'scSpecTypeOption':
      return `Option<${typeName(t.option.valueType)}>`;
    case 'scSpecTypeBytesN':
      return `BytesN<${t.bytesN.n}>`;
    case 'scSpecTypeUdt':
      return t.udt.name.toString();
    default:
      return (
        (
          {
            scSpecTypeAddress: 'Address',
            scSpecTypeBool: 'bool',
            scSpecTypeU32: 'u32',
            scSpecTypeU64: 'u64',
            scSpecTypeI128: 'i128',
          } as Record<string, string>
        )[t.type] ?? t.type
      );
  }
}
