# @pier/api

The Pier public API: a peer-to-peer market for stablecoins against local money, and the
backend of the mobile payments app. NestJS 12, Prisma 7 on Postgres, `@stellar/stellar-sdk` 17
over Soroban RPC for every chain interaction, ESM.

- **Organizations** (businesses, merchants, or both) sign in with their Stellar accounts (SEP-10),
  add members, and create API keys per tier.
- **Merchants** register accounts (SEP-10-shaped proofs), add payment methods (validated per rail,
  sealed at rest), publish offers, deposit liquidity into `P2PMarket` and authorise the matcher.
- **People** type an amount; the matching service picks the merchant (best price, then
  reputation). A purchase is opened by the matcher on the merchant's balance; a sale (and a QR
  payment) is opened by the seller's own wallet with `open_with_deposit`.
- **The payments app** (`/v1/app/*`): handles, balances, sponsored activation, transfers, activity,
  paying a charge from the balance, and paying a shop's local-money QR through a merchant
  (`QR_PAY`).
- **Gasless**: wallets never hold XLM. The API fee-bumps their signed transactions with its sponsor
  account and sponsors the reserves of an activation.
- **Businesses** embed buy/sell, collect with **charges** and send **payouts**; **webhooks** report
  every status, signed.
- The **indexer** moves orders only on what the chain shows; the **expiry** job cancels overdue
  orders; the **matcher follower** and the **submission follower** rebroadcast only stored bytes.

## Non-custodial by construction

The server holds three keys, all distinct (production refuses to start otherwise), and none can
move anyone's tokens:

| Key                             | What it does                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| matcher (`P2P_MATCHER_SECRET`)  | opens orders on a seller's balance within the cap it set (`set_matcher`), acts for a buyer it opened an order for (mark paid, cancel, dispute), cancels expired orders; pays its own fees |
| sponsor (`P2P_SPONSOR_SECRET`)  | fee-bumps transactions that passed the submit policy, sponsors activation reserves, restores archived entries; holds only XLM                                                             |
| SEP-10 (`SEP10_SIGNING_SECRET`) | signs authentication challenges; never funded                                                                                                                                             |

Owner and arbiter keys live in external accounts (multisigs): the API only **builds** their
transactions (`POST /v1/admin/p2p/orders/{id}/resolution` returns the arbiter's unsigned
`resolve`). Known trust edge: a leaked matcher key **and** a leaked arbiter key together could
drain merchant liquidity through fake disputes; a leaked matcher alone can only lock liquidity until
deadlines (and, for sellers that enabled `autoSettle`, let silence release orders they did not
dispute in time). So the arbiter is a multisig, `autoSettle` is refused for accounts that sell
liquidity through offers, and every matcher transaction is recorded before it is broadcast.

## Credentials

| Who                 | How                                                                                                                                                                                                          | Reaches                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone              | nothing                                                                                                                                                                                                      | `GET /v1/market`, `/v1/auth/challenge`, `/v1/auth/verify`, `/v1/auth/sep10`, `/.well-known/stellar.toml`, `/v1/p2p-checkout/*`, `/health` |
| An account          | SEP-10 session: HttpOnly cookie `pier_session` or `Authorization: Bearer ps_sess_...`                                                                                                                    | `/v1/auth/session`, `/v1/auth/logout`, `/v1/organizations/*`, `/v1/app/*`                                                                 |
| An organization     | `Authorization: Bearer pk_test_...` / `pk_live_...` (scopes `p2p:read`, `p2p:write`), or a member's session with `Pier-Organization` and `Pier-Tier` headers (owner/admin: read+write, member: read) | `/v1/p2p/*`, `/v1/webhook-endpoints/*`                                                                                                    |
| A platform operator | a session whose account is in `ADMIN_ADDRESSES`                                                                                                                                                              | `/v1/admin/p2p/*`                                                                                                                         |

Every route declares its policy; a route without one is refused. A key's prefix is its tier, and
every query filters by organization **and** tier: another tier's row is the 404 of a missing one.
A cookie-authenticated write must come from an origin in `WEB_ORIGINS`. Every error is
`{ "error": { "code", "message", "details"? } }`.

### SEP-10

