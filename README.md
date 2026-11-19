# pedospe

A peer-to-peer market for stablecoins against local money, with a public API.

- **Buy or sell USDC** with a bank transfer, PIX or SPEI: type an amount and the market picks a merchant.
- **Non-custodial**: tokens are locked in an on-chain contract until the party that receives the local
  money releases them. Deadlines refund automatically; disputes go to an arbiter that can only split an
  order between its own buyer and seller.
- **Public API and bots**: merchants automate prices, acceptance and release with API keys, webhooks and
  delegated bot keys; businesses embed buy/sell, collect payments in local money and send payouts.

See [AGENTS.md](AGENTS.md) for the layout and conventions, and [docs/HANDOFF.md](docs/HANDOFF.md) for the project's state, design and open decisions.

## Workspaces

- [`packages/contracts`](packages/contracts): the `P2PMarket` contract and its tests.
- [`apps/api`](apps/api): the public API (routes, auth, webhooks, deploy script).
- `apps/web`: the web app.
- [`packages/sdk`](packages/sdk): the TypeScript SDK and a reference merchant bot.

## Commands

```sh
npm install
npm run build       # every workspace (contracts first)
npm test            # every workspace (the API's e2e tests start their own Postgres and EVM node)
npm run typecheck
npm run lint
```

## Local test server

```sh
npm run dev:stack            # build, then bring the whole market up
npm run dev:stack -- --reset # start over (fresh chain and database)
npm run dev:stack -- --stop  # stop a running stack from another terminal (or Ctrl+C in its own)
npm run dev:simulate -- <orderId>   # "the bank transfer arrived": plays the merchant's bot
```

One command brings up a working market on your machine, from npm packages only:

1. **Postgres**: `docker compose -f docker-compose.dev.yml` when a Docker daemon is already running;
   otherwise an embedded Postgres (`embedded-postgres`). Docker is never started for you. Port 54329.
2. **A local EVM node**: anvil (`@foundry-rs/anvil-<platform>`), chain id 31337, on port 8545, with
   the standard development wallets funded.
3. **Contracts**: `P2PMarket` (owner, arbiter and treasury are dev wallets) and a mintable test dollar
   (`tUSD`, 6 decimals), allowed with `setToken`.
4. **Seed, through the API itself**: a merchant organization ("Pampa Cambio") with a wallet registered
   by signature, ARS and BRL payment methods and offers on both sides, 100 000 tUSD deposited and the
   matcher authorised; a business organization with a test API key, a registered wallet and a charge.
5. **The API** on http://localhost:4000 with the matcher, indexer, expiry and webhook jobs on, and the
   **web app** on http://localhost:3000 when `apps/web` has a `dev` script.

It prints the URLs, the seeded API keys and the dev wallets' private keys. Those keys are public
(the standard development mnemonic): they exist for the local chain only. To use the public app from a
browser wallet, add a network with RPC `http://127.0.0.1:8545` and chain id `31337`, and import the
"user" key. The dev-only "simulate bank transfer" route refuses anything but chain 31337 and is
refused in production.

State (chain, database, seed) lives in `.dev-stack/` and survives restarts; offer prices are
refreshed on resume.
