/* Who is signed in, and with which wallet.

   Sign-in is SEP-10 against our API as soon as a wallet is ready: the API answers a challenge
   transaction for the wallet's account, the page checks it is a real challenge (it can never be
   submitted: src/lib/stellar/challenge.ts), the wallet signs it, the page checks the wallet
   returned the same transaction, and the API answers a session in an HttpOnly cookie (the page
   never reads it; it asks the API who is signed in).

   The wallet itself (src/lib/wallet/types.ts) is remembered by kind on this device: a Pollar
   wallet comes back with Pollar's own session (which Pollar keeps refreshing), the dev-key and
   demo wallets from this tab's storage (they are compiled out of production builds). A reload or
   a new tab therefore keeps both the session and the wallet.

   The API session is kept alive with that wallet, without a screen: a 401, a session close to its
   end, or a page that comes back with its session gone signs in again silently (SEP-10, which
   Pollar's embedded signer answers on its own). While that runs the session reads as `renewing`
   and actions wait; if it cannot be done the session is `expired`, and the app and the dashboard
   show the sign-in instead of any screen (`sessionGate`). A session whose wallet did not come back
   (Pollar lost its own session, another tab's dev key) is expired too: nothing could be signed
   with it, so it is no session. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { forgetFilled } from '@/lib/app/remember';
import { setUnauthorizedHandler } from '@/lib/api/client';
import { auth } from '@/lib/api/endpoints';
import type { Session } from '@/lib/api/types';
import { MOCK } from '@/lib/env';
import { usePollarApi, POLLAR_KEY } from '@/lib/wallet/pollar-store';
import type { StellarWallet, WalletKind } from '@/lib/wallet/types';

const KIND_KEY = 'pier.wallet-kind';

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
  /* A call answered 401: the session is renewed silently when the wallet allows it, else it is
     marked expired (and stays on screen). */
  expire: () => void;
  /* The session could not be renewed, or its wallet is gone: the sign-in, not a screen. */
  expired: boolean;
  /* A silent renewal is running. */
  renewing: boolean;
}

const Ctx = createContext<SessionValue | null>(null);

// On the device, not per tab: a new tab finds the same wallet (cleared on sign-out).
const readKind = (): WalletKind | null => {
  try {
    const k = localStorage.getItem(KIND_KEY) ?? sessionStorage.getItem(KIND_KEY);
    return k === 'pollar' || k === 'demo' || k === 'dev-key' ? k : null;
  } catch {
    return null;
  }
};
const writeKind = (k: WalletKind | null) => {
  try {
    sessionStorage.removeItem(KIND_KEY);
    if (k) localStorage.setItem(KIND_KEY, k);
    else localStorage.removeItem(KIND_KEY);
  } catch {
    /* the wallet is asked again next time */
  }
};

/** A failed silent renewal is not tried again before this. */
const RENEW_COOLDOWN_MS = 30_000;
/** A session this close to its end is renewed ahead of time. */
const RENEW_AHEAD_MS = 24 * 3600 * 1000;

/** How long to wait before renewing a session with `remainingMs` left: a day before it ends, or
    halfway through when it is shorter than two days (a renewed session never renews at once,
    whatever its length). */
export const renewDelay = (remainingMs: number) =>
  Math.max(0, remainingMs / 2, remainingMs - RENEW_AHEAD_MS);

/** What a screen that needs a session shows: `loading` while the session is read, or while one
    that ended is renewed silently; `signin` without one, or with one that ended and could not be
    renewed (never a screen without a session); else `screen`. */