`GET /v1/auth/challenge?account=G...` answers `{ transaction, network_passphrase }`: a standard
challenge (sequence 0, signed by the SEP-10 key, a `<SEP10_HOME_DOMAIN> auth` entry with a random
single-use nonce, a `web_auth_domain` entry, 5-minute time bounds). `POST /v1/auth/verify
{ transaction }` checks the server signature, time bounds, domains and nonce, and the account's
signatures: they must reach its medium threshold (signers loaded from the ledger) when the account
exists, or be the master key's when it does not. It answers `{ token, session }` and sets the
cookie. `GET`/`POST /v1/auth/sep10` are the same pair at the standard SEP-10 endpoint that
`/.well-known/stellar.toml` names (`WEB_AUTH_ENDPOINT`, `SIGNING_KEY`, `NETWORK_PASSPHRASE`).

Registering an account (`/v1/p2p/accounts/challenge`, `/v1/p2p/accounts`) uses the same challenge
plus an `organization` entry (`<organizationId>:<tier>`, signed by the server), so a sign-in
challenge never registers a wallet and a registration never signs in or registers elsewhere.

## Routes

The contract is [`openapi.json`](openapi.json) (also served at `GET /v1/openapi.json`), generated
from the controllers: `npm run build -w @pier/api && npm run openapi -w @pier/api`.

| Method               | Path                                                               | Auth                                                  |
| -------------------- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| GET                  | `/v1/market?tier=`                                                 | public                                                |
| GET                  | `/.well-known/stellar.toml`                                        | public                                                |
| GET / POST           | `/v1/auth/challenge`, `/v1/auth/verify`, `/v1/auth/sep10`          | public                                                |
| GET / POST           | `/v1/auth/session`, `/v1/auth/logout`                              | session                                               |
| POST, GET            | `/v1/organizations`                                                | session                                               |
| GET, PATCH           | `/v1/organizations/{orgId}`                                        | session (member / admin)                              |
| GET, POST            | `/v1/organizations/{orgId}/members`                                | session (member / owner)                              |
| PATCH, DELETE        | `/v1/organizations/{orgId}/members/{memberId}`                     | session (owner; a member may leave)                   |
| GET, POST            | `/v1/organizations/{orgId}/api-keys`                               | session (admin)                                       |
| DELETE               | `/v1/organizations/{orgId}/api-keys/{keyId}`                       | session (admin)                                       |
| POST                 | `/v1/p2p/accounts/challenge`, `/v1/p2p/accounts`                   | org `p2p:write`                                       |
| GET                  | `/v1/p2p/accounts`, `/v1/p2p/accounts/{id}`                        | org `p2p:read`                                        |
| PATCH, DELETE        | `/v1/p2p/accounts/{id}`                                            | org `p2p:write`                                       |
| POST / GET           | `/v1/p2p/payment-methods`                                          | org write / read                                      |
| PATCH, DELETE        | `/v1/p2p/payment-methods/{id}`                                     | org `p2p:write`                                       |
| POST / GET           | `/v1/p2p/offers`                                                   | org write / read                                      |
| PATCH, DELETE        | `/v1/p2p/offers/{id}`                                              | org `p2p:write`                                       |
| POST                 | `/v1/p2p/quotes`                                                   | org `p2p:write`                                       |
| POST / GET           | `/v1/p2p/orders`                                                   | org write / read                                      |
| GET                  | `/v1/p2p/orders/{id}`                                              | org `p2p:read`                                        |
| POST                 | `/v1/p2p/orders/{id}/paid`, `/cancel`, `/dispute`                  | org `p2p:write`                                       |
| GET                  | `/v1/p2p/merchant/orders`, `/v1/p2p/merchant/orders/{id}`          | org `p2p:read`                                        |
| POST                 | `/v1/p2p/merchant/transfer-matches`                                | org `p2p:read`                                        |
| POST                 | `/v1/p2p/transactions`                                             | org `p2p:read` (builds, signs nothing)                |
| POST                 | `/v1/p2p/submit`                                                   | org `p2p:write` (gasless)                             |
| GET                  | `/v1/p2p/submissions/{hash}`                                       | org `p2p:read`                                        |
| POST / GET           | `/v1/p2p/charges`                                                  | org write / read                                      |
| GET / DELETE         | `/v1/p2p/charges/{id}`                                             | org read / write                                      |
| POST / GET           | `/v1/p2p/payouts`                                                  | org write / read                                      |
| GET                  | `/v1/p2p/payouts/{id}`                                             | org `p2p:read`                                        |
| POST / GET           | `/v1/webhook-endpoints`                                            | org write / read                                      |
| GET / PATCH / DELETE | `/v1/webhook-endpoints/{id}`                                       | org read / write / write                              |
| GET                  | `/v1/webhook-endpoints/{id}/deliveries`                            | org `p2p:read`                                        |
| GET                  | `/v1/p2p-checkout/charges/{id}`                                    | public                                                |
| POST                 | `/v1/p2p-checkout/charges/{id}/orders`                             | public (budgets per charge and client)                |
| GET                  | `/v1/p2p-checkout/orders/{id}`                                     | public + `X-Payer-Token`                              |
| POST                 | `/v1/p2p-checkout/orders/{id}/paid`, `/cancel`                     | public + `X-Payer-Token`                              |
| POST                 | `/v1/app/quotes`, `/v1/app/orders`                                 | session (the account trades for itself)               |
| GET                  | `/v1/app/orders`, `/v1/app/orders/{id}`                            | session (own orders only)                             |
| POST                 | `/v1/app/orders/{id}/paid`, `/cancel`, `/dispute`, `/transactions` | session                                               |
| GET, PUT             | `/v1/app/profile`                                                  | session                                               |
| GET                  | `/v1/app/handles/{handle}`                                         | session (rate-limited; no listing)                    |
| GET                  | `/v1/app/balances?network=`                                        | session                                               |
| POST                 | `/v1/app/activate`                                                 | session (sponsored activation)                        |
| POST / GET           | `/v1/app/transfers`, `/v1/app/transfers/{id}`                      | session                                               |
| GET                  | `/v1/app/activity?network=&cursor=&limit=`                         | session                                               |
| GET                  | `/v1/app/charges/{id}`                                             | session                                               |
| POST                 | `/v1/app/charges/{id}/payments`                                    | session (pay from the balance)                        |
| POST                 | `/v1/app/submit`                                                   | session (gasless)                                     |
| GET                  | `/v1/app/submissions/{hash}`                                       | session                                               |
| GET                  | `/v1/admin/p2p/disputes`, `/v1/admin/p2p/orders/{id}`              | admin                                                 |
| POST                 | `/v1/admin/p2p/orders/{id}/resolution`                             | admin (unsigned arbiter XDR)                          |
| PATCH                | `/v1/admin/p2p/merchants/{accountId}`                              | admin                                                 |
| POST                 | `/v1/dev/orders/{id}/simulate-transfer`                            | dev only (`DEV_TOOLS`, test networks), not in OpenAPI |

