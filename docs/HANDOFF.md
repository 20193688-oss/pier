# pedospe: handoff

The state of the project and everything a new session needs to continue it, written at the end of
the first build session (2026-11-19). Read this first, then [`AGENTS.md`](../AGENTS.md) (binding
conventions) and the workspace READMEs it links.

## 1. What pedospe is

A peer-to-peer market for stablecoins (USDC/USDT) against local money (bank transfers, PIX, SPEI...),
modelled on p2p.me but with a **public API**. The owner's original request (Spanish):

> "necesito que me hagas una app de p2p estilo p2p.me pero con api publica, crea el smart contract
> para el escrow y herramientas de pagos automatizadas para nuestros clientes"

Owner decisions so far:

| Topic                 | Decision                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| Product               | Independent project named **pedospe** (not part of any other company's product)                                 |
| Chain                 | One EVM contract (`P2PMarket`) deployed per network                                                             |
| Who confirms the fiat | The party that receives the local money (or its bot) releases; deadlines refund; disputes go to an arbiter      |
| Matching              | The user types an amount and the market picks the merchant (no ads book, p2p.me style)                          |
| Client tools          | All three: merchant bots via API, embedded buy/sell for businesses, collections (charges) and payouts           |
| Repo                  | Private `Emanuel250YT/pedospe`, local folder `C:\Users\emanu\OneDrive\Desktop\pedospe`, npm workspaces monorepo |
| UI languages          | Spanish (default) and English                                                                                   |

## 2. History you should know

1. The market was first built inside another company's repositories (the owner's employer,
   Cosmos Pay). The owner then said it must be independent: "no debe ser de cosmos pay, esto es un
   proyecto independiente" / "se llama pedospe". Those pull requests were closed unmerged and their
   remote branches deleted. Local copies remain at `C:/Users/emanu/wt/p2p-cs` and
   `C:/Users/emanu/wt/p2p-dp` (branch `feat/p2p-market`) and were mined only for the P2P domain logic
   written for this product. **Never put pedospe work in Cosmos Pay repositories and never copy their
   pre-existing infrastructure here.**
2. The contract and its tests were moved into `packages/contracts` unchanged (same bytecode).
3. `apps/api` + `packages/sdk` + the local test stack, and `apps/web`, were built by two parallel
   agents on branches `feat/api` and `feat/web` (worktrees `C:/Users/emanu/wt/pedospe-api` and
   `C:/Users/emanu/wt/pedospe-web`), then merged into `main` (merge commit `1dcd8a1`). Both branches
   are pushed; the worktrees can be removed (`git worktree remove <path>`).
4. Automated security reviews ran on every commit. Their findings were fixed (see section 7).

## 3. Layout and stack

| Workspace                                   | Stack                                                                                                       | Docs                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `packages/contracts` (`@pedospe/contracts`) | Solidity 0.8.37 (`paris`), solc-js, Vitest; consumed from `dist/`                                           | contract docblock in `contracts/P2PMarket.sol`        |
| `apps/api` (`@pedospe/api`)                 | NestJS 12, Prisma 7 + Postgres, viem, Vitest + SWC, ESM; OpenAPI at `apps/api/openapi.json` (72 operations) | [`apps/api/README.md`](../apps/api/README.md)         |
| `packages/sdk` (`@pedospe/sdk`)             | openapi-fetch client typed from the spec, webhook verification, reference merchant bot                      | [`packages/sdk/README.md`](../packages/sdk/README.md) |
| `apps/web` (`@pedospe/web`)                 | Vite 8 + React 19 + React Router 8 + Tailwind 4, viem with EIP-6963, Playwright                             | [`apps/web/README.md`](../apps/web/README.md)         |

Tooling: Node 26, TypeScript **6.0.3** (not 7: Nest/ts tooling), ESLint (forbids relative imports in
`src`/`test`), Prettier. Root scripts: `build`, `test`, `typecheck`, `lint` across workspaces
(contracts build first; the web imports its `dist/`).

## 4. Run it locally (the test server)

```
npm install
npm run dev:stack            # build, then bring the whole market up
npm run dev:stack -- --stop  # stop it (or Ctrl+C in its own terminal)
npm run dev:stack -- --reset # fresh chain and database
npm run dev:stack -- --no-web
npm run dev:simulate -- <orderId>   # play the merchant: the bank transfer arrived, release
```

