/* Who is signed in, and with which wallet.

   Sign-in is SEP-10 against our API as soon as a wallet is ready: the API answers a challenge
   transaction for the wallet's account, the page checks it is a real challenge (it can never be
   submitted: src/lib/stellar/challenge.ts), the wallet signs it, the page checks the wallet
   returned the same transaction, and the API answers a session in an HttpOnly cookie (the page
   never reads it; it asks the API who is signed in).

   The wallet itself (src/lib/wallet/types.ts) is remembered per tab by kind: a Pollar wallet comes
   back with Pollar's own session, the dev-key and demo wallets from this tab's storage (they are
   compiled out of production builds). A reload therefore keeps both the session and the wallet;
   nothing here logs out on its own except a 401 from the API. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { auth } from '@/lib/api/endpoints';
import type { Session } from '@/lib/api/types';
import { MOCK } from '@/lib/env';
import { usePollarApi, POLLAR_KEY } from '@/lib/wallet/pollar-store';
import type { StellarWallet, WalletKind } from '@/lib/wallet/types';

const KIND_KEY = 'pedospe.wallet-kind';

export type SignInStep = 'challenge' | 'signing' | 'checking';

interface SessionValue {
  /* undefined while the API is asked, null when nobody is signed in. */
  session: Session | null | undefined;
  /* The wallet that signed in, while it is still available in this tab. */
  wallet: StellarWallet | null;
  /* Whether this tab finished looking for its wallet (a reload restores it). */
  walletReady: boolean;
  signIn: (w: StellarWallet, progress?: (step: SignInStep) => void) => Promise<Session>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  /* A call answered 401: the session is over. */
  expire: () => void;
  expired: boolean;
}

const Ctx = createContext<SessionValue | null>(null);

const readKind = (): WalletKind | null => {
  try {
    const k = sessionStorage.getItem(KIND_KEY);
    return k === 'pollar' || k === 'demo' || k === 'dev-key' ? k : null;
  } catch {
    return null;
  }
};
const writeKind = (k: WalletKind | null) => {
  try {
    if (k) sessionStorage.setItem(KIND_KEY, k);
    else sessionStorage.removeItem(KIND_KEY);
  } catch {
    /* the wallet is asked again next time */
  }
};

/** SEP-10 against the API with `w`: the session. The challenge is checked against this app's
    own domains and this origin's signing key before the wallet signs it (src/lib/stellar/sep10.ts),
    and the wallet's answer is checked to be that same transaction. */
export async function sep10SignIn(
  w: StellarWallet,
  progress?: (step: SignInStep) => void,
): Promise<Session> {
  progress?.('challenge');
  const { transaction, networkPassphrase } = await auth.challenge(w.address);
  const [{ assertChallenge }, { assertSameTransaction }] = await Promise.all([
    import('@/lib/stellar/sep10'),
    import('@/lib/wallet/signed'),
  ]);
  const domains = await assertChallenge(transaction, networkPassphrase, w.address);
  progress?.('signing');
  const signed = await w.signAuthChallenge(transaction, networkPassphrase, domains);
  assertSameTransaction(transaction, signed, networkPassphrase);
  progress?.('checking');
  return auth.verify(signed);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [expired, setExpired] = useState(false);
  const [kind, setKind] = useState<WalletKind | null>(readKind);
  const [local, setLocal] = useState<StellarWallet | null>(null);
  const [localReady, setLocalReady] = useState(false);
  const pollar = usePollarApi();

  // The dev-key or demo wallet this tab used, back after a reload.
  useEffect(() => {
    let alive = true;
    const done = (w: StellarWallet | null) => {
      if (!alive) return;
      setLocal(w);
      setLocalReady(true);
    };
    if (kind === 'demo' && MOCK) {
      import('@/lib/mock/wallet').then((m) => done(m.restoreDemoWallet()), () => done(null));
    } else if (kind === 'dev-key' && import.meta.env.DEV) {
      import('@/lib/wallet/dev-key').then((m) => done(m.restoreDevKey()), () => done(null));
    } else done(null);
    return () => {
      alive = false;
    };
  }, [kind]);

  // Pollar restores its own session; without a key there is nothing to wait for.
  const [pollarTimedOut, setPollarTimedOut] = useState(false);
  useEffect(() => {
    if (kind !== 'pollar' || !POLLAR_KEY) return;
    const h = setTimeout(() => setPollarTimedOut(true), 6000);
    return () => clearTimeout(h);
  }, [kind]);

  const wallet =
    kind === 'pollar' ? (pollar?.wallet ?? null) : kind === 'demo' || kind === 'dev-key' ? local : null;
  const walletReady =
    kind === 'pollar'
      ? !POLLAR_KEY || !!pollar?.wallet || (!!pollar?.ready && pollarTimedOut) || pollarTimedOut
      : kind
        ? localReady
        : true;

  const refresh = useCallback(async () => {
    try {
      setSession(await auth.session());
    } catch {
      setSession(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback<SessionValue['signIn']>(async (w, progress) => {
    const s = await sep10SignIn(w, progress);
    setSession(s);
    setExpired(false);
    setKind(w.kind);
    writeKind(w.kind);
    if (w.kind !== 'pollar') {
      setLocal(w);
      setLocalReady(true);
    }
    return s;
  }, []);

  const signOut = useCallback(async () => {
    await auth.logout().catch(() => {});
    await wallet?.logout().catch(() => {});
    setSession(null);
    setKind(null);
    setLocal(null);
    writeKind(null);
  }, [wallet]);

  const expire = useCallback(() => {
    setSession(null);
    setExpired(true);
  }, []);

  // The wallet counts only while it is the signed-in address.
  const usable = wallet && session && wallet.address === session.address ? wallet : null;
  const value = useMemo(
    () => ({
      session,
      wallet: usable,
      walletReady,
      signIn,
      signOut,
      refresh,
      expire,
      expired,
    }),
    [session, usable, walletReady, signIn, signOut, refresh, expire, expired],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
