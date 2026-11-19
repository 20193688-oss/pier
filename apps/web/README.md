# @pedospe/web

The pedospe web app: the public site and buy/sell app, the hosted charge page, the merchant and
business dashboard, and the docs. Vite + React 19 + React Router + Tailwind v4, TypeScript strict,
wallets through EIP-6963 with viem. UI in Spanish (default) and English.

| Path | What |
| --- | --- |
| `/` | landing |
| `/app` | buy and sell USDC (`?order=<id>` follows an order, `?side=sell`) |
| `/pay/{chargeId}` (also `/c/{chargeId}`) | the hosted charge page the API links to |
| `/dashboard/*` | overview, liquidity, offers, payment methods, orders, charges, payouts, API keys, webhooks, team |
| `/docs/*` | guides and the API reference (from `apps/api/openapi.json`) |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev -w @pedospe/web` | dev server on `PORT` (default 3000), `/v1/*` proxied to the API |
| `npm run dev:mock -w @pedospe/web` | every screen against the in-browser mock API and a demo wallet, no backend |
| `npm run build -w @pedospe/web` | type check and production build into `dist/` |
| `npm test -w @pedospe/web` | unit tests (Vitest) |
| `npm run test:e2e -w @pedospe/web` | the main flows in a real browser (Playwright, mock mode, phone and desktop) |
| `npm run lint -w @pedospe/web` | ESLint (relative imports are an error) |
| `npm run gen:api -w @pedospe/web` | regenerate `src/lib/api/openapi.gen.ts` from `apps/api/openapi.json` |

`@pedospe/contracts` must be built first (`npm run build -w @pedospe/contracts`): the app decodes
transactions with its ABI.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | dev server port (the API's default SIWE domain and web origin are `localhost:3000`) |
| `PEDOSPE_API_URL`, `API_URL`, `VITE_API_URL`, `PUBLIC_API_URL` | `http://localhost:4000` | the API the dev server proxies `/v1/*` to (first one set) |
| `VITE_APP_TIER` | `live` | the buy/sell app's tier (the API's `APP_TIER`); a dev server falls back to `test` when `live` has no market |
| `VITE_API_BASE_URL` | empty | production: the API's origin when it is not the web app's own |
| `PEDOSPE_OPENAPI_PATH` | `../api/openapi.json` | the spec the docs reference and `gen:api` read |

With the root `npm run dev:stack`, the web app runs against the local chain (31337) and a purchase
shows a "simulate the bank transfer" button (the API's dev-only route).

## Security model in the browser

- The session is the API's HttpOnly cookie after Sign-In with Ethereum; the page never reads or
  stores a token. A new API key or webhook secret is shown once and never kept.
- Every transaction a wallet is asked to sign is built by the API and then decoded here with the
  contract's ABI (`src/lib/p2p/tx-verify.ts`): chain, target, function, order id, amounts, token,
  and for a sale every term (buyer, bond, windows, integrator and fee, ref derived from the order
  id) must equal what the person saw and the market publishes, or nothing is sent.
- Mock mode and its demo wallet are compiled out of production builds.
