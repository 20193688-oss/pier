/* The token the payments app pays with, when the market lists several. The person's own pick
   comes first, then what the wallet holds, so a balance always shows:

   0. the token the person chose on the home screen, when the market lists it;
   1. VITE_APP_TOKEN (e.g. USDC), when the market lists it and the wallet holds some;
   2. else a token the wallet actually holds (a trustline and an amount above zero): dollar tokens
      before the native coin, the largest holding first;
   3. else VITE_APP_TOKEN, when the market lists it (a wallet that holds nothing yet);
   4. else USDC;
   5. else the first token listed.

   Pure; tests/unit/scan-route.test.ts. */
import type { AppBalances } from '@/lib/app/types';
import type { P2pNetwork, P2pToken } from '@/lib/p2p/types';

export function pickToken(
  network: Pick<P2pNetwork, 'tokens'> | null,
  balances: Pick<AppBalances, 'tokens'> | null,
  configured: string = String(import.meta.env.VITE_APP_TOKEN ?? '').trim(),
  chosen: string | null = null,
): P2pToken | null {
  const tokens = network?.tokens ?? [];
  const bySymbol = (s: string) => tokens.find((t) => t.symbol === s) ?? null;
  if (chosen && bySymbol(chosen)) return bySymbol(chosen);
  const held = tokens
    .map((t) => {
      const b = balances?.tokens.find((x) => x.contract === t.contract || x.symbol === t.symbol);
      const amount = b?.trustline && /^\d+$/.test(b.amount) ? BigInt(b.amount) : 0n;
      return { t, amount };
    })
    .filter((x) => x.amount > 0n)
    // A dollar token before the native coin (their units are worth different amounts), then the
    // largest holding.
    .sort((a, b) =>
      (a.t.issuer === null) !== (b.t.issuer === null)
        ? a.t.issuer === null
          ? 1
          : -1
        : b.amount > a.amount
          ? 1
          : b.amount < a.amount
            ? -1
            : 0,
    );
  const preferred = configured ? bySymbol(configured) : null;
  if (preferred && held.some((x) => x.t === preferred)) return preferred;
  if (held.length) return held[0].t;
  return preferred ?? bySymbol('USDC') ?? tokens[0] ?? null;
}
