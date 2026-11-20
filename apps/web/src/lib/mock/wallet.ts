/* The demo wallet (mock mode only): a Stellar key derived from a fixed, public seed per demo
   persona (src/lib/mock/fixtures.ts), so the real sign-in, check and signing code paths run
   unchanged against the in-browser mock API. Mock mode is compiled out of production builds. */
import { mockKeypair, PERSONAS, type Persona } from '@/lib/mock/fixtures';
import { keypairWallet } from '@/lib/wallet/keypair';
import { BRAND } from '@/lib/brand';
import type { StellarWallet } from '@/lib/wallet/types';

const KEY = 'midpoint.demo-persona';

export function demoWallet(persona: Persona = 'user'): StellarWallet {
  try {
    sessionStorage.setItem(KEY, persona);
  } catch {
    /* this page only */
  }
  return keypairWallet(mockKeypair(persona), 'demo', BRAND.name, () => {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* nothing kept */
    }
  });
}

/** Which demo persona an email signs in as (the mock's stand-in for an email code): the persona
    named before the @ when there is one (user@…, merchant@…, business@…, fresh@…), else a new
    wallet for a sign-up, the funded person for the app's sign-in and the merchant for the
    dashboard's. */
export function personaForEmail(
  email: string | null,
  mode: 'signin' | 'signup',
  variant: 'app' | 'dashboard',
): Persona {
  const local = (email ?? '').split('@')[0].trim().toLowerCase();
  const named = PERSONAS.find((p) => p === local);
  if (named) return named;
  if (mode === 'signup') return 'fresh';
  return variant === 'dashboard' ? 'merchant' : 'user';
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