export function sessionGate(s: {
  session: Session | null | undefined;
  expired: boolean;
  renewing: boolean;
  /* False while the wallet is still coming back (a reload): the screen waits for it. */
  walletReady?: boolean;
}): 'loading' | 'signin' | 'screen' {
  if (s.session === undefined || (s.expired && s.renewing)) return 'loading';
  if (!s.session || s.expired) return 'signin';
  if (s.walletReady === false) return 'loading';
  return 'screen';
}

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
  // Read by the 401 handler: a 401 with nobody signed in is no ended session.
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  const [expired, setExpired] = useState(false);
  const [renewing, setRenewing] = useState(false);
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
    // Compile-time guards: a production build has neither module, not even as a chunk.
    if (kind === 'demo' && (import.meta.env.DEV || import.meta.env.VITE_MOCK === '1') && MOCK) {
      import('@/lib/mock/wallet').then(
        (m) => done(m.restoreDemoWallet()),
        () => done(null),
      );
    } else if (kind === 'dev-key' && import.meta.env.DEV) {
      import('@/lib/wallet/dev-key').then(
        (m) => done(m.restoreDevKey()),
        () => done(null),
      );
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

  // A Pollar wallet Pollar restored counts even when this device lost the note of its kind.
  const wallet =
    kind === 'pollar' || (!kind && pollar?.wallet)
      ? (pollar?.wallet ?? null)
      : kind === 'demo' || kind === 'dev-key'
        ? local
        : null;
  const walletReady =
    kind === 'pollar'
      ? !POLLAR_KEY || !!pollar?.wallet || (!!pollar?.ready && pollarTimedOut) || pollarTimedOut
      : kind
        ? localReady
        : true;

  /* A new API session from the wallet already at hand, without a screen. One at a time; after a
     failure, not again for a while. */
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const running = useRef<Promise<boolean> | null>(null);
  const failedAt = useRef(0);
  const renew = useCallback((): Promise<boolean> => {
    if (running.current) return running.current;
    const w = walletRef.current;
    if (!w || Date.now() - failedAt.current < RENEW_COOLDOWN_MS) return Promise.resolve(false);
    setRenewing(true);
    const job = sep10SignIn(w)
      .then(
        (s) => {
          setSession(s);
          setExpired(false);
          return true;
        },
        () => {
          failedAt.current = Date.now();
          return false;
        },
      )
      .finally(() => {
        running.current = null;
        setRenewing(false);
      });
    running.current = job;
    return job;
  }, []);

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

  // A page that comes back without its API session but with its wallet signs in again by itself.
  // If it cannot (or the wallet did not come back), the session this device had has ended: the
  // sign-in opens saying so.
  const [restoreTried, setRestoreTried] = useState(false);
  useEffect(() => {
    if (session !== null || restoreTried || !walletReady) return;
    setRestoreTried(true);
    if (wallet) void renew().then((ok) => !ok && setExpired(true));
    else if (kind) setExpired(true);
  }, [session, restoreTried, walletReady, wallet, kind, renew]);
  // Until then the app shows its loading screen, not the welcome.
  const restoring =
    session === null && !!kind && (!walletReady || renewing || (!!wallet && !restoreTried));

  // Renewed a day before it ends, and checked whenever the page comes back into view.
  const endsAt = session?.expiresAt ? Date.parse(session.expiresAt) : NaN;
  useEffect(() => {
    if (!Number.isFinite(endsAt)) return;
    const wait = Math.min(renewDelay(endsAt - Date.now()), 2 ** 31 - 1);
    const h = setTimeout(() => void renew(), wait);
    return () => clearTimeout(h);
  }, [endsAt, renew]);
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState !== 'visible' || !walletRef.current) return;
      auth.session().then(
        (s) => {
          if (s) setSession(s);
          else void renew().then((ok) => !ok && setExpired(true));
        },
        () => {},
      );
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [renew]);

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
    // What this device kept to fill forms in (payer, payout account, email) leaves with the person.
    forgetFilled();
    setSession(null);
    setExpired(false);
    setKind(null);
    setLocal(null);
    writeKind(null);
  }, [wallet]);

  // A 401: renewed silently when the wallet can; otherwise marked expired, the screen kept.
  const expire = useCallback(() => {
    void renew().then((ok) => {
      if (!ok) setExpired(true);
    });
  }, [renew]);

  // Any call answered 401, from any screen, renews the session or ends it.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (sessionRef.current) expire();
    });
    return () => setUnauthorizedHandler(null);
  }, [expire]);

  // The wallet counts only while it is the signed-in address. A session without it is no session.
  const usable = wallet && session && wallet.address === session.address ? wallet : null;
  const walletGone = !!session && walletReady && !usable;
  const value = useMemo(
    () => ({
      session: restoring ? undefined : session,
      wallet: usable,
      walletReady,
      signIn,
      signOut,
      refresh,
      expire,
      expired: expired || walletGone,
      renewing,
    }),
    [
      restoring,
      session,
      usable,
      walletReady,
      signIn,
      signOut,
      refresh,
      expire,
      expired,
      walletGone,
      renewing,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
