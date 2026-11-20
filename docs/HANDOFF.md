# Midpoint: handoff

The state of the project and everything a new session needs to continue it. Last updated at the
end of 2026-11-19, after the move to Stellar and the mobile payments app. Read this first, then
[`AGENTS.md`](../AGENTS.md) (binding conventions), [`docs/STELLAR.md`](STELLAR.md) (the design
contract of the Stellar port and the app) and the workspace READMEs.

## 1. What Midpoint is

A peer-to-peer market for stablecoins (USDC) against local money (bank transfers, PIX, Argentina's
interoperable QR...), modelled on p2p.me but with a **public API**, running on **Stellar**. On top
of the market sits a **simple payments app** (an installable PWA at `/app`): balance in dollars,
send and receive by `@handle`, link or QR, pay a shop's QR in pesos or reais through a market
merchant, pay a business's charge, add money and withdraw.

The owner's requests (Spanish), in order:

> "necesito que me hagas una app de p2p estilo p2p.me pero con api publica, crea el smart contract
> para el escrow y herramientas de pagos automatizadas para nuestros clientes"

> "necesito que hagas su modo de app para movil, piensa que no debe ser solo una plataforma sino
> una app para pagos sencilla" / "pero no debe ser evm, sino en stellar" / "usa pollar"

Owner decisions so far:

| Topic                 | Decision                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Product               | Independent project named **Midpoint** (renamed from "pedospe" on 2026-11-20; not part of any other company's product)                          |
| Chain                 | **Stellar** (Soroban contract `P2PMarket`), replacing the first EVM build entirely                                                              |
| User wallets          | **Pollar** (`@pollar/react` / `@pollar/core` 0.12): email or Google login gives a classic G account                                             |
| Fees                  | **Gasless**: the API fee-bumps every user transaction and sponsors activation reserves                                                          |
| Mobile                | An installable **PWA** inside `apps/web` (Capacitor later if the stores are needed)                                                             |
| App features (v1)     | Send/receive dollars, `@handles`, pay charges by QR, pay shop QRs (AR interoperable, PIX) through a merchant                                    |
| Who confirms the fiat | The party that receives the local money (or its bot) releases; deadlines refund; disputes go to an arbiter                                      |
| Matching              | The user types an amount and the market picks the merchant (no ads book)                                                                        |
| Client tools          | Merchant bots via API, embedded buy/sell for businesses, collections (charges) and payouts                                                      |
| Repo                  | Private `Emanuel250YT/pedospe`, local folder `C:\Users\emanu\OneDrive\Desktop\pedospe` (both still under the old name), npm workspaces monorepo |
| UI languages          | Spanish (default) and English                                                                                                                   |

## 2. History you should know

1. The market was first built inside another company's repositories (the owner's employer,
   Cosmos Pay); the owner then said it must be independent. Those pull requests were closed
   unmerged. **Never put Midpoint work in Cosmos Pay repositories, never copy their infrastructure,
   and never use Cosmos Pay's Pollar app**: Midpoint needs its own.
2. 2026-11-19, first build (EVM): Solidity contract, NestJS API with viem and SIWE, React web with
   browser wallets, all merged into `main` (`1dcd8a1`, handoff `a52dd3f`).
3. 2026-11-19 evening, the pivot: everything moved to Stellar and the payments app was added, on
   branch **`feat/stellar`**. The spec `docs/STELLAR.md` and the shared package
   `packages/payment-qr` came first; three agents then built, in parallel worktrees, the Soroban
   contract (`feat/stellar-contracts`), the API + SDK + dev stack (`feat/stellar-api`) and the
   web + app (`feat/stellar-web`). The orchestrator merged them into `feat/stellar`, fixed what the
   reviews found and ran every gate on the merged tree (section 5). **`feat/stellar` is not merged
   into `main` and nothing of it is pushed yet.**
4. Automated security reviews ran on every commit; their findings were fixed (section 7).

## 3. Layout and stack

