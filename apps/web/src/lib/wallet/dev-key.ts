/* The dev-key wallet: one of the local dev stack's printed secret keys (local or testnet only),
   signing in this tab, to test against the dev stack without Pollar. Development builds only:
   src/lib/session.tsx imports this module behind `import.meta.env.DEV`, so a production build
   has no code path to it. The key is kept in this tab's sessionStorage so a reload keeps the
   session; it is a throwaway test key, never a real one. */
import { Keypair, StrKey } from '@stellar/stellar-sdk/base';
import { keypairWallet } from '@/lib/wallet/keypair';
import type { StellarWallet } from '@/lib/wallet/types';

const KEY = 'pier.dev-key';

export function isDevSecret(text: string): boolean {
  return StrKey.isValidEd25519SecretSeed(text.trim());
}

export function devKeyWallet(secret: string, remember = true): StellarWallet {
  const kp = Keypair.fromSecret(secret.trim());
  if (remember) {
    try {
      sessionStorage.setItem(KEY, secret.trim());
    } catch {
      /* this page only */
    }
  }
  return keypairWallet(kp, 'dev-key', 'Dev key', () => {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* nothing kept */
    }
  });
}

/** The dev key this tab used, when there is one. */
export function restoreDevKey(): StellarWallet | null {
  try {
    const s = sessionStorage.getItem(KEY);
    return s && isDevSecret(s) ? devKeyWallet(s, false) : null;
  } catch {
    return null;
  }
}
