import { StrKey } from '@stellar/stellar-sdk';

/**
 * Stellar address helpers. Addresses are StrKeys and are never re-cased:
 * `G...` accounts, `C...` contracts, and `M...` muxed accounts (accepted only
 * as a payment destination).
 */

export const ACCOUNT_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
export const CONTRACT_ADDRESS_RE = /^C[A-Z2-7]{55}$/;
export const MUXED_ADDRESS_RE = /^M[A-Z2-7]{68}$/;

/** A valid account address (`G...`, checksum included). */
export function isAccountAddress(value: unknown): value is string {
  return typeof value === 'string' && StrKey.isValidEd25519PublicKey(value);
}

/** A valid contract address (`C...`). */
export function isContractAddress(value: unknown): value is string {
  return typeof value === 'string' && StrKey.isValidContract(value);
}

/** A valid muxed account address (`M...`). */
export function isMuxedAddress(value: unknown): value is string {
  return typeof value === 'string' && StrKey.isValidMed25519PublicKey(value);
}

/** A valid secret seed (`S...`). */
export function isSecretSeed(value: unknown): value is string {
  return typeof value === 'string' && StrKey.isValidEd25519SecretSeed(value);
}

/** Two addresses are the same account (StrKeys are canonical: plain equality). */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a === b;
}

/** The G account behind an M address (or the address itself). */
export function baseAccountOf(address: string): string {
  if (isMuxedAddress(address)) {
    const raw = StrKey.decodeMed25519PublicKey(address);
    return StrKey.encodeEd25519PublicKey(raw.subarray(0, 32));
  }
  return address;
}
