/* The market contract's functions a wallet signs, with every argument's name and type: what the
   signing check (src/lib/p2p/tx-verify.ts) decodes an invocation against. The table is read from
   the contract's own interface, `MARKET_SPEC` of @midpoint/contracts (base64 `ScSpecEntry` XDR),
   by `describeSpec`; `MARKET_INTERFACE` is the same table written from docs/STELLAR.md section
   4, which tests/unit/market-interface.test.ts compares with the spec so the two never drift.

   An argument's type is one of the few the market uses. A struct (`OpenParams`) lists its
   fields; an invocation whose arguments do not have exactly these types is refused. */
import { xdr } from '@stellar/stellar-sdk/base';

export type ArgType =
  | 'address'
  | 'i128'
  | 'u32'
  | 'u64'
  | 'bool'
  | 'bytes32'
  | 'option<address>'
  | { struct: string; fields: readonly (readonly [string, ArgType])[] };

export type FunctionTable = Readonly<Record<string, readonly (readonly [string, ArgType])[]>>;

export const OPEN_PARAMS: ArgType = {
  struct: 'OpenParams',
  fields: [
    ['ref_id', 'bytes32'],
    ['seller', 'address'],
    ['buyer', 'address'],
    ['token', 'address'],
    ['amount', 'i128'],
    ['bond', 'i128'],
    ['accept_window', 'u32'],
    ['payment_window', 'u32'],
    ['settle_window', 'u32'],
    ['integrator', 'option<address>'],
    ['integrator_fee_bps', 'u32'],
  ],
};

const orderAction = [
  ['caller', 'address'],
  ['id', 'u64'],
] as const;

/** The functions a person's wallet signs (docs/STELLAR.md 4.2), by their contract name. */
export const MARKET_INTERFACE: FunctionTable = {
  deposit: [
    ['account', 'address'],
    ['token', 'address'],
    ['amount', 'i128'],
  ],
  withdraw: [
    ['account', 'address'],
    ['token', 'address'],
    ['amount', 'i128'],
  ],
  set_operator: [
    ['account', 'address'],
    ['operator', 'address'],
    ['perms', 'u32'],
  ],
  set_matcher: [
    ['seller', 'address'],
    ['matcher', 'address'],
    ['max_per_order', 'i128'],
    ['auto_settle', 'bool'],
  ],
  open_with_deposit: [['p', OPEN_PARAMS]],
  accept: orderAction,
  mark_paid: orderAction,
  release: orderAction,
  cancel: orderAction,
  dispute: orderAction,
};

/** The Stellar Asset Contract's `transfer`: what a deposit pulls and a contract payment sends. */
export const SAC_TRANSFER: readonly (readonly [string, ArgType])[] = [
  ['from', 'address'],
  ['to', 'address'],
  ['amount', 'i128'],
];

const text = (s: { bytes: Uint8Array }) => new TextDecoder().decode(s.bytes);

function typeOf(
  def: xdr.ScSpecTypeDef,
  structs: Map<string, xdr.ScSpecUdtStructV0>,
): ArgType | null {
  switch (def.type) {
    case 'scSpecTypeAddress':
      return 'address';
    case 'scSpecTypeI128':
      return 'i128';
    case 'scSpecTypeU32':
      return 'u32';
    case 'scSpecTypeU64':
      return 'u64';
    case 'scSpecTypeBool':
      return 'bool';
    case 'scSpecTypeBytesN':
      return def.bytesN.n === 32 ? 'bytes32' : null;
    case 'scSpecTypeOption':
      return def.option.valueType.type === 'scSpecTypeAddress' ? 'option<address>' : null;
    case 'scSpecTypeUdt': {
      const name = text(def.udt.name);
      const s = structs.get(name);
      if (!s) return null;
      const fields: [string, ArgType][] = [];
      for (const f of s.fields) {
        const t = typeOf(f.type, structs);
        if (!t) return null;
        fields.push([text(f.name), t]);
      }
      return { struct: name, fields };
    }
    default:
      return null;
  }
}

/** The table of `names` read from a contract spec (base64 `ScSpecEntry` XDR entries). A function
    missing from the spec, or with an argument of a type this table cannot hold, is left out, so
    the signing check refuses it. */
export function describeSpec(
  spec: readonly string[],
  names: readonly string[] = Object.keys(MARKET_INTERFACE),
): FunctionTable {
  const entries = spec.map((b64) => xdr.ScSpecEntry.fromXdr(b64, 'base64'));
  const structs = new Map<string, xdr.ScSpecUdtStructV0>();
  for (const e of entries)
    if (e.type === 'scSpecEntryUdtStructV0') structs.set(text(e.udtStructV0.name), e.udtStructV0);
  const out: Record<string, (readonly [string, ArgType])[]> = {};
  for (const e of entries) {
    if (e.type !== 'scSpecEntryFunctionV0') continue;
    const name = text(e.functionV0.name);
    if (!names.includes(name)) continue;
    const args: [string, ArgType][] = [];
    let ok = true;
    for (const input of e.functionV0.inputs) {
      const t = typeOf(input.type, structs);
      if (!t) ok = false;
      else args.push([text(input.name), t]);
    }
    if (ok) out[name] = args;
  }
  return out;
}
