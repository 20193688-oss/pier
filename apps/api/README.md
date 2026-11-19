# @pedospe/api

The pedospe public API: a peer-to-peer market for stablecoins against local money. NestJS 12,
Prisma 7 on Postgres, viem for every chain interaction, ESM.

- **Organizations** (businesses, merchants, or both) sign in with their wallets (SIWE), add
  members, and create API keys per tier.
- **Merchants** register wallets (EIP-191 proof), add payment methods (validated per rail, sealed at
  rest), publish offers, deposit liquidity into `P2PMarket` and authorise the matcher.
- **People** type an amount; the matching service picks the merchant (best price, then reputation).
  A purchase is opened by the matcher on the merchant's balance; a sale is opened by the seller's
  own wallet with `approve` + `openWithDeposit`.
- **Businesses** embed buy/sell, collect with **charges** (a hosted, keyless checkout) and send
  **payouts**; **webhooks** report every status, signed.
- The **indexer** moves orders only on what the chain shows; the **expiry** job cancels overdue
  orders; the **matcher follower** rebroadcasts the matcher's own signed bytes.

## Non-custodial by construction

The server's only key is the matcher's (`P2P_MATCHER_PRIVATE_KEY`). It can open orders on a seller's
balance within the cap that seller set with `setMatcher`, and act for a buyer it opened an order for
(mark paid, cancel before paid, dispute). It can never withdraw or release anyone's tokens. Owner
and arbiter keys live in external wallets (multisigs): the API only **builds** their transactions
(`POST /v1/admin/p2p/orders/{id}/resolution` returns the arbiter's unsigned `resolve`).

Known trust edge: a leaked matcher key **and** a leaked arbiter key together could drain merchant
liquidity through fake disputes; a leaked matcher key alone can only lock liquidity until deadlines
(and, for sellers that enabled `autoSettle`, let silence release orders they did not dispute in
time). So the arbiter is a multisig, `autoSettle` is refused for accounts that sell liquidity
through offers, and every matcher transaction is recorded before it is broadcast.

## Credentials

| Who                 | How                                                                                                                                                                                                        | Reaches                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Anyone              | nothing                                                                                                                                                                                                    | `GET /v1/market`, `/v1/auth/nonce      | verify`, `/v1/p2p-checkout/*`, `/health`    |
| A wallet            | SIWE session: HttpOnly cookie `pedospe_session` or `Authorization: Bearer ps_sess_...`                                                                                                                     | `/v1/auth/session                      | logout`, `/v1/organizations/_`, `/v1/app/_` |
| An organization     | `Authorization: Bearer pk_test_...` / `pk_live_...` (scopes `p2p:read`, `p2p:write`), or a member's session with `Pedospe-Organization` and `Pedospe-Tier` headers (owner/admin: read+write, member: read) | `/v1/p2p/*`, `/v1/webhook-endpoints/*` |
| A platform operator | a session whose wallet is in `ADMIN_ADDRESSES`                                                                                                                                                             | `/v1/admin/p2p/*`                      |

Every route declares its policy; a route without one is refused. A key's prefix is its tier, and
every query filters by organization **and** tier: another tier's row is the 404 of a missing one.
A cookie-authenticated write must come from an origin in `WEB_ORIGINS`.

Every error is `{ "error": { "code", "message", "details"? } }`.

## Routes

The contract is [`openapi.json`](openapi.json) (also served at `GET /v1/openapi.json`), generated
from the controllers: `npm run build -w @pedospe/api && npm run openapi -w @pedospe/api`.

| Method               | Path                                                               | Auth                                                |
| -------------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| GET                  | `/v1/market?tier=`                                                 | public                                              |
| POST                 | `/v1/auth/nonce`, `/v1/auth/verify`                                | public                                              |
| GET / POST           | `/v1/auth/session`, `/v1/auth/logout`                              | session                                             |
| POST, GET            | `/v1/organizations`                                                | session                                             |
| GET, PATCH           | `/v1/organizations/{orgId}`                                        | session (member / admin)                            |
| GET, POST            | `/v1/organizations/{orgId}/members`                                | session (member / owner)                            |
| PATCH, DELETE        | `/v1/organizations/{orgId}/members/{memberId}`                     | session (owner; a member may leave)                 |
| GET, POST            | `/v1/organizations/{orgId}/api-keys`                               | session (admin)                                     |
| DELETE               | `/v1/organizations/{orgId}/api-keys/{keyId}`                       | session (admin)                                     |
| POST                 | `/v1/p2p/accounts/challenge`, `/v1/p2p/accounts`                   | org `p2p:write`                                     |
| GET                  | `/v1/p2p/accounts`, `/v1/p2p/accounts/{id}`                        | org `p2p:read`                                      |
| PATCH, DELETE        | `/v1/p2p/accounts/{id}`                                            | org `p2p:write`                                     |
| POST / GET           | `/v1/p2p/payment-methods`                                          | org write / read                                    |
| PATCH, DELETE        | `/v1/p2p/payment-methods/{id}`                                     | org `p2p:write`                                     |
| POST / GET           | `/v1/p2p/offers`                                                   | org write / read                                    |
| PATCH, DELETE        | `/v1/p2p/offers/{id}`                                              | org `p2p:write`                                     |
| POST                 | `/v1/p2p/quotes`                                                   | org `p2p:write`                                     |
| POST / GET           | `/v1/p2p/orders`                                                   | org write / read                                    |
| GET                  | `/v1/p2p/orders/{id}`                                              | org `p2p:read`                                      |
| POST                 | `/v1/p2p/orders/{id}/paid`, `/cancel`, `/dispute`                  | org `p2p:write`                                     |
| GET                  | `/v1/p2p/merchant/orders`, `/v1/p2p/merchant/orders/{id}`          | org `p2p:read`                                      |
| POST                 | `/v1/p2p/merchant/transfer-matches`                                | org `p2p:read`                                      |
| POST                 | `/v1/p2p/transactions`                                             | org `p2p:read` (builds, signs nothing)              |
| POST / GET           | `/v1/p2p/charges`                                                  | org write / read                                    |
| GET / DELETE         | `/v1/p2p/charges/{id}`                                             | org read / write                                    |
| POST / GET           | `/v1/p2p/payouts`                                                  | org write / read                                    |
| GET                  | `/v1/p2p/payouts/{id}`                                             | org `p2p:read`                                      |
| POST / GET           | `/v1/webhook-endpoints`                                            | org write / read                                    |
| GET / PATCH / DELETE | `/v1/webhook-endpoints/{id}`                                       | org read / write / write                            |
| GET                  | `/v1/webhook-endpoints/{id}/deliveries`                            | org `p2p:read`                                      |
| GET                  | `/v1/p2p-checkout/charges/{id}`                                    | public                                              |
| POST                 | `/v1/p2p-checkout/charges/{id}/orders`                             | public (budgets per charge and client)              |
| GET                  | `/v1/p2p-checkout/orders/{id}`                                     | public + `X-Payer-Token`                            |
| POST                 | `/v1/p2p-checkout/orders/{id}/paid`, `/cancel`                     | public + `X-Payer-Token`                            |
| POST                 | `/v1/app/quotes`, `/v1/app/orders`                                 | session (the wallet trades for itself)              |
| GET                  | `/v1/app/orders`, `/v1/app/orders/{id}`                            | session (own orders only)                           |
| POST                 | `/v1/app/orders/{id}/paid`, `/cancel`, `/dispute`, `/transactions` | session                                             |
| GET                  | `/v1/admin/p2p/disputes`, `/v1/admin/p2p/orders/{id}`              | admin                                               |
| POST                 | `/v1/admin/p2p/orders/{id}/resolution`                             | admin (unsigned arbiter calldata)                   |
| PATCH                | `/v1/admin/p2p/merchants/{accountId}`                              | admin                                               |
| POST                 | `/v1/dev/orders/{id}/simulate-transfer`                            | dev only (`DEV_TOOLS`, chain 31337), not in OpenAPI |

Order statuses: `pending`, `awaiting_acceptance`, `awaiting_payment`, `paid`, `disputed`, then
`completed`, `cancelled`, `expired`, `resolved` or `failed`.

## Webhooks

Endpoints per organization and tier (`/v1/webhook-endpoints`). Events: `P2P_ORDER_CREATED`,
`P2P_ORDER_ACCEPTED`, `P2P_ORDER_PAID`, `P2P_ORDER_COMPLETED`, `P2P_ORDER_CANCELLED`,
`P2P_ORDER_EXPIRED`, `P2P_ORDER_DISPUTED`, `P2P_ORDER_RESOLVED`, `P2P_ORDER_FAILED`,
`P2P_CHARGE_SUCCEEDED`, `P2P_PAYOUT_BATCH_COMPLETED`. An order's events go to its client
(`role: "client"`) and its merchant's organization (`role: "merchant"`), never carrying personal
data. Each event is written to an outbox **in the same transaction** as the change it reports, then
POSTed as `{ id, type, createdAt, data }` with

```
pedospe-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
```

Non-2xx answers are retried (30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h, 24 h; then
`failed`). Destinations must be https and resolve only to public addresses, checked when the
connection is made (no private, loopback, link-local or metadata addresses; no redirects).

## Develop

```sh
npm install
npm run dev:stack          # from the repo root: the whole local market (see the root README)
npm run build -w @pedospe/api
npm test -w @pedospe/api   # unit + e2e (embedded Postgres and anvil, both from npm)
npm run typecheck -w @pedospe/api
npm run lint -w @pedospe/api
```

`npm run test:unit` runs the pure tests only; `npm run test:e2e` boots the HTTP app against a real
Postgres and a local EVM node with `P2PMarket` deployed, and drives every route.

## Deploy a contract

```sh
npm run build -w @pedospe/api
npm run deploy:contract -w @pedospe/api -- --network base --tier test \
  --secrets-file C:/Users/<you>/.pedospe/deployer.json \
  --treasury 0x... --arbiter 0x... --fee-bps 50 [--owner 0x...]
```

The secrets file (`{ "deployerPrivateKey": "0x..." }`) must live outside the repository. The node's
chain id is checked first. Mainnet (`--tier live`) also needs `--i-understand-mainnet`, `--owner` (a
multisig that owns it from construction; the script prints its `setToken` calls) and `--rpc`.
`--contract 0x...` verifies an existing deployment (bytecode equals the artifact, owner, arbiter,
treasury, fee, tokens allowed). The script prints the `P2P_CONTRACTS_*` and `P2P_DEPLOY_BLOCKS_*`
entries. At boot the API checks every configured address the same way and never serves one that
does not match.

## Environment

See [`.env.example`](.env.example); every variable is documented there and validated at boot.