What it starts: Postgres (docker compose if a daemon answers, otherwise **embedded Postgres on
:54329**), **anvil on :8545, chain id 31337** (from npm), deploys `P2PMarket` and a test dollar
`tUSD` (6 decimals), seeds through the API itself (organizations, `pk_test_` keys, wallets proven
by signature, payment methods, ARS/BRL offers, liquidity deposited, matcher authorised, a charge),
the API on **:4000** with its jobs, and the web on **:3000**. It prints the URLs, the API keys and the
dev wallets (anvil's public default accounts: owner, matcher, merchant, business, user, arbiter,
treasury). State persists in `.dev-stack/` (gitignored, ~100 MB) across restarts.

Clicking through: add the network (RPC `http://127.0.0.1:8545`, chain id 31337) to a browser wallet,
import the printed `user` key, open `http://localhost:3000/app`, buy, press "Ya transferí", then the
dev-only "simulate the bank transfer" button (shown only on chain 31337). The dashboard: sign in with
the `merchant` or `business` key.

## 5. Verification status

| Check                                | Result                                                                                                                               | Where                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `npm run build`, `typecheck`, `lint` | pass                                                                                                                                 | merged `main`, by the orchestrator                                                                     |
| Contracts tests                      | 37 pass (incl. artifact check, randomized conservation property; mutation-checked)                                                   | merged `main`                                                                                          |
| SDK tests                            | 51 pass                                                                                                                              | merged `main`                                                                                          |
| API unit tests                       | 78 pass                                                                                                                              | merged `main`                                                                                          |
| API e2e (real Postgres + anvil)      | 319 pass (306 wiring: every route vs wrong callers, scopes, roles, tiers, orgs, CSRF, revoked keys)                                  | `feat/api` by its agent; **not re-run after the merge**                                                |
| Web tests                            | 117 pass (Vitest; incl. docs vs the real spec)                                                                                       | merged `main`                                                                                          |
| Web Playwright                       | 16/16 (8 flows x phone/desktop, es/en), mock mode                                                                                    | `feat/web` by its agent                                                                                |
| Real local stack                     | BUY and SELL reached `completed`; charge paid; dashboard deposit; the SDK bot released a BUY from a bank line; restart resumed state | both agents; after the merge the orchestrator only confirmed the pages and `GET /v1/market` answer 200 |
| `npm audit --omit=dev`               | 0 vulnerabilities                                                                                                                    | merged `main`                                                                                          |
| Licenses                             | no GPL. Weak copyleft: MPL-2.0 `@ethereumjs/*` (contracts testing export only), EPL-2.0 `elkjs` (Prisma CLI)                         |                                                                                                        |

**Never verified:** any real network (testnet or mainnet), a real bank, smart-contract wallets.

## 6. Design

### 6.1 Contract (`packages/contracts/contracts/P2PMarket.sol`)

- Orders between a **seller** (tokens locked) and a **buyer** (sends local money off-chain).
  Statuses: `None 0, Offered 1, Active 2, Paid 3, Disputed 4, Released 5, Cancelled 6, Resolved 7`.
- Free balances (`deposit`, `withdraw`, `withdrawFor`). `open` locks from the seller's balance;
  `openWithDeposit` pulls from the caller (= seller) in the same call.
- Optional buyer **bond** (merchant bond on sells): order starts `Offered` until `accept`.
- `markPaid` (buyer side, before the payment deadline), `release` (seller or a RELEASE operator),
  `settle` (anyone, after `paidAt + settleWindow` with no dispute; settle window opt-in by the
  seller), `cancel` (rules per status; anyone after deadlines; always refunds the seller), `dispute`
  (from Paid), `resolve(id, toBuyer, bondToSeller)` by the **arbiter** only, paying only that
  order's parties.
- **Operators** (bots): bitmask `PERM_OPEN 1`, `PERM_RELEASE 2`, `PERM_TRADE 4`, `PERM_WITHDRAW 8`.
- **Matcher**: `setMatcher(matcher, maxPerOrder, autoSettle)` lets the matching service open orders
  on a seller's balance up to a per-order cap; on orders it opened it acts for the buyer (mark paid,
  cancel before paid, dispute) so gasless buyers can trade.
- Refs unique **per opener** (`orderIdOf(opener, ref)`): nobody can front-run the service's refs.
- Fees: protocol fee (owner-set, **cap 300 bps**) + integrator fee (**cap 500 bps**), both taken
  from what the buyer receives, snapshotted at open.
- A push the token refuses (blocklisted recipient) is **credited** to the recipient's balance.
- Owner: fee, treasury, arbiter, allowed tokens, pause. Pause stops new money in, never money out.
  The owner can never move funds. Two-step ownership.
- Window bounds: payment 5 min to 2 days; accept 1 min to 1 day (bond only); settle 0 or 1 h to 14 days.

### 6.2 Roles and keys

