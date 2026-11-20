# @pedospe/contracts

The P2PMarket Soroban contract (Rust crate `p2p-market`, contract `P2PMarket`), its committed
release wasm and interface spec, and the constants and value shapes JavaScript needs. It is a port
of the EVM `P2PMarket.sol` with the same rules; the binding interface is
[`docs/STELLAR.md`](../../docs/STELLAR.md) section 4.

The package has **no runtime dependency**. Consumers decode with stellar-sdk 17:

```ts
import { contract } from '@stellar/stellar-sdk';
import { MARKET_ERRORS, MARKET_SPEC, MARKET_WASM_HASH } from '@pedospe/contracts';

const spec = new contract.Spec([...MARKET_SPEC]);
const args = spec.funcArgsToScVals('open', { caller, p }); // p: OpenParams
```

## Layout

| Path                            | What                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `contracts/p2p-market/src`      | the contract: `lib.rs` (rules), `types.rs`, `events.rs`, `errors.rs`, `storage.rs`                           |
| `contracts/p2p-market/src/test` | the Rust tests (one module per area, plus the property walk)                                                 |
| `src/p2p-market.artifact.ts`    | GENERATED: the wasm (base64), its hash, the spec, the error table                                            |
| `src/market.ts`                 | `ORDER_STATUS`, `PERMISSIONS`, `LIMITS` and the `Order`, `OpenParams`, `MatcherTerms`, `MarketConfig` shapes |
| `scripts/compile.ts`            | the build pipeline (cargo, spec shaking, path remapping, artifact)                                           |
| `test/*.test.ts`                | artifact = fresh build; spec = wasm section; the binding interface; constants                                |

## Exports

| Export               | What                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------- |
| `MARKET_WASM_BASE64` | the committed release wasm                                                             |
| `MARKET_WASM_HASH`   | hex SHA-256 of that wasm: the hash it is installed under on-chain                      |
| `MARKET_SPEC`        | the wasm's `contractspecv0` section, one base64 XDR `ScSpecEntry` per item             |
| `MARKET_ERRORS`      | contract error code -> name                                                            |
| `MARKET_BUILD`       | crate, soroban-sdk, rustc, target and size of the build                                |
| `ORDER_STATUS`       | `None 0, Offered 1, Active 2, Paid 3, Disputed 4, Released 5, Cancelled 6, Resolved 7` |
| `PERMISSIONS`        | `PERM_OPEN 1, PERM_RELEASE 2, PERM_TRADE 4, PERM_WITHDRAW 8, PERM_ALL 15`              |
| `LIMITS`             | fee caps (300 / 500 bps), window bounds (seconds), `BPS`                               |
| types                | `Order`, `OpenParams`, `MatcherTerms`, `MarketConfig`, `OrderStatus`                   |

The shapes are what stellar-sdk's `Spec` produces: an `Address` is its StrKey string, `i128` and
`u64` are `bigint`, `u32` is `number`, `BytesN<32>` is a `Uint8Array`, an `Option` that is None is
`null`. Field names are the contract's own (snake_case).

## Interface

Where Solidity read `msg.sender`, a function takes the acting address as an explicit argument and
requires its authorization. Every function returns a plain value (no `Result`); a refusal fails the
call with `Error(Contract, #code)`.

| Function                                                                                                                    | Who authorizes                                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `__constructor(owner, treasury, arbiter, protocol_fee_bps)`                                                                 | (deploy)                                                                           |
| `set_protocol_fee(bps)`, `set_treasury`, `set_arbiter`, `set_token(token, allowed)`, `set_paused`, `transfer_ownership(to)` | the owner                                                                          |
| `accept_ownership()`                                                                                                        | the pending owner                                                                  |
| `deposit(account, token, amount)`                                                                                           | `account` (its auth also covers the token pull)                                    |
| `withdraw(account, token, amount)`                                                                                          | `account`; always paid to `account`                                                |
| `withdraw_for(operator, account, token, amount)`                                                                            | `operator` with `PERM_WITHDRAW` (or `account` itself)                              |
| `set_operator(account, operator, perms)`                                                                                    | `account`; `perms` 0 revokes                                                       |
| `set_matcher(seller, matcher, max_per_order, auto_settle)`                                                                  | `seller`; 0 revokes                                                                |
| `open(caller, p) -> u64`                                                                                                    | `caller`: the seller, a `PERM_OPEN` operator, or a matcher within its cap          |
| `open_with_deposit(p) -> u64`                                                                                               | `p.seller`; pulls `p.amount` from it                                               |
| `accept(caller, id)`                                                                                                        | the buyer or its `PERM_TRADE` operator                                             |
| `mark_paid(caller, id)`                                                                                                     | the buyer's side (buyer, its `PERM_TRADE` operator, or the matcher that opened it) |
| `release(caller, id)`                                                                                                       | the seller or its `PERM_RELEASE` operator                                          |
| `cancel(caller, id)`                                                                                                        | per status (below); anyone after a deadline                                        |
| `dispute(caller, id)`                                                                                                       | either side; the seller's only inside the settle window                            |
| `settle(id)`                                                                                                                | nobody (anyone may call)                                                           |
| `resolve(id, to_buyer, bond_to_seller)`                                                                                     | the arbiter                                                                        |

