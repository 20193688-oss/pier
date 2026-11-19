/* The dashboard's context: the organization and tier every call is scoped to (the Pedospe-
   Organization and Pedospe-Tier headers), the market's published rules for that tier, and what
   the member's role allows. The choice of organization and tier is kept for next time. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { market as marketApi, type Scope } from '@/lib/api/endpoints';
import type { Tier } from '@/lib/api/client';
import type { OrgMembership } from '@/lib/api/types';
import type { P2pMarket } from '@/lib/p2p/types';

const ORG_KEY = 'pedospe.dash.org';
const TIER_KEY = 'pedospe.dash.tier';

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* the choice lasts for this page */
  }
};

export interface DashValue {
  org: OrgMembership;
  orgs: OrgMembership[];
  setOrg: (id: string) => void;
  tier: Tier;
  setTier: (tier: Tier) => void;
  scope: Scope;
  /* undefined while it loads, null when it could not be read. */
  market: P2pMarket | null | undefined;
  /* Owners and admins change things; members read. */
  canWrite: boolean;
  isOwner: boolean;
}

const Ctx = createContext<DashValue | null>(null);

export function DashProvider({ orgs, children }: { orgs: OrgMembership[]; children: ReactNode }) {
  const [orgId, setOrgId] = useState(() => {
    const saved = read(ORG_KEY);
    return orgs.some((o) => o.id === saved) ? saved! : orgs[0].id;
  });
  const [tier, setTierState] = useState<Tier>(() => (read(TIER_KEY) === 'live' ? 'live' : 'test'));
  const [market, setMarket] = useState<P2pMarket | null | undefined>(undefined);
  const org = orgs.find((o) => o.id === orgId) ?? orgs[0];

  useEffect(() => {
    let alive = true;
    setMarket(undefined);
    marketApi
      .get(tier)
      .then((m) => alive && setMarket(m))
      .catch(() => alive && setMarket(null));
    return () => {
      alive = false;
    };
  }, [tier]);

  const setOrg = useCallback((id: string) => {
    setOrgId(id);
    write(ORG_KEY, id);
  }, []);
  const setTier = useCallback((t: Tier) => {
    setTierState(t);
    write(TIER_KEY, t);
  }, []);

  const value = useMemo<DashValue>(
    () => ({
      org,
      orgs,
      setOrg,
      tier,
      setTier,
      scope: { org: org.id, tier },
      market,
      canWrite: org.role === 'owner' || org.role === 'admin',
      isOwner: org.role === 'owner',
    }),
    [org, orgs, setOrg, tier, setTier, market],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDash(): DashValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDash outside DashProvider');
  return v;
}
