/* The demo wallet (mock mode only): a Stellar key derived from a fixed, public seed per demo
   persona (src/lib/mock/fixtures.ts), so the real sign-in, check and signing code paths run
   unchanged against the in-browser mock API. Mock mode is compiled out of production builds. */
import { mockKeypair, PERSONAS, type Persona } from '@/lib/mock/fixtures';
import { keypairWallet } from '@/lib/wallet/keypair';
import type { StellarWallet } from '@/lib/wallet/types';

const KEY = 'pedospe.demo-persona';

export function demoWallet(persona: Persona = 'user'): StellarWallet {
  try {
    sessionStorage.setItem(KEY, persona);
  } catch {
    /* this page only */
  }
  return keypairWallet(mockKeypair(persona), 'demo', 'Demo', () => {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* nothing kept */
    }
  });
}

/** The persona this tab signed in as, after a reload. */
export function restoreDemoWallet(): StellarWallet | null {
  try {
    const p = sessionStorage.getItem(KEY) as Persona | null;
    return p && PERSONAS.includes(p) ? demoWallet(p) : null;
  } catch {
    return null;
  }
}

export { PERSONAS, type Persona };
