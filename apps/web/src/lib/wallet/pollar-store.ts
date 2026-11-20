/* The bridge between the app and Pollar, without loading Pollar: src/lib/wallet/pollar.tsx (a lazy
   chunk, loaded only when VITE_POLLAR_PUBLISHABLE_KEY is set) publishes what Pollar can do here,
   and the session and the sign-in screens read it. */
import { useSyncExternalStore } from 'react';
import type { StellarWallet } from '@/lib/wallet/types';

export type ExternalWalletId = 'freighter' | 'albedo';

export interface PollarApi {
  /* The app's Pollar configuration loaded (login methods, branding). */
  ready: boolean;
  /* The signed-in Pollar wallet, once Pollar confirmed the session; null otherwise. */
  wallet: StellarWallet | null;
  /* Signed in to Pollar with a wallet this app cannot use (a passkey smart wallet). */
  unsupported: boolean;
  /** Email login, step 1: Pollar sends a code to `email`. */
  sendEmailCode(email: string): Promise<void>;
  /** Email login, step 2: the code; resolves once Pollar signed the person in. */
  verifyEmailCode(code: string): Promise<void>;
  google(): Promise<void>;
  /** A browser wallet extension through Pollar's built-in adapters. */
  external(id: ExternalWalletId): Promise<void>;
  cancel(): void;
  logout(): Promise<void>;
}

let current: PollarApi | null = null;
const listeners = new Set<() => void>();

export function publishPollar(api: PollarApi | null) {
  current = api;
  listeners.forEach((l) => l());
}

export function getPollar(): PollarApi | null {
  return current;
}

export function subscribePollar(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Pollar as published, or null while it loads (or when this build has no Pollar key). */
export function usePollarApi(): PollarApi | null {
  return useSyncExternalStore(subscribePollar, getPollar, () => null);
}

/** The publishable key this build was given; empty: no Pollar (mock mode or the dev-key wallet). */
export const POLLAR_KEY = String(import.meta.env.VITE_POLLAR_PUBLISHABLE_KEY ?? '').trim();

/** The Stellar network a Pollar publishable key works on. A key belongs to one environment
    (`pub_testnet_…` / `pub_mainnet_…`), so its prefix decides: a testnet key started on mainnet
    gives a wallet whose network never matches the market's. The tier decides only for a key
    without that prefix. */
export function pollarNetworkFor(key: string, tier: 'live' | 'test'): 'testnet' | 'mainnet' {
  if (key.startsWith('pub_testnet_')) return 'testnet';
  if (key.startsWith('pub_mainnet_')) return 'mainnet';
  return tier === 'live' ? 'mainnet' : 'testnet';
}