Views: `config()`, `get_order(id)` (fails `UnknownOrder`), `order_id_of(opener, ref_id)` (0 =
none), `balance_of(account, token)`, `permissions_of(account, operator)`,
`matcher_terms_of(seller, matcher)`, `token_allowed(token)`, `order_count()` (ids run 1..count).

Cancel: an `Offered` order by either side at any time, by anyone after the accept deadline; an
`Active` order by the buyer's side at any time, by anyone after the payment deadline; a `Paid`
order only by the buyer or its `PERM_TRADE` operator. A cancellation always refunds the seller (to
its market balance when the order came from it, else to its wallet) and returns an accepted bond
to the buyer's balance. The deadline is inclusive: at `now == deadline` the buyer may still act.

Fees: the protocol fee (cap 300 bps) and the integrator fee (cap 500 bps) are recorded on the order
at open and taken from what the buyer receives; nothing is taken from refunds. The owner can never
move funds, a pause stops deposits, new orders and acceptances only, and the contract is not
upgradeable.

**Token transfers.** Pulls use the token's `transfer(from, market, amount)` under `from`'s
authorization (no allowance), then check that the market's balance grew by exactly `amount`
(`ShortDeposit`). Pushes use `try_transfer`; when the token refuses one (no trustline, a frozen or
deauthorized holder) the amount is credited to the recipient's market balance and `credited` is
emitted, so one recipient can never freeze an order. Only Stellar Asset Contracts should be
allowed.

**Events.** One per Solidity event: the first topic is the snake_case name, the fields that were
`indexed` are topics, the rest is a data map. `order_opened` (topic `id`) carries every `Order`
field but `paid_at`; `order_released.by` is None when it came from `settle`; `order_cancelled.by`
is None when a passed deadline alone allowed it; `ownership_transferred.from` is None at
construction. Events with an `Option` field publish it as void instead of omitting it.

### Errors

| Code | Name            | Code | Name                | Code | Name               |
| ---- | --------------- | ---- | ------------------- | ---- | ------------------ |
| 1    | NotOwner        | 9    | BadWindow           | 17   | WrongStatus        |
| 2    | NotPendingOwner | 10   | BadIntegrator       | 18   | Expired            |
| 3    | NotArbiter      | 11   | SameParty           | 19   | NotYet             |
| 4    | NotAuthorized   | 12   | RefTaken            | 20   | BadSplit           |
| 5    | IsPaused        | 13   | EmptyRef            | 21   | InvalidPermissions |
| 6    | ZeroAmount      | 14   | InsufficientBalance | 22   | NegativeAmount     |
| 7    | TokenNotAllowed | 15   | ShortDeposit        |      |                    |
| 8    | FeeTooHigh      | 16   | UnknownOrder        |      |                    |

`NotOwner` and `NotArbiter` are reserved: the owner functions and `resolve` require the stored
owner's or arbiter's authorization, so a stranger fails the host's auth check
(`Error(Auth, InvalidAction)`) before the contract could say so.

## Storage and TTL

| Storage    | Keys (`DataKey`)                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| instance   | `Config`, `NextId`, `Token(token)` (present = allowed)                                                                      |
| persistent | `Order(id)`, `Ref(opener, ref_id)`, `Balance(account, token)`, `Permissions(account, operator)`, `Matcher(seller, matcher)` |

A zero balance, a revoked operator and a revoked matcher are removed, not stored.

| Entry      | Extended when                                               | Threshold                 | Extended to       |
| ---------- | ----------------------------------------------------------- | ------------------------- | ----------------- |
| instance   | every call (views too); also extends the contract code      | 15 days (259,200 ledgers) | 30 days (518,400) |
| persistent | written, or read by a state-changing call (never by a view) | 15 days                   | 30 days           |