| Workspace                                      | Stack                                                                                                                                               | Docs                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/contracts` (`@midpoint/contracts`)   | Soroban contract in Rust (`soroban-sdk` 29.0.1, Rust 1.97.1 pinned, `wasm32v1-none`); committed wasm + spec as a TS artifact; Vitest + `cargo test` | [`packages/contracts/README.md`](../packages/contracts/README.md) |
| `packages/payment-qr` (`@midpoint/payment-qr`) | Dependency-free TS: StrKey, SEP-7, the app's payment/charge links, handles, EMVCo merchant QRs (PIX, AR interoperable) behind `parseScan`           | source docblocks                                                  |
| `apps/api` (`@midpoint/api`)                   | NestJS 12, Prisma 7 + Postgres, `@stellar/stellar-sdk` 17.4 (Soroban RPC), Vitest + SWC; OpenAPI `apps/api/openapi.json` (89 operations)            | [`apps/api/README.md`](../apps/api/README.md)                     |
| `packages/sdk` (`@midpoint/sdk`)               | openapi-fetch client typed from the spec, webhook verification, reference merchant bot (signs `release` with a Stellar key)                         | [`packages/sdk/README.md`](../packages/sdk/README.md)             |
| `apps/web` (`@midpoint/web`)                   | Vite 8 + React 19 + React Router 8 + Tailwind 4, stellar-sdk, Pollar (lazy chunk), jsQR fallback, hand-written service worker, Playwright           | [`apps/web/README.md`](../apps/web/README.md)                     |

Tooling: Node 26, TypeScript **6.0.3**, ESLint (forbids relative imports in `src`/`test`),
Prettier, `cargo fmt` + `clippy -D warnings` for the contract. Root scripts `build`, `test`,
`typecheck`, `lint` run across workspaces (contracts and payment-qr build first; others import
their `dist/`). Stellar CLI 25.1 is installed (not needed to build: see section 10).

## 4. Run it locally (the test server)

```
npm install
npm run dev:stack -- --testnet          # build, then bring the whole market up on Stellar testnet
npm run dev:stack -- --stop             # stop it (or Ctrl+C in its own terminal)
npm run dev:stack -- --reset            # fresh database and a fresh deployment
npm run dev:stack -- --no-web
npm run dev:stack -- --api-port 4300 --web-port 3300 --pg-port 54349   # other ports
npm run dev:simulate -- <orderId> --api http://localhost:4100           # play the merchant
npm run dev:mock -w @midpoint/web        # the whole web with no backend (demo wallet)
```

- Defaults: API **:4100**, web **:3100**, embedded Postgres **:54339**. Network: Stellar `local`
  (quickstart) only when a Docker daemon already answers, otherwise **testnet with friendbot**
  (`--testnet` forces it). Docker Desktop is never started.
- It creates and keeps in `.dev-stack/` the owner, arbiter, treasury, matcher, sponsor, SEP-10
  signer, merchant, business, user and a `TUSD` issuer; mints TUSD; deploys the market and TUSD's
  SAC; seeds through the API (organizations, `pk_test_` keys, SEP-10 wallet proofs, payment
  methods, ARS/BRL offers and `ar_qr`/`br_pix_qr` QR offers, 100 000 TUSD of liquidity, the
  matcher authorised, a charge, the user activated by the sponsor with 5 000 TUSD). It prints the
  URLs, keys and the dev secret keys (testnet only).
- Clicking through: open the web's `/app` and sign up or sign in with Pollar (email code or
  Google; needs `VITE_POLLAR_PUBLISHABLE_KEY`, section 8, and the web on an origin the Pollar app
  allows, today `http://localhost:3300`). To use a printed dev secret instead, open
  `/app?dev` (or have no Pollar key): **"Clave de desarrollo"** appears under the form (the
  dev-key wallet, compiled out of production builds); paste the `user` secret, or the
  `merchant` / `business` secret on `/dashboard?dev`.
- Mock mode (`dev:mock`) shows no demo banner: sign up or sign in with any email and any 6-digit
  code. `<persona>@demo.test` picks a demo persona (`user`, `merchant`, `business`, `fresh`);
  any other email is a new wallet on sign-up, the funded person on the app's sign-in and the
  merchant on the dashboard's (`personaForEmail` in `apps/web/src/lib/mock/wallet.ts`).
- To try a shop QR, paste an EMV payload in the app's scan screen (the tests in
  `packages/payment-qr/test` show how to build one with a valid CRC).
