# pedospe: agent and contributor guide

pedospe is a peer-to-peer market for stablecoins (USDC, USDT) against local money (bank
transfers, PIX, SPEI...), with a public API. A user types an amount; the matching service picks a
merchant (no ads book). Merchants keep liquidity in an on-chain contract; the contract locks each
order's tokens until the party receiving the local money releases them.

**Start here: [`docs/HANDOFF.md`](docs/HANDOFF.md)**: the project's history, current state, how to
run the local test server, the design and security invariants, open decisions and the backlog.
Keep it current when a session changes any of those.

## Layout (npm workspaces)

| Path | What |
| --- | --- |
| `packages/contracts` | `P2PMarket.sol`, its committed artifact (ABI + bytecode) and an in-process EVM to test it |
| `apps/api` | the public API (NestJS + Prisma + Postgres): accounts, offers, matching, orders, charges, payouts, webhooks, the indexer and the matcher |
| `apps/web` | the web app: the public buy/sell app, the merchant dashboard, the hosted charge page and the docs |
| `packages/sdk` | TypeScript client for the API and helpers for merchant bots |

## Non-negotiables

- **Non-custodial.** The server never holds a key that can move anyone's tokens. Its only key is
  the matcher's (opens orders within each seller's cap, acts for buyers without gas). Owner and
  arbiter keys live in external multisigs; the API only builds unsigned transactions for them.
- **The contract is the boundary.** Server-side checks spare users reverted transactions; they never
  replace a check in the contract. Changing `P2PMarket.sol` means a new artifact, new tests and a new
  deployment.
- **Never commit a secret.** Deploy scripts read keys from a file outside the repo.

## Conventions

- **Imports: always the `@/` alias, never relative paths** (`./x`, `../x`). Each package's `@/`
  points to its own `src/`. Across packages, import by package name (`@pedospe/contracts`), never
  with `../`. Configure the alias in every tool of the package (tsconfig `paths`, Vite/Vitest,
  bundler, runtime). A package consumed by others exposes built output (`dist/`) through `exports`,
  so its own `@/` never leaks into a consumer.
- **Everything technical is in English**: code, identifiers, comments, logs, errors, CLI messages,
  commits, PRs, READMEs, this file.
- **The UI ships in Spanish and English** through translation files; no user-facing string is
  hard-coded. Spanish is the default.
- **Tests ship with the change.** A new rule, service or route gets its tests in the same commit.
- Conventional commits (`feat(api): ...`, `fix(contracts): ...`).

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | installs every workspace |
| `npm run build` | builds every workspace (contracts first) |
| `npm test` | every workspace's tests |
| `npm run typecheck` | every workspace's type check |
| `npm run compile -w @pedospe/contracts` | recompiles `P2PMarket.sol` into `src/p2p-market.artifact.ts` (the artifact test fails if source and artifact disagree) |

Before finishing a task: run the type check, lint and tests of every workspace you touched, and say
what was verified and what was not.