Order kinds: `BUY`, `SELL`, `QR_PAY`, `CHARGE`, `PAYOUT`. Statuses: `pending`,
`awaiting_acceptance`, `awaiting_payment`, `paid`, `disputed`, then `completed`, `cancelled`,
`expired`, `resolved` or `failed`.

Order actions are safe to retry (`src/p2p/domain/action-outcome.ts` says which statuses show each
one). A buyer act (`paid`, `cancel`, `dispute`) the order already shows answers the order as it is
(200, nothing sent); a transaction for an order action it already shows is `409 already_done` with
`details: ["status: <status>"]` (nothing to sign). The same holds when the contract refuses a
second call because the first went through before the indexer caught up: the order is read
on-chain first.

### Transactions

Every transaction a wallet signs is a `P2pTransaction`
`{ network, action, description, xdr, hash, expiresAt }`: an unsigned, prepared
`TransactionEnvelope` (base64) with the wallet as source, one operation, time bounds 5 minutes
ahead, and for contract calls the simulation's resource fee, footprint and source-account auth
entries. `action` is the market function (`deposit`, `set_matcher`, `open_with_deposit`,
`release`...), `transfer` or `activate`. There is no `approve`: `deposit` and `open_with_deposit`
pull the tokens under the payer's own authorization. When the simulation needs archived entries
restored, the sponsor restores them first (without a sponsor: `409 restore_required`).

### Gasless submission

`POST /v1/app/submit` (session) and `POST /v1/p2p/submit` (org, `p2p:write`) take
`{ xdr, network? }`, the signed inner envelope. Before sponsoring, the API checks:

- the envelope is not a fee-bump, and it is signed by its source for THIS network (a signature that
  verifies only over another network's hash is refused);
- the source is the session's account, or an account registered to the organization and tier;
- exactly one operation: an invoke of the market contract (a function a wallet calls, never an
  owner function), a SAC `transfer` from the source of a listed token, or a classic `payment` of a
  listed token; or the sponsored-activation shape below. Only source-account authorization;
- time bounds present, not expired, at most 6 minutes ahead; the inner fee under
  `SPONSOR_MAX_FEE_STROOPS`;
- the rate limits and the budget (below).

It then fee-bumps with the sponsor (or submits as signed when gasless is off), **writes** the
submission, broadcasts it and waits up to about 15 s: `{ hash, status: 'PENDING' | 'SUCCESS' |
'FAILED', error, feeBumpHash, ledger, network, sponsored }`. `GET .../submissions/{hash}` polls it
(inner or fee-bump hash); the submission follower resends only the stored bytes until the time
bounds pass. A transfer or charge payment carried by a successful submission completes in the same
database transaction.

**The sponsor's budget and abuse limits** (per network):

| Limit                                    | Variable                             | Default                                                             |
| ---------------------------------------- | ------------------------------------ | ------------------------------------------------------------------- |
| Largest inner fee it bumps               | `SPONSOR_MAX_FEE_STROOPS`            | 2 000 000 (0.2 XLM)                                                 |
| Fees plus sponsored reserves per UTC day | `SPONSOR_DAILY_BUDGET_XLM`           | 200 XLM (`503 sponsor_budget_exhausted` with `Retry-After` past it) |
| Sponsored submissions per account / hour | `SPONSOR_ADDRESS_LIMIT_PER_HOUR`     | 60                                                                  |
| Sponsored submissions per client / hour  | `SPONSOR_IP_LIMIT_PER_HOUR`          | 240 (an IPv6 client by its /48, stored as an HMAC)                  |
| Activations per client / day             | `SPONSOR_ACTIVATIONS_PER_IP_PER_DAY` | 5                                                                   |

Reserves are counted at their base-reserve value (an account 1 XLM, a trustline 0.5 XLM); they
stay locked in the sponsored entries, not spent. The routes also carry per-caller rate limits.

### The payments app

- **Profile and handles**: `PUT /v1/app/profile { handle }` claims or changes `@handle` (normalised
  by `normalizeHandle`, unique case-insensitive, reserved words and the brand refused,
  `409 handle_taken`). `GET /v1/app/handles/{handle}` resolves one.
- **Balances**: whether the account exists, its lumens, each listed token with its trustline state.
- **Activation** (`POST /v1/app/activate { network, token }`): `begin_sponsoring_future_reserves`
  (sponsor), `create_account` with 0 XLM (sponsor; only when missing), `change_trust` (account),
  `end_sponsoring_future_reserves` (account); `null` when there is nothing to do. When the account
  is missing the transaction's source is the sponsor (a missing account has no sequence number);
  the API adds the sponsor's signature at submit.
- **Transfers** to a G, M or C address or an `@handle`: a classic `payment` (G, M; the note becomes
  a text memo) or a SAC `transfer` (C; Soroban transactions carry no memo, the note stays in the
  API). Refused: `recipient_cannot_receive`, yourself, `insufficient_balance`. A transfer built and
  never submitted is forgotten when it expires.
- **Activity**: orders and transfers, newest first, by cursor. Payments from outside the app are read
  from the token contracts' CAP-67 `transfer` and `mint` events (RPC `getEvents` filtered by
  recipient), on demand, from where the last read stopped, at most about 7 days back
  (`INCOMING_WINDOW_LEDGERS`) and never before what the RPC keeps: a payment older than that window
  when the account first opens its activity is not shown.