- A phone cannot use the local stack: the camera, the service worker and installing need HTTPS,
  so phone testing waits for a deployment (the owner's VPS, never a tunnel).

## 5. Verification status (on the merged `feat/stellar`, `b75f3eb`)

| Check                                               | Result                                                                                                                    | Who / where                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `npm install` (clean), `build`, `typecheck`, `lint` | pass (lockfile unchanged by a clean install)                                                                              | orchestrator, clean worktree                                          |
| Contract                                            | `cargo test` 47 pass (all EVM tests ported + Stellar rules, randomized conservation) + Vitest 14 (artifact = fresh build) | orchestrator                                                          |
| Contract mutation checks                            | 12/12 caught                                                                                                              | contracts agent                                                       |
| Contract reproducibility                            | same wasm hash `371f5f54…` on two clean builds, another path with CRLF, and WSL Linux                                     | contracts agent                                                       |
| payment-qr                                          | 16 pass (PIX manual CRC vector, SEP-23 vectors, duplicate-field and fail-closed cases)                                    | orchestrator                                                          |
| SDK                                                 | 56 pass                                                                                                                   | orchestrator                                                          |
| API unit + e2e wiring (embedded Postgres)           | 473 pass (every route vs wrong callers, scopes, roles, tiers, orgs, CSRF, revoked keys, SEP-10 replay and cross-purpose)  | orchestrator                                                          |
| API chain e2e on **testnet**                        | 5/5: sponsored activation, gasless transfer to an `@handle`, BUY, SELL, QR_PAY, a charge paid from the balance            | API agent (`E2E_STELLAR=testnet npm run test:chain -w @midpoint/api`) |
| Web unit                                            | 224 pass (102 are the ported transaction checks)                                                                          | orchestrator                                                          |
| Web Playwright (mock mode)                          | 54 pass: 18 flows × Pixel 7, iPhone 14 (Chromium) and desktop, es/en                                                      | orchestrator                                                          |
| Web against the real testnet stack                  | dev-key sign-in, send, BUY, QR_PAY, charge from the balance, dashboard sign-in and deposit                                | web agent; sign-in → home with balance re-checked by the orchestrator |
| Contract testnet smoke                              | deposit → set_matcher → open → mark_paid → release; a push to an unfunded treasury credited                               | contracts agent                                                       |

**Never verified:** Pollar itself (no publishable key yet: email/Google login, `signTx`,
`sep10.sign` are typed against its 0.12 `.d.ts` only), mainnet, the `local` (quickstart) network,
the deploy CLI end to end, the SDK bot against a live API, the service worker in a production
build, WebKit, the camera path on a device, a real bank or a real shop QR payment.

## 6. Design

The binding details are in [`docs/STELLAR.md`](STELLAR.md) and each workspace's README; this is the
map.

### 6.1 Contract (`packages/contracts/contracts/p2p-market`)

- Same rules as the first (EVM) build: free balances, operators with permission bits
  (`PERM_OPEN 1`, `PERM_RELEASE 2`, `PERM_TRADE 4`, `PERM_WITHDRAW 8`), matchers with a per-order
  cap and `auto_settle`, `open` / `open_with_deposit` with refs unique per opener, optional buyer
  bond with an acceptance step, `mark_paid`, `release`, `settle`, `cancel` (always refunds the
  seller), `dispute`, `resolve` by the arbiter. Statuses
  `None 0, Offered 1, Active 2, Paid 3, Disputed 4, Released 5, Cancelled 6, Resolved 7`.
- Stellar specifics: the acting address is an explicit argument with `require_auth()`; pulls are
  SAC `transfer` under the payer's auth (no approve); a push the token refuses (missing trustline,
  frozen) is **credited** to the recipient's market balance; storage TTL extended to 30 days when
  under 15; **not upgradeable** (the owner can never move funds).
- Fees: protocol fee (cap 300 bps) + integrator fee (cap 500 bps) from the buyer's proceeds,
  snapshotted at open. Pause stops new money in, never money out. Two-step ownership.
