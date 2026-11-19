# pedospe

A peer-to-peer market for stablecoins against local money, with a public API.

- **Buy or sell USDC** with a bank transfer, PIX or SPEI: type an amount and the market picks a merchant.
- **Non-custodial**: tokens are locked in an on-chain contract until the party that receives the local
  money releases them. Deadlines refund automatically; disputes go to an arbiter that can only split an
  order between its own buyer and seller.
- **Public API and bots**: merchants automate prices, acceptance and release with API keys, webhooks and
  delegated bot keys; businesses embed buy/sell, collect payments in local money and send payouts.

See [AGENTS.md](AGENTS.md) for the layout and conventions.

## Workspaces

- [`packages/contracts`](packages/contracts): the `P2PMarket` contract and its tests.
- `apps/api`: the public API.
- `apps/web`: the web app.
- `packages/sdk`: the TypeScript SDK.