| Role                               | Holder                              | Key location                                                        |
| ---------------------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| owner, arbiter                     | the operator (multisigs on mainnet) | outside the server; the API only builds unsigned `resolve` calldata |
| treasury                           | address only                        |                                                                     |
| matcher                            | the API                             | `P2P_MATCHER_PRIVATE_KEY`: gas + matcher authority only             |
| merchants, businesses, users, bots | themselves                          | their wallets; the API builds unsigned transactions                 |

**Trust edge:** a leaked matcher key plus a leaked arbiter key could drain merchant liquidity
through fake disputes; a leaked matcher alone can only lock liquidity until deadlines (and release
orders of sellers that enabled `autoSettle` and do not dispute in time). Hence: arbiter and owner
are multisigs, `autoSettle` is never offered to liquidity merchants, the matcher records every
transaction before broadcasting.

### 6.3 API

- **Tenancy/auth:** `Organization` (tenant) with members (owner/admin/member) who sign in with
  **SIWE** (single-use nonce; HttpOnly cookie with an Origin CSRF check, or `Bearer ps_sess_`).
  API keys `pk_live_` / `pk_test_` (SHA-256 stored, shown once), scopes `p2p:read` / `p2p:write`;
  the prefix decides the **tier** (`live`/`test`); every query filters by organization AND tier.
  Members use headers `Pedospe-Organization` and `Pedospe-Tier`. End users of the public app sign
  in with SIWE and act only on orders bound to their wallet (`/v1/app/*`). Admins: wallets in
  `ADMIN_ADDRESSES`. A global guard refuses any route without a policy.
