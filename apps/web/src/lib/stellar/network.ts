/* The Stellar networks the market runs on (docs/STELLAR.md section 3), and the links a screen
   shows for an account, a contract or a transaction. Pure; tests/unit/format.test.ts. */
import { isStellarAddress, strKeyKind } from '@pier/payment-qr';

export const PASSPHRASES = {
  local: 'Standalone Network ; February 2017',
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
} as const;

/** Every passphrase a transaction may be signed for. */
export const KNOWN_PASSPHRASES: readonly string[] = Object.values(PASSPHRASES);

/** Tokens on Stellar have seven decimals. */
export const STELLAR_DECIMALS = 7;

/** Whether `a` is a classic account (G). */
export const isAccount = (a: unknown): a is string =>
  typeof a === 'string' && isStellarAddress(a, ['account']);

/** Whether `a` is a contract (C). */
export const isContract = (a: unknown): a is string =>
  typeof a === 'string' && isStellarAddress(a, ['contract']);

/** Whether money can be sent to `a`: an account, a muxed account or a contract. */
export const isDestination = (a: unknown): a is string =>
  typeof a === 'string' && isStellarAddress(a);

/** A secret seed (S...): never an address, never kept. */
export const isSecretKey = (a: unknown) => typeof a === 'string' && strKeyKind(a.trim()) === 'secret';

const HASH = /^[0-9a-f]{64}$/i;

/** A page on the network's explorer (stellar.expert style, https only), else null. */
export function explorerLink(
  network: { explorerUrl?: string | null } | null | undefined,
  kind: 'tx' | 'account' | 'contract',
  id: string | null | undefined,
): string | null {
  const base = network?.explorerUrl;
  if (!base || !id || !/^https:\/\//.test(base)) return null;
  const ok =
    kind === 'tx' ? HASH.test(id) : kind === 'account' ? isStellarAddress(id) : isContract(id);
  return ok ? `${base.replace(/\/+$/, '')}/${kind}/${id}` : null;
}

/** The kind of explorer page an address has. */
export const addressKind = (a: string): 'account' | 'contract' =>
  a.startsWith('C') ? 'contract' : 'account';
