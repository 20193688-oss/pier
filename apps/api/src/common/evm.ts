import { getAddress, isAddress } from 'viem';

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** EIP-55 form of an address; throws on anything that is not one. */
export function checksum(value: string): string {
  if (!isAddress(value, { strict: false })) throw new Error(`${value} is not an EVM address`);
  return getAddress(value);
}

/** Two addresses are the same account, whatever their case. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