- **Paying a charge from the balance**: `GET /v1/app/charges/{id}` adds `payWithBalance` (the tokens
  the business would receive through the best purchase quote now, held 60 s, and the receiving
  account); `POST /v1/app/charges/{id}/payments` builds the transfer (expiring with the price). The
  charge is paid when the submitted transfer succeeds on-chain: `P2P_CHARGE_SUCCEEDED` with
  `paidWith: 'TOKEN'` (the pesos checkout's carry `paidWith: 'ORDER'`). A single-use charge takes one
  payment (or checkout order) at a time.
- **QR payments** (`QR_PAY`): rails `ar_qr` (ARS, Argentina's interoperable QR) and `br_pix_qr`
  (BRL, PIX). A merchant opts in with a `BUY_TOKEN` offer on these rails (they take no payment
  method). `POST /v1/app/quotes { kind: 'QR_PAY', network, token, qr, fiatAmount? }` parses the QR
  with `@pier/payment-qr`'s `parseEmv` (CRC, ambiguity checks), requires the rail's standard and
  currency, and lets a QR's own amount win (`fiatAmount` must then equal it). `POST /v1/app/orders
{ kind: 'QR_PAY', quoteId, qr }` (the same QR) answers the order and its `open_with_deposit`, with
  a bond as a sale. Windows: accept 2 min, payment 10 min, settle 1 h. The QR is sealed at rest;
  its merchant sees `qr: { payload, standard, merchantName, merchantCity, amount, currency,
reference }` only while the order is live; the payer sees what it reads (never the payload) on a
  single read. Webhooks are the sale's, with `kind: 'QR_PAY'`.

## Chain layer

- **Networks**: `local` (quickstart, dev only), `testnet` (tier `test`) and `mainnet` (tier
  `live`). Every RPC client checks the node's passphrase before use.
- **Deployments** are served only when the contract runs `MARKET_WASM_HASH` (read from its instance)
  and allows the listed tokens (`token_allowed`). `GET /v1/market` lists them with
  `{ id, name, networkPassphrase, rpcUrl, horizonUrl, explorerUrl, contract, protocolFeeBps,
paused, tokens }` (public endpoints only) and `sponsor: { enabled }`.
- **Codec**: `contract.Spec(MARKET_SPEC)` encodes calls and decodes results and events; contract
  errors (`Error(Contract, #n)`) are named from `MARKET_ERRORS`.
- **The matcher** keeps a queue per network: Stellar takes one transaction per source account per
  ledger, so each call is simulated (a refusal never queues), written, and signed and broadcast when
  nothing else is in flight. Only stored bytes are resent; a transaction past its time bounds is
  `dropped` and an opening that never applies fails its order. Throughput: about one matcher
  transaction per ledger (5 s) per network.
- **The indexer** reads `getEvents` for the contract from a persisted cursor (Stellar has finality:
  no confirmations, no reorg window). Every move is a compare-and-swap committed with its webhook
  outbox rows; an `order_opened` is ours only when every field equals the order's.
  **Recovery**: RPC keeps events for a limited window (about 7 days on SDF's RPC). When the cursor
  (or the start ledger) fell out of it, the indexer starts from the oldest retained ledger and reads
  every live order back from the contract (`order_id_of`, `get_order`), applying the moves it missed
  (settlement amounts left empty).

## Webhooks

Endpoints per organization and tier (`/v1/webhook-endpoints`). Events: `P2P_ORDER_CREATED`,
`P2P_ORDER_ACCEPTED`, `P2P_ORDER_PAID`, `P2P_ORDER_COMPLETED`, `P2P_ORDER_CANCELLED`,
`P2P_ORDER_EXPIRED`, `P2P_ORDER_DISPUTED`, `P2P_ORDER_RESOLVED`, `P2P_ORDER_FAILED`,
`P2P_CHARGE_SUCCEEDED`, `P2P_PAYOUT_BATCH_COMPLETED`. An order's events go to its client
(`role: "client"`) and its merchant's organization (`role: "merchant"`) as per-role allowlists that
never carry personal data or a scanned QR. Each event is written to an outbox **in the same
transaction** as the change it reports, then POSTed as `{ id, type, createdAt, data }` with

```
pier-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
```

Non-2xx answers are retried (30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h, 24 h; then
`failed`). Destinations must be https and resolve only to public addresses, checked when the
connection is made.

## Develop

```sh
npm install
npm run dev:stack          # from the repo root: the whole market (see below)
npm run build -w @pier/api
npm test -w @pier/api   # unit + e2e wiring (embedded Postgres, fake chain)
npm run typecheck -w @pier/api
npm run lint -w @pier/api
E2E_STELLAR=testnet npm run test:chain -w @pier/api   # the market on testnet (minutes)
```

`test:unit` runs the pure and service tests; `test:e2e` boots the HTTP app against a real Postgres
with a fake chain and drives every route against wrong callers, scopes, roles, tiers, organizations,
CSRF and revoked keys; `test:chain` (`E2E_STELLAR=testnet`, or `local` with a Docker daemon)
deploys a fresh market and runs a sponsored activation, a transfer to a handle, a purchase, a sale,
a QR payment and a charge paid from the balance.

### The dev stack

`npm run dev:stack` (repo root) starts Postgres (docker compose when a Docker daemon answers, else
embedded), Stellar (`stellar container start local` when a Docker daemon answers, else testnet with
friendbot; Docker is never started), creates the dev accounts (owner, arbiter, treasury, matcher,
sponsor, SEP-10 signer, merchant, business, user, TUSD issuer), deploys the market, seeds it
through the API (organizations, keys, SEP-10-proven accounts, payment methods with Peru first (Yape or Plin, then CCI),
offers including `ar_qr` and `br_pix_qr` QR offers, liquidity, the matcher, a charge in
soles, the user's sponsored activation), starts the API and the web, and prints the URLs, keys
and the dev secrets (test networks only). State persists in `.dev-stack/`; a restart syncs an
existing seed and the merchants idempotently (`src/dev/merchant-sync.ts`: missing payment methods
and offers added, offers in a token no longer listed deactivated, dollar liquidity topped up).

The testnet market lists Circle's USDC and the native lumen only (`P2P_TESTNET_TOKENS` is
`[{"native":true}]`: XLM through its SAC, `issuer: null`, no trustline); the stack buys its USDC
with test lumens on the testnet DEX (`src/dev/dev-dollars.ts`). The local network, which has no
Circle, lists the dev dollar TUSD (minted by the stack's issuer) and XLM. On top of the seeded
merchant the stack sets up
three automated test merchants (`src/dev/bot-merchants.ts`, kept in `.dev-stack/merchants.json`
and reused across restarts) and runs the SDK's simulated merchant for each (`[bot-<name>]` in the
log: it accepts sales and QR payments and marks them paid, and releases paid purchases, a few
seconds later, checking every transaction before it signs). Every minute the four merchants'
offers are repriced from live mainnet references (`src/dev/price-feed.ts`: CriptoYa USDT quotes
with an open.er-api FX fallback, and the XLM/USDC order book on the public Horizon), each with its
own spread; a failing source keeps its last good price.

| Flag / variable                                            | Default | What                                                                     |
| ---------------------------------------------------------- | ------- | ------------------------------------------------------------------------ |
| `--api-port` / `DEV_STACK_API_PORT`                        | 4100    | the API                                                                  |
| `--web-port` / `DEV_STACK_WEB_PORT`                        | 3100    | the web (`SEP10_HOME_DOMAIN` is its host)                                |
| `--pg-port` / `DEV_STACK_PG_PORT`                          | 54339   | Postgres                                                                 |
| `--reset`, `--stop`, `--no-web`, `--no-build`, `--testnet` |         | start over, stop, skip the web, skip the build, testnet even with Docker |

`npm run dev:simulate -- <orderId> --api http://localhost:4100` plays the merchant's bot (release,
or accept and mark paid) on a test network.

## Deploy a contract

```sh
npm run build -w @pier/api
npm run deploy:contract -w @pier/api -- --network testnet \
  --secrets-file C:/Users/<you>/.pier/deployer.json \
  --treasury G... --arbiter G... --fee-bps 50 [--owner G...] [--token CODE:ISSUER]
```

The secrets file (`{ "deployerSecret": "S..." }`) must live outside the repository. The node must
answer the network's passphrase. The script uploads the committed wasm, creates the contract with
its constructor arguments, allows the tokens (testnet: as the deployer, then `transfer_ownership` to
`--owner`), verifies it and prints `P2P_<NET>_CONTRACT` and `P2P_<NET>_START_LEDGER`. Mainnet
(`--network mainnet`) also needs `--i-understand-mainnet`, `--owner` (a multisig that owns it from
construction; the script prints its unsigned `set_token` transactions) and `--rpc`.
`--contract C...` verifies an existing deployment (wasm hash, config, tokens). At boot the API checks
every configured contract the same way and never serves one that does not match.

## Environment

See [`.env.example`](.env.example); every variable is documented there and validated at boot.
