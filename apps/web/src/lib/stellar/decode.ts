/* Reading a Soroban invocation the API built: its contract, function and arguments, each argument
   decoded strictly against the type the contract declares (src/lib/stellar/market-interface.ts).
   A value of any other type, a struct with a missing or extra field, or anything unreadable is
   `BAD`, never a guess. Pure; tests/unit/tx-verify.test.ts. */
import { Address, xdr } from '@stellar/stellar-sdk/base';
import type { ArgType } from '@/lib/stellar/market-interface';
import { toHex } from '@/lib/p2p/order-ref';

export const BAD = Symbol('bad');
export type Decoded = string | bigint | number | boolean | null | { [field: string]: Decoded };

const symbolText = (v: xdr.ScVal): string | null =>
  v.type === 'scvSymbol' ? new TextDecoder().decode(v.sym.bytes) : null;

/** A Stellar address (G, M or C) of an `ScAddress`, or null for any other kind. */
export function addressOf(a: xdr.ScAddress): string | null {
  try {
    if (
      a.type !== 'scAddressTypeAccount' &&
      a.type !== 'scAddressTypeContract' &&
      a.type !== 'scAddressTypeMuxedAccount'
    )
      return null;
    return Address.fromScAddress(a).toString();
  } catch {
    return null;
  }
}

function i128(v: xdr.ScVal): bigint | null {
  if (v.type !== 'scvI128') return null;
  const { hi, lo } = v.i128;
  return (BigInt(hi) << 64n) | BigInt.asUintN(64, BigInt(lo));
}

/** One value of type `t`, or BAD. */
export function decodeValue(v: xdr.ScVal, t: ArgType): Decoded | typeof BAD {
  if (typeof t === 'object') {
    if (v.type !== 'scvMap' || !v.map) return BAD;
    // A Soroban struct is a map of symbol keys, sorted, one per field.
    if (v.map.length !== t.fields.length) return BAD;
    const out: { [field: string]: Decoded } = {};
    for (const entry of v.map) {
      const key = symbolText(entry.key);
      const field = t.fields.find(([name]) => name === key);
      if (!key || !field || key in out) return BAD;
      const value = decodeValue(entry.val, field[1]);
      if (value === BAD) return BAD;
      out[key] = value;
    }
    return out;
  }
  switch (t) {
    case 'address':
      return v.type === 'scvAddress' ? (addressOf(v.address) ?? BAD) : BAD;
    case 'option<address>':
      if (v.type === 'scvVoid') return null;
      return v.type === 'scvAddress' ? (addressOf(v.address) ?? BAD) : BAD;
    case 'i128':
      return i128(v) ?? BAD;
    case 'u32':
      return v.type === 'scvU32' ? v.u32 : BAD;
    case 'u64':
      return v.type === 'scvU64' ? BigInt(v.u64) : BAD;
    case 'bool':
      return v.type === 'scvBool' ? v.b : BAD;
    case 'bytes32': {
      if (v.type !== 'scvBytes') return BAD;
      const bytes = v.bytes.value as Uint8Array;
      return bytes.length === 32 ? toHex(bytes) : BAD;
    }
  }
}

export interface Invocation {
  contract: string;
  fn: string;
  args: xdr.ScVal[];
  /* The invocation as XDR, to compare an auth entry's root with it byte for byte. */
  raw: xdr.InvokeContractArgs;
}

/** The contract call of an InvokeContractArgs, or null when its contract is not a contract. */
export function readInvocation(ic: xdr.InvokeContractArgs): Invocation | null {
  const contract = addressOf(ic.contractAddress);
  if (!contract || !contract.startsWith('C')) return null;
  return {
    contract,
    fn: new TextDecoder().decode(ic.functionName.bytes),
    args: [...ic.args],
    raw: ic,
  };
}

/** The named arguments of `inv`, decoded against `signature`, or BAD when their count or any type
    differs. */
export function decodeArgs(
  inv: Pick<Invocation, 'args'>,
  signature: readonly (readonly [string, ArgType])[],
): Record<string, Decoded> | typeof BAD {
  if (inv.args.length !== signature.length) return BAD;
  const out: Record<string, Decoded> = {};
  for (let i = 0; i < signature.length; i++) {
    const value = decodeValue(inv.args[i], signature[i][1]);
    if (value === BAD) return BAD;
    out[signature[i][0]] = value;
  }
  return out;
}