Ledger counts assume 5 seconds per ledger (`storage.rs`). An entry nobody touches for a month is
archived, never lost: the client restores it with the simulation's restore preamble.

## Commands

| Command                                   | What it does                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run compile -w @pedospe/contracts`   | builds the release wasm and regenerates `src/p2p-market.artifact.ts`; writes the wasm to `target/p2p-market.wasm` |
| `npm test -w @pedospe/contracts`          | `cargo test` (every Rust test) then vitest (artifact = fresh build, spec, interface)                              |
| `npm run lint -w @pedospe/contracts`      | eslint + prettier, `cargo fmt --check`, `cargo clippy -D warnings`                                                |
| `npm run typecheck -w @pedospe/contracts` | `tsc --noEmit`                                                                                                    |
| `npm run build -w @pedospe/contracts`     | builds `dist/` (no runtime dependency)                                                                            |

Requirements: rustup (the toolchain in `rust-toolchain.toml`, 1.97.1 with the `wasm32v1-none`
target, installs on first use) and Node 24.9+. The Stellar CLI is not needed to build.

## Reproducible builds

- **Pinned inputs:** rustc 1.97.1 (`rust-toolchain.toml`), `Cargo.lock` (soroban-sdk 29.0.1), and
  `--locked`. The release profile is in `Cargo.toml`.
- **Spec shaking.** soroban-sdk 28+ writes a spec entry for every type and event it compiles and
  leaves the trimming to the build system (`stellar contract build` from stellar-cli 25.2+; its
  build script refuses to build without one). `scripts/compile.ts` is that build system: it sets
  `SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2` and applies `soroban_spec::shaking::filter`
  (keep every function, keep any other entry only when its `SpEcV1` marker is in a data segment),
  rewriting the `contractspecv0` section in place. It drops `DataKey` and the SDK's own auth types.
- **No host paths.** Panic locations (soroban-sdk's own `unwrap()`s) embed source paths, so every
  source directory of every crate linked into the wasm is passed to rustc as
  `--remap-path-prefix=<dir>=<crate>-<version>/<dir>/` (forward slashes). The build fails if a
  backslash, a drive or the cargo home is left in the wasm. Caller `RUSTFLAGS` are ignored.
- **Check:** the vitest artifact test rebuilds and compares byte for byte. Rust normalizes CRLF in
  sources, so a Windows checkout with `autocrlf` builds the same bytes.

To verify a deployment, compare the installed wasm hash (`stellar contract info` or the deploy
output's "Using wasm hash") with `MARKET_WASM_HASH`.

## Deploying (testnet example)

```sh
npm run compile -w @pedospe/contracts        # writes target/p2p-market.wasm
stellar contract deploy --wasm packages/contracts/target/p2p-market.wasm \
  --source <deployer> --network testnet \
  -- --owner <owner> --treasury <treasury> --arbiter <arbiter> --protocol_fee_bps 100
stellar contract invoke --id <market> --source <owner> --network testnet \
  -- set_token --token <SAC> --allowed true
```

An `OpenParams` goes to the CLI as JSON: `--p '{"ref_id":"<64 hex>","seller":"G...","buyer":"G...",
"token":"C...","amount":"400000000","bond":"0","accept_window":0,"payment_window":1800,
"settle_window":0,"integrator":null,"integrator_fee_bps":0}'`. Keys live outside the repo.

## Differences from the EVM contract

- The acting address is an argument that must authorize (`caller`, `account`, `operator`,
  `seller`); `open_with_deposit` takes the seller's authorization instead of checking the sender.
- No zero address and no `ZeroAddress` error; `integrator: None` replaces the zero integrator.
- No reentrancy guard and no `Reentrant` error: the host refuses re-entry.
- A missing owner or arbiter authorization is the host's auth failure, not `NotOwner` /
  `NotArbiter`.
- Amounts are `i128`; a negative amount, bond, cap or split fails with `NegativeAmount`.
- Errors carry only their code (no `InsufficientBalance(available, needed)` arguments).
- A withdrawal the token refuses fails the call (the EVM's `TokenCallFailed`), keeping the balance.
- `cancel` reports `by: None` when a passed deadline alone allowed it.
- `ownership_transferred.from` is `None` at construction (the EVM's zero address).