- **Flows:** BUY (matcher `open` on the merchant's liquidity; payer name/document required),
  SELL (user signs `approve` + `openWithDeposit`; merchant accepts with a bond), CHARGE (keyless
  checkout `/v1/p2p-checkout/*` with a hashed payer token and per-client/per-charge budgets; page
  `${CHECKOUT_URL}/<chargeId>` = web `/pay/{id}`), PAYOUT (matcher opens on the client's balance).
- **Defaults** (`apps/api/src/p2p/domain/constants.ts`): BUY payment window 30 min; SELL bond 10%,
  accept 5 min, payment 30 min, settle 6 h; payout settle 6 h (only with autoSettle); quote TTL
  60 s; merchant max open orders 5; charge window 30 min.
- **Matching:** active offer of the right side/currency/rail/network/token, fresh price, within
  limits, merchant active and under its open-order cap, enough on-chain balance and matcher cap
  (BUY) or bond balance (SELL); ranked by price, then reputation, then load.
- **Chain layer (viem):** chain-id-checked clients; a deployment is served only if its bytecode
  equals the artifact and its tokens are allowed; matcher signs, persists, then broadcasts (only
  stored bytes are rebroadcast); indexer (bounded `getLogs`, confirmations, reorg window,
  compare-and-swap transitions committed with their webhook outbox rows, field-by-field check of
  `OrderOpened` for sells); expiry job; matcher follower; webhook sender. Jobs hold Postgres
  advisory locks.
- **Webhooks:** transactional outbox; `pedospe-signature: t=<unix>,v1=<HMAC-SHA256(secret, t.body)>`;
  exponential backoff; SSRF guard at connect time; events `P2P_ORDER_*`, `P2P_CHARGE_SUCCEEDED`,
  `P2P_PAYOUT_BATCH_COMPLETED`, body `{id, type, createdAt, data}` with a `role`; bodies carry no
  personal details (parties read those on the routes).
- **Payment details** sealed at rest with AES-256-GCM (`DATA_ENCRYPTION_KEY`), bound to row and
  field; visible only to the counterparty of a live order.
- Full route list, env vars and deploy CLI: [`apps/api/README.md`](../apps/api/README.md).

### 6.4 Web

Routes: `/` (landing), `/app` (buy/sell), `/pay/{id}` (+ `/c/{id}`) charge page, the dashboard
(liquidity, offers, payment methods, orders, charges, payouts, API keys, webhooks, team), `/docs`
(guides + API reference from the spec). Look: "paper and ink", Archivo typeface, yellow highlighter
reserved for the exact amount, "p/d" mark, dark/light, mobile-first. Mock mode is compiled out of
production builds. Dev server honours `PORT` (default 3000) and proxies `/v1` to the API URL env.

## 7. Security invariants (keep them)

- Non-custodial: no server key can move anyone's tokens; the contract is the boundary.
- Every query is scoped by organization AND tier; another tenant's or tier's row is a 404.
- Keyless routes never let an id alone spend: budgets, caps, one live order per single-use charge.
- Merchant and client webhook bodies are per-role allowlists.
- **Before any wallet signature, the web decodes the API-built transaction with the contract ABI
  and pins every field to a trusted source** (three review rounds produced these rules):
  - sale `openWithDeposit`: seller = the signed-in wallet; token/amount/chain/contract from the
    quote the user accepted and the market config; buyer = the order's buyer address; bond and
    windows = the market's published `sellBondBps`/windows (never the quote's); the integrator fee
    must reproduce the fee shown to the user (zero address + 0 when none; cap 500 bps; a non-zero
    integrator is surfaced); `ref` derived only from the order uuid (never the server's `ref`);
  - `approve`: spender = market contract, amount = exactly the order amount;
  - deposit/withdraw/setMatcher/setOperator/release/dispute/cancel: the values the user typed or
    the order being viewed;
  - a missing expectation is a refusal, never a pass.
- The dev-only `/v1/dev/*` routes and `DEV_TOOLS`, `WEBHOOKS_ALLOW_INSECURE` and the `local`
  network are refused in production; simulate acts only on chain 31337.

## 8. Open decisions for the owner

1. Protocol fee value (contract cap 3%).
2. Owner and arbiter multisig addresses and the treasury address.
3. Who funds the matcher's gas on each network, and which networks/tokens launch first (the old
   implementation verified USDC/USDT addresses on eth, base, arb, op, pol, bsc, avax, monad).
4. Should a merchant that accepted a sell and never paid lose its bond on expiry? Today it gets it
   back (only a dispute can take it). Changing it is a contract change and has a risk: a merchant
   that paid but forgot to mark paid would lose bond and tokens.
5. A single-use charge allows one live order at a time, so someone holding the link can make the
   real payer wait up to 30 min (the payer can cancel; budgets apply). Acceptable?
6. Fees are paid by the person (buyer pays the gross, receives the net). Intended?
7. **Legal:** in Argentina, a service that matches fiat-crypto exchanges between third parties and
   charges fees likely needs CNV PSAV registration (RG 1172/2026). Get a lawyer's opinion before any
   live launch.

## 9. Known risks and backlog

- Rate limiter is in memory (per replica). Wallet-session nonces are in the database.
- A dropped matcher nonce is marked `dropped`; later nonces are not re-sequenced automatically; no
  replace-by-fee.
- Each job tick holds a DB transaction open for its advisory lock (pool 20).
- `eth_getLogs` range caps are constants; a node with a tighter cap needs a change.
- EOA-only SIWE (no ERC-1271 smart wallets).
- No `DATA_ENCRYPTION_KEY` rotation; no webhook secret rotation or test send.
- Charges have no `qr` field (the web renders it from `url`).
- Quotes do not carry the merchant/integrator address (the web pins the buyer from the order; a
  non-zero app integrator fee needs the integrator in the quote first).
- `GET /v1/auth/session` answers 401 when signed out (console noise); consider 200 `{session:null}`.
- The SDK reference bot releases BUY orders only, not CHARGE orders.
- Landing is not prerendered (SEO); admin dispute screen not built; some edit forms cut.
- Payout extras cut (no CSV in the API, no item retries).
- Root `overrides` (`tmp`, `openapi-typescript.typescript`) make `npm ls` report "invalid" and exit
  non-zero; they took effect only after a fresh install.
- `solc` is a runtime dependency of `@pedospe/contracts` because its `testing` export compiles;
  consider splitting the testing export into its own dev-only package.
- After an API spec change: `npm run openapi -w @pedospe/api`, then `npm run gen:api -w @pedospe/web`.

Suggested next steps: testnet deployment once section 8 items 1-3 are decided (deploy CLI in the API
README, mainnet behind `--i-understand-mainnet`); re-run the API e2e suite on `main`; production
hosting plan (serve `/v1` from the web's origin, `SIWE_DOMAIN` = web host, `WEB_ORIGINS`);
prerendered landing; admin dispute UI.

## 10. Environment gotchas (this Windows machine)

- Shell tools: the Bash tool is Git Bash (POSIX); never kill processes by name, only single PIDs
  (`taskkill //PID <pid> //F`). Never start Docker Desktop or other GUI apps from a session.
- Downloading Foundry's binary was blocked by the permission classifier; contracts are tested in the
  in-process EVM (`@pedospe/contracts/testing`), and anvil comes from npm for the dev stack.
- Docker daemon is usually off: the dev stack uses embedded Postgres.
- Agents' dev servers (Vite) can be left running on :3000; check `netstat -ano` and stop by PID
  before starting the stack.
- Git warns about LF/CRLF on every add (harmless; `.gitattributes` normalizes; `.sol` is LF).
- The repo lives under OneDrive: `node_modules` and `.dev-stack/` are large; consider excluding the
  folder from sync.