- Errors are `Error(Contract, #code)` (table in the package README); codes 1 and 3 never fire
  (the host's auth check refuses first).

### 6.2 Roles and keys

| Role                        | Holder                                                             | Key location                                                                                |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| owner, arbiter              | the operator (multisigs on mainnet)                                | outside the server; the API only builds unsigned XDR for them                               |
| treasury                    | address only                                                       |                                                                                             |
| matcher                     | the API                                                            | `P2P_MATCHER_SECRET`: opens orders within caps, acts for buyers; pays its fees              |
| sponsor                     | the API                                                            | `P2P_SPONSOR_SECRET`: fee-bumps user transactions, pays activation reserves; holds only XLM |
| SEP-10 signer               | the API                                                            | `SEP10_SIGNING_SECRET`: signs auth challenges; never funded                                 |
| users                       | Pollar (test: Pollar-custodied; live: Turnkey) or their own wallet | never on our servers                                                                        |
| merchants, businesses, bots | themselves                                                         | their wallets; bots preferably a release-only operator key                                  |

Production refuses to start unless the matcher, sponsor and SEP-10 secrets are all present and
distinct. **Trust edge:** a leaked matcher key plus a leaked arbiter key could drain merchant
liquidity through fake disputes; owner and arbiter must be multisigs and `autoSettle` is never
offered to liquidity merchants.

### 6.3 API

- **Tenancy/auth:** organizations with members, API keys `pk_live_` / `pk_test_` (tier by prefix,
  every query filtered by organization AND tier), members' headers `Midpoint-Organization` /
  `Midpoint-Tier`. Wallet sign-in is **SEP-10** (`GET /v1/auth/challenge`, `POST /v1/auth/verify`,
  plus the standard `/v1/auth/sep10` pair and `/.well-known/stellar.toml`); wallet proofs for
  account registration use SEP-10-shaped challenges bound to the organization.
- **Transactions:** every user transaction is built by the API as a prepared XDR (source = the
  user, one operation, 5-minute bounds). The wallet signs; `POST /v1/app/submit` or
  `/v1/p2p/submit` checks the policy (source, one allowed operation, passphrase, bounds, fee cap,
  per-address/IP limits, daily budget), fee-bumps with the sponsor, persists, submits and reports.
  Activating a missing account is the one shape whose source is the sponsor.
- **Flows:** BUY (matcher `open` on the merchant's liquidity), SELL (user `open_with_deposit`,
  merchant accepts with a bond), **QR_PAY** (like SELL, the destination is a scanned EMV payload on
  rails `ar_qr` / `br_pix_qr`; windows 2 min / 10 min / 1 h settle; payload sealed, shown only to
  the merchant while live), CHARGE (payers in local money, or **from the app balance**), PAYOUT,
  **transfers** between wallets (classic payment or SAC transfer), **handles**, **activity**
  (orders + transfers + external incoming payments from CAP-67 events, about 7 days back).
- **Chain layer:** Soroban RPC; a deployment is served only if its wasm hash equals the artifact
  and its tokens are allowed; the matcher is a serialized queue per network (one transaction per
  ledger); the indexer reads `getEvents` from a persisted cursor with compare-and-swap transitions
  committed with their webhook outbox rows; refusals are named after the contract that raised
  them (market error, or `Token…` for a SAC).
- **Webhooks:** transactional outbox, `midpoint-signature: t=<unix>,v1=<HMAC-SHA256(secret, t.body)>`,
  backoff, SSRF guard, per-role allowlisted bodies (no personal details, no `chainId` now).
- **Payment details and QR payloads** sealed at rest with AES-256-GCM (`DATA_ENCRYPTION_KEY`).

### 6.4 Web and the payments app

- `/app/*` (the payments app): welcome/sign-in, handle, home, scan, send, receive, add (BUY),
  withdraw (SELL), pay a shop QR, pay a charge, order and activity detail, me. Phone-width column
  on desktop, a floating dock for the tabs with the scan button at its centre. PWA: manifest
  named from `src/lib/brand.ts`, icons from `scripts/gen-icons.mjs`, hand-written `pwa/sw.js`
  (never caches `/v1` or `/.well-known`), install prompts, offline page.
- Also: `/` landing, `/dashboard` (liquidity, offers incl. QR rails, payment methods, orders incl.
  the QR to pay for QR_PAY, charges, payouts, keys, webhooks, team), `/pay/{id}` and `/c/{id}`
  charge page, `/docs`.
- Wallets: `pollar` (lazy chunk, only with a publishable key; Freighter/Albedo in the dashboard
  through Pollar's built-in adapters), `demo` (mock mode only), `dev-key` (dev builds only). The
  app's token is `VITE_APP_TOKEN`, else the one the wallet holds, else USDC.
- The brand name lives in `apps/web/src/lib/brand.ts` and the API's `BRAND_NAME`.
- The look ("night and aura", 2026-11-20, after a Dribbble banking-app reference the owner chose)
  is defined in `apps/web/src/styles/global.css`: near-black ink on a cool white page with white
  sheets; one atmospheric gradient textured with halftone dots and grain (`.aura`,
  `.aura-screen`, `.aura-night`, `.aura-card` + `.grain`) only for the welcome, the home balance,
  the wallet cards (receive, me) and the landing's hero and closing; `.tone-light`,
  `.tone-dark` and `.tone-glass` set the palette for part of a page whatever the theme; pill
  buttons (`.btn-white`, `.btn-glass` on the aura);
  action `.tile`s with tracked capitals (`.caps`); wide uppercase `.display` headlines on the aura;
  an ice highlighter (`.marker`) for the exact amount.
- The mark (2026-11-20, chosen by the owner from the options on the logo canvas): the hero's
  capital M (Archivo's outline at width 116, weight 720, taken from the app's own font file), cut
  on a slant with its lower part slid right; flat, the M in paper on an ink tile (no gradient).
  The wordmark is MIDPOINT in the hero's capitals (`.display`). One geometry in `Logo.tsx`
  (`M_PATH`, the cut, `M_SLIDE`), `public/favicon.svg` and `scripts/gen-icons.mjs`.

## 7. Security invariants (keep them)

- Non-custodial: no server key can move anyone's tokens; the contract is the boundary.
- Every query is scoped by organization AND tier; another tenant's or tier's row is a 404.
- Keyless routes never let an id alone spend: budgets, caps, one live order per single-use charge.
- The sponsor pays only for allowlisted operation shapes, within rate limits and a daily budget.
- Merchant and client webhook bodies are per-role allowlists.
- **Before any wallet signature, the web decodes the API-built XDR and pins every field to a
  trusted source** (`apps/web/src/lib/p2p/tx-verify.ts`): network passphrase, source, one
  operation, bounds, fee cap; contract and function and every argument (decoded by name from
  `MARKET_SPEC`); auth entries only source-account credentials with the expected SAC transfer as
  the only sub-invocation; classic payments to what the user confirmed; a charge paid from the
  balance pinned to the app's token, the shown recipient and amount; the signed result must equal
  what was checked. A missing expectation is a refusal.
- **SEP-10 sign-in is pinned** to the configured home domain, the matching `web_auth_domain` and
  the `SIGNING_KEY` of this origin's `stellar.toml` (with its signature), never to values read
  from the challenge.
- **EMV QR parsing fails closed** (`packages/payment-qr`): a bad CRC, a repeated field, a second
  PIX account, an unparsable account or additional-data template, or an amount without a known
  currency is refused, so the person never agrees to one amount or payee while another is paid.
- The SDK bot pins the market contract locally, accepts only `release(own address, id)` with no
  sub-invocations, caps fees and bounds, and hard-codes network passphrases.
- Mock mode, the demo wallet and the dev-key wallet are compiled out of production builds; dev
  routes (`/v1/dev/*`) are refused in production and on mainnet.

## 8. Open decisions and set-up for the owner

1. **Pollar app for Midpoint** (never another company's): publishable key
   (`VITE_POLLAR_PUBLISHABLE_KEY`), allowed origins (`http://localhost:3100`, `:3000` and
   production), email OTP + Google, signing rules allowlisting only the market contract's user
   functions, the USDC/TUSD SAC `transfer`, classic `payment` / `change_trust` of those assets and
   SEP-10 for our home domain; a prompt-style confirmation policy; Pollar's own fee sponsorship
   off (our API sponsors). Checklist in `apps/web/README.md`.
2. **The new product name** (one constant per workspace, then the `@midpoint/*` scope, repo and
   domain).
3. Protocol fee value (contract cap 3%).
4. Owner and arbiter multisig addresses and the treasury address.
5. Funding of the matcher and the sponsor (XLM) per network and the sponsor's daily budget and
   abuse limits (`SPONSOR_*`); which networks/tokens launch (Circle USDC on mainnet).
6. Should a merchant that accepted a sell (or a QR payment) and never paid lose its bond on
   expiry? Today it gets it back (only a dispute can take it): a contract change.
7. A single-use charge allows one live order at a time (the link holder can make the payer wait up
   to 30 min). Acceptable?
8. Fees are paid by the person (buyer pays the gross, receives the net). Intended?
9. Hosting: a deployment on the owner's VPS (HTTPS) is needed to test on a phone and to install
   the PWA.
10. **Legal:** in Argentina, a service that matches fiat-crypto exchanges between third parties and
    charges fees likely needs CNV PSAV registration (RG 1172/2026). Paying shop QRs through
    merchants adds payments-regulation questions. Get a lawyer's opinion before any live launch.

## 9. Known risks and backlog

- Matcher throughput: one transaction per ledger per network; channel accounts would lift it.
- Concurrent activations of missing accounts can collide on the sponsor's sequence (the client
  retries).
- Indexer recovery after its cursor falls out of RPC retention (~7 days) and the sponsor-paid
  restore preamble are unit-tested only. External incoming payments in activity go back about 7
  days.
- The web names a contract error at **submission** time from the error text's code
  (`apps/web/src/lib/wallet/sign.ts`), so a token refusal there could read as a market error; the
  API's simulation path already attributes by origin (`refusalName`). Submission failures are rare
  because every transaction is simulated when built.
- Rate limiters are in memory (per replica).
- Pollar: LOBSTR/xBull not offered (the wallets-kit adapter pulls Reown/Trezor/Ledger); passkey
  (C-address) Pollar wallets are refused; recovery opens Pollar's own modal.
- The local-money equivalent on the home comes from a 10-unit sell quote (no price route).
- QR_PAY windows are pinned in the web to 120/600/3600 s, not cross-checked with the market's.
- `GET /v1/auth/session` answers 401 when signed out (console noise).
- `dev:stack --stop` can leave an orphaned embedded-Postgres worker holding its port (stop that
  single PID).
- No `DATA_ENCRYPTION_KEY` rotation; no webhook secret rotation or test send.
- Landing not prerendered (SEO); admin dispute screen not built; payout extras cut (CSV, retries).
- A build with Stellar CLI ≥ 25.2 (`stellar contract build`) has not been compared byte for byte
  with `npm run compile`.
- After an API spec change: `npm run openapi -w @midpoint/api`, then `npm run gen:api -w
@midpoint/web` and `npm run generate -w @midpoint/sdk`.

## 10. Environment gotchas (this Windows machine)

- Shell tools: the Bash tool is Git Bash (POSIX); never kill processes by name, only single PIDs
  (`taskkill //PID <pid> //F`). Never start Docker Desktop or other GUI apps from a session.
- `soroban-sdk` 28+ refuses to build except through `stellar contract build` from CLI ≥ 25.2 (it
  shakes the contract spec); this machine has CLI 25.1, so `npm run compile -w @midpoint/contracts`
  does the shaking itself. The `wasm32v1-none` target was added to the pinned Rust 1.97.1.
- `npm test -w @midpoint/contracts` takes about 1.5 minutes (cargo).
- stellar-sdk 17's XDR objects expose plain properties (`event.contractId`, `body.v0.topics`), not
  the accessor functions of older versions.
- Testnet: friendbot funds dev accounts; SDF's RPC keeps about 7 days of events.
- The repo lives under OneDrive: `node_modules`, `target/` and `.dev-stack/` are large; consider
  excluding the folder from sync.
- Worktrees from the 2026-11-19 sessions (remove with `git worktree remove <path>` when done):
  `C:/Users/emanu/wt/pst-contracts`, `pst-api`, `pst-web` (the agents' branches, merged),
  `pst-gates` (clean gate runs), `pst-preview` (a preview stack on :4300/:3300/:54349 with a
  throwaway patch), and the older `midpoint-api`, `midpoint-web`, `p2p-cs`, `p2p-dp`.
- The first EVM dev stack may still be running from the main folder (web :3000, API :4000, anvil
  :8545) and locks `node_modules` (anvil.exe): stop it before `npm install` there.
