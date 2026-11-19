/* Who is signed in, and with which wallet.

   Sign-in with Ethereum: the person picks one of the wallets the browser announces (EIP-6963),
   the API gives a single-use nonce, the wallet signs the EIP-4361 message for this site, and the
   API answers a session in an HttpOnly cookie (the page never reads it; it asks the API who is
   signed in). The wallet used to sign in is remembered for this tab, so later transactions go to
   the same wallet without asking again. */
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
import { watchWallets, type DiscoveredWallet } from '@/lib/wallet/eip6963';
import { connectWallet, currentChainId, signText, siweMessage } from '@/lib/wallet/actions';
import { DEMO_WALLET_RDNS, MOCK } from '@/lib/env';
import { useT } from '@/i18n';

const WALLET_KEY = 'pedospe.wallet';

interface SessionValue {
  /* undefined while the API is asked, null when nobody is signed in. */
  session: Session | null | undefined;
  wallets: DiscoveredWallet[];
  /* Whether discovery had time to hear from the browser's wallets. */
  walletsReady: boolean;
  /* The wallet used to sign in, when it is still in this browser. */
  wallet: DiscoveredWallet | null;
  signIn: (
    w: DiscoveredWallet,
    progress?: (step: 'connecting' | 'signing' | 'checking') => void,
  ) => Promise<Session>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  /* A call answered 401: the session is over. */
  expire: () => void;
  expired: boolean;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [walletsReady, setWalletsReady] = useState(false);
  const [walletId, setWalletId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(WALLET_KEY);
    } catch {
      return null;
    }
  });
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const stop = watchWallets((list) =>
      setWallets(MOCK ? list.filter((w) => w.info.rdns === DEMO_WALLET_RDNS) : list),
    );
    const ready = setTimeout(() => setWalletsReady(true), 700);
    return () => {
      stop();
      clearTimeout(ready);
    };
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

  const signIn = useCallback<SessionValue['signIn']>(
    async (w, progress) => {
      progress?.('connecting');
      const address = await connectWallet(w.provider);
      const { nonce, domain } = await auth.nonce();
      const chainId = await currentChainId(w.provider).catch(() => 1);
      // The API names the domain its sign-in accepts (its SIWE domain, the web app's host); the
      // wallet compares it with the page and warns when they differ.
      const message = siweMessage({
        address,
        nonce,
        statement: t.common.wallet.statement,
        chainId,
        domain: domain ?? window.location.host,
        uri: domain ? `${window.location.protocol}//${domain}` : window.location.origin,
      });
      progress?.('signing');
      const signature = await signText(w.provider, address, message);
      progress?.('checking');
      const s = await auth.verify(message, signature);
      setSession(s);
      setExpired(false);
      setWalletId(w.info.uuid);
      try {
        sessionStorage.setItem(WALLET_KEY, w.info.uuid);
      } catch {
        /* the wallet is asked again next time */
      }
      return s;
    },
    [t],
  );

  const signOut = useCallback(async () => {
    await auth.logout().catch(() => {});
    setSession(null);
    setWalletId(null);
    try {
      sessionStorage.removeItem(WALLET_KEY);
    } catch {
      /* nothing kept */
    }
  }, []);

  const expire = useCallback(() => {
    setSession(null);
    setExpired(true);
  }, []);

  const wallet =
    wallets.find((w) => w.info.uuid === walletId) ?? (wallets.length === 1 ? wallets[0] : null);
  const value = useMemo(
    () => ({ session, wallets, walletsReady, wallet, signIn, signOut, refresh, expire, expired }),
    [session, wallets, walletsReady, wallet, signIn, signOut, refresh, expire, expired],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
