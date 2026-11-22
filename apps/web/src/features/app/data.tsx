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
import { HOME_CURRENCY } from '@/lib/p2p/rails';
import { toBaseUnits } from '@/lib/p2p/amounts';
import type { AppBalances, AppProfile } from '@/lib/app/types';
import { pickToken } from '@/lib/app/token';
import type { P2pMarket, P2pNetwork, P2pToken } from '@/lib/p2p/types';

// v3 since PEN became the default (2026-11-22): a pick made before that is dropped once.
const CURRENCY_KEY = 'pier.app.currency.v3';
const TOKEN_KEY = 'pier.app.token';

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
  /* Pay with this token from now on (the home screen's token chips). */
  setToken: (symbol: string) => void;
}

const Ctx = createContext<AppData | null>(null);

const priceCache = new Map<string, { price: number | null; at: number }>();

/** Local money per token in `currency` from the market's bank rail (a sale quote for 10 tokens,
    kept for a minute): what a balance is roughly worth. Null when no merchant quotes it. */
export async function approxPrice(
  market: P2pMarket,
  networkId: string,
  token: P2pToken,
  currency: string,
): Promise<number | null> {
  const cur = market.currencies.find((c) => c.code === currency);
  const rail = cur?.rails.find((r) => !isQrRail(r));
  if (!cur || !rail) return null;
  const key = `${networkId}:${token.symbol}:${currency}`;
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.price;
  try {
    const q = await trade.quote(
      {
        side: 'SELL',
        network: networkId,
        token: token.symbol,
        currency,
        rail,
        tokenAmount: toBaseUnits('10', token.decimals) ?? '0',
      },
      token.decimals,
    );
    const p = Number(q.price);
    const v = Number.isFinite(p) && p > 0 ? p : null;
    priceCache.set(key, { price: v, at: Date.now() });
    return v;
  } catch {
    return null;
  }
}

export function AppDataProvider({ children }: { children: ReactNode }) {
  const { session, expire, expired } = useSession();
  const [market, setMarket] = useState<P2pMarket | null | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  const [profile, setProfile] = useState<AppProfile | null | undefined>(undefined);
  const [balances, setBalances] = useState<AppBalances | null | undefined>(undefined);
  const [poke, setPoke] = useState(0);
  const [currency, setCurrencyState] = useState(() => {
    try {
      return localStorage.getItem(CURRENCY_KEY) ?? HOME_CURRENCY;
    } catch {
      return HOME_CURRENCY;
    }
  });
  const [price, setPrice] = useState<number | null>(null);
  // The token the person picked on the home screen (src/lib/app/token.ts, step 0).
  const [chosen, setChosen] = useState<string | null>(() => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  });

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
  // An ended session (or one whose wallet is gone) loads nothing: the sign-in is on screen.
  const address = session && !expired ? session.address : null;
  const token = useMemo(
    () => pickToken(network, balances ?? null, undefined, chosen),
    [network, balances, chosen],
  );

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
    let alive = true;
    void approxPrice(market, network.id, token, currency).then((v) => alive && setPrice(v));
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
  const setToken = useCallback((symbol: string) => {
    setChosen(symbol);
    try {
      localStorage.setItem(TOKEN_KEY, symbol);
    } catch {
      /* this page only */
    }
  }, []);

  const tokenBalance = balances?.tokens.find(
    (t) => t.symbol === token?.symbol || t.contract === token?.contract,
  );
  const needsActivation =
    !!balances &&
    (!balances.account.exists || !tokenBalance?.trustline || !tokenBalance.authorized);
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
      setToken,
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
      setToken,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppData(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppData outside AppDataProvider');
  return v;
}

/** The approximate price of the app's token in `currency` (approxPrice): undefined while asking,
    null when there is none. */
export function usePrice(currency: string | null): number | null | undefined {
  const { market, network, token } = useAppData();
  const [price, setPrice] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (!currency || !market || !network || !token)
      return setPrice(market === null ? null : undefined);
    let alive = true;
    setPrice(undefined);
    void approxPrice(market, network.id, token, currency).then((v) => alive && setPrice(v));
    return () => {
      alive = false;
    };
  }, [currency, market, network, token]);
  return price;
}
