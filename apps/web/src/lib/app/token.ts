/* The token the payments app pays with, when the market lists several:

   1. VITE_APP_TOKEN, when the market lists it (a dev stack can say TUSD);
   2. else a token the wallet actually holds (a trustline and an amount above zero), the largest
      holding first;
   3. else USDC;
   4. else the first token listed.

   Pure; tests/unit/scan-route.test.ts. */
import type { AppBalances } from '@/lib/app/types';
import type { P2pNetwork, P2pToken } from '@/lib/p2p/types';

export function pickToken(
  network: Pick<P2pNetwork, 'tokens'> | null,
  balances: Pick<AppBalances, 'tokens'> | null,
  configured: string = String(import.meta.env.VITE_APP_TOKEN ?? '').trim(),
): P2pToken | null {
  const tokens = network?.tokens ?? [];
  const bySymbol = (s: string) => tokens.find((t) => t.symbol === s) ?? null;
  if (configured && bySymbol(configured)) return bySymbol(configured);
  const held = tokens
    .map((t) => {
      const b = balances?.tokens.find((x) => x.contract === t.contract || x.symbol === t.symbol);
      const amount = b?.trustline && /^\d+$/.test(b.amount) ? BigInt(b.amount) : 0n;
      return { t, amount };
    })
    .filter((x) => x.amount > 0n)
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  if (held.length) return held[0].t;
  return bySymbol('USDC') ?? tokens[0] ?? null;
}
