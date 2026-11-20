/* What every screen of the payments app reads: the market (its network and token), the signed-in
   wallet's profile and balance, whether the wallet needs its sponsored activation, and the price
   of a dollar in the person's local money. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { market as marketApi, trade } from '@/lib/api/endpoints';
import { app } from '@/lib/api/app';
import { ApiError } from '@/lib/api/client';
import { isUnauthorized } from '@/lib/api/messages';
import { useSession } from '@/lib/session';
import { isQrRail } from '@/lib/p2p/qr-pay';
import { toBaseUnits } from '@/lib/p2p/amounts';
import type { AppBalances, AppProfile } from '@/lib/app/types';
import { pickToken } from '@/lib/app/token';
import type { P2pMarket, P2pNetwork, P2pToken } from '@/lib/p2p/types';

const CURRENCY_KEY = 'pedospe.app.currency';

interface AppData {
  /* undefined while loading, null when it could not be read. */
  market: P2pMarket | null | undefined;
  network: P2pNetwork | null;
  token: P2pToken | null;
  /* The market could not be reached at all (no connection). */
  offline: boolean;
  profile: AppProfile | null | undefined;
  balances: AppBalances | null | undefined;
  /* The token balance, base units ('0' while unknown). */
  balance: string;
  /* The account is missing, or has no (authorized) trustline for the token. */
  needsActivation: boolean;
  currency: string;
  setCurrency: (code: string) => void;
  /* Local money per USDC (the price a sale would get), null when no merchant quotes it. */
  price: number | null;
  refresh: () => void;
  setProfile: (p: AppProfile) => void;
}

const Ctx = createContext<AppData | null>(null);

const priceCache = new Map<string, { price: number | null; at: number }>();

export function AppDataProvider({ children }: { children: ReactNode }) {
  const { session, expire } = useSession();
  const [market, setMarket] = useState<P2pMarket | null | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  const [profile, setProfile] = useState<AppProfile | null | undefined>(undefined);
  const [balances, setBalances] = useState<AppBalances | null | undefined>(undefined);
  const [poke, setPoke] = useState(0);
  const [currency, setCurrencyState] = useState(() => {
    try {
      return localStorage.getItem(CURRENCY_KEY) ?? 'ARS';
    } catch {
      return 'ARS';
    }
  });
  const [price, setPrice] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    marketApi
      .app()
      .then((m) => {
        if (!alive) return;
        setMarket(m.available ? m : null);
        setOffline(false);
      })
      .catch((e) => {
        if (!alive) return;
        setMarket(null);
        setOffline(e instanceof ApiError && e.status === 0);
      });
    return () => {
      alive = false;
    };
  }, [poke]);

  const network = market?.networks[0] ?? null;
  const address = session?.address ?? null;
  const token = useMemo(() => pickToken(network, balances ?? null), [network, balances]);

  useEffect(() => {
    if (!address || !network) {
      setProfile(address ? undefined : null);
      setBalances(address ? undefined : null);
      return;
    }
    let alive = true;
    const fail = (e: unknown) => {
      if (isUnauthorized(e)) expire();
    };
    app
      .profile()
      .then((p) => alive && setProfile(p))
      .catch((e) => {
        fail(e);
        if (alive) setProfile(null);
      });
    app
      .balances(network.id)
      .then((b) => alive && setBalances(b))
      .catch((e) => {
        fail(e);
        if (alive) setBalances(null);
      });
    return () => {
      alive = false;
    };
  }, [address, network, poke, expire]);

  // The local price: a sale quote for 10 USDC, kept for a minute.
  useEffect(() => {
    // After the balances: they decide which token the price is for.
    if (!market || !network || !token || !address || balances === undefined) return;
    const cur = market.currencies.find((c) => c.code === currency);
    const rail = cur?.rails.find((r) => !isQrRail(r));
    if (!cur || !rail) return setPrice(null);
    const key = `${network.id}:${token.symbol}:${currency}`;
    const hit = priceCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return setPrice(hit.price);
    let alive = true;
    trade
      .quote(
        {
          side: 'SELL',
          network: network.id,
          token: token.symbol,
          currency,
          rail,
          tokenAmount: toBaseUnits('10', token.decimals) ?? '0',
        },
        token.decimals,
      )
      .then((q) => {
        const p = Number(q.price);
        const v = Number.isFinite(p) && p > 0 ? p : null;
        priceCache.set(key, { price: v, at: Date.now() });
        if (alive) setPrice(v);
      })
      .catch(() => alive && setPrice(null));
    return () => {
      alive = false;
    };
  }, [market, network, token, currency, address, balances]);

  const setCurrency = useCallback((code: string) => {
    setCurrencyState(code);
    try {
      localStorage.setItem(CURRENCY_KEY, code);
    } catch {
      /* this page only */
    }
  }, []);
  const refresh = useCallback(() => setPoke((x) => x + 1), []);

  const tokenBalance = balances?.tokens.find(
    (t) => t.symbol === token?.symbol || t.contract === token?.contract,
  );
  const needsActivation =
    !!balances && (!balances.account.exists || !tokenBalance?.trustline || !tokenBalance.authorized);
  const value = useMemo<AppData>(
    () => ({
      market,
      network,
      token,
      offline,
      profile,
      balances,
      balance: tokenBalance?.amount ?? '0',
      needsActivation,
      currency,
      setCurrency,
      price,
      refresh,
      setProfile,
    }),
    [
      market,
      network,
      token,
      offline,
      profile,
      balances,
      tokenBalance,
      needsActivation,
      currency,
      setCurrency,
      price,
      refresh,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppData(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppData outside AppDataProvider');
  return v;
}
