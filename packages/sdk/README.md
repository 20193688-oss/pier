# @midpoint/sdk

TypeScript client for the Midpoint API, webhook signature verification, and a reference merchant
bot that auto-releases purchases when the local money reaches the merchant's bank account.

- **Typed client**: every route, body and response is typed from the API contract
  (`apps/api/openapi.json`) through [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/).
- **Webhooks**: `verifyWebhook` / `parseWebhook` check the `midpoint-signature` header.
- **Reference bot**: `dist/bot/auto-release.js` matches incoming bank transfers to orders and
  signs their release with the merchant bot's own key.

Requires Node.js 24.9 or later (ESM only).

## Install

```sh
npm install @midpoint/sdk
# only to run the reference bot, which signs transactions:
npm install @stellar/stellar-sdk
```

`@stellar/stellar-sdk` (17.x) is an optional peer dependency: the client and the webhook helpers
do not need it.

## Client

```ts
import { createMidpointClient, MidpointError, unwrap, type Order } from '@midpoint/sdk';

const Midpoint = createMidpointClient({
  baseUrl: 'https://api.midpoint.money',
  apiKey: process.env.MIDPOINT_API_KEY, // pk_live_... or pk_test_...
});

// Public: networks, tokens, currencies and rails.
const market = await unwrap(midpoint.GET('/v1/market'));

// A quote: 125050 ARS of USDC on Stellar testnet, paid by bank transfer.
const quote = await unwrap(
  midpoint.POST('/v1/p2p/quotes', {
    body: {
      side: 'BUY',
      network: 'testnet',
      token: 'USDC',
      currency: 'ARS',
      rail: 'ar_bank_transfer',
      fiatAmount: '125050.00',
      integratorFeeBps: 0,
    },
  }),
);
console.log(quote.id, quote.tokenAmount, quote.expiresAt);

try {
  const order: Order = await unwrap(
    midpoint.GET('/v1/p2p/orders/{id}', { params: { path: { id: 'order-id' } } }),
  );
  console.log(order.status);
} catch (error) {
  if (error instanceof MidpointError) {
    console.error(error.status, error.code, error.message, error.details);
  }
}
```

- `unwrap(call)` returns the success body, or throws a `MidpointError` with the HTTP `status` and the
  API's `code`, `message` and `details` (every API error is
  `{ "error": { "code", "message", "details"? } }`). Without `unwrap`, each call resolves to
  `{ data, error, response }` as in `openapi-fetch`.
- **Wallet sessions**: pass `sessionToken` (`ps_sess_...`) instead of `apiKey`, with the
  `organizationId` and `tier` (`live` or `test`) to act for; they are sent as the
  `Midpoint-Organization` and `Midpoint-Tier` headers. An API key already carries its organization
  and tier, so the client refuses those options next to one.
- `fetch` replaces `globalThis.fetch` (tests, proxies, retries).
- Friendly type names (`Order`, `MerchantOrder`, `Quote`, `TransferMatch`, `Transaction`, `Submission`,
  `MarketOverview`, `WebhookEnvelope`, `ErrorCode`, ...) are exported next to the raw generated
  `paths`, `components` and `operations`.

## Webhooks

Each delivery is signed:
`midpoint-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. Verify the
**raw** body (not re-serialized JSON) with the endpoint's secret, which the API shows once when the
endpoint is created.

```ts
import express from 'express';
import {
  parseWebhook,
  MIDPOINT_SIGNATURE_HEADER,
  MidpointWebhookError,
} from '@midpoint/sdk/webhooks';

const app = express();

app.post('/hooks/midpoint', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = parseWebhook({
      payload: req.body.toString('utf8'),
      header: req.get(MIDPOINT_SIGNATURE_HEADER),
      secret: process.env.MIDPOINT_WEBHOOK_SECRET!,
    });
    // Retries carry the same event id: deduplicate on it.
    if (event.type === 'P2P_ORDER_PAID') {
      // event.data is the order
    }
    res.sendStatus(204);
  } catch (error) {
    if (error instanceof MidpointWebhookError) return res.status(400).send(error.reason);
    throw error;
  }
});
```

- `verifyWebhook(options)` returns `true` or `false`; `parseWebhook(options)` returns the
  `{ id, type, createdAt, data }` envelope or throws a `MidpointWebhookError` whose `reason` is
  `malformed_header`, `timestamp_out_of_tolerance`, `signature_mismatch` or `invalid_payload`.
- The MAC is compared in constant time. The timestamp is signed, and deliveries more than
  `toleranceSeconds` (default 300) away from the receiver's clock, in either direction, are
  rejected, so a captured delivery cannot be replayed later.
- `signWebhook({ payload, secret })` signs a body the way the API does, for testing a receiver.

## Reference bot: auto-release

`dist/bot/auto-release.js` reads incoming bank transfers, one JSON object per line, from a file
(first argument) or stdin:

```json
{
  "currency": "ARS",
  "amount": "125050.00",
  "payerName": "Juan Gomez",
  "payerDocument": "20123456786",
  "reference": "TRX-88213",
  "receivedAt": "2026-11-19T12:12:40Z"
}
```

For each one it calls `POST /v1/p2p/merchant/transfer-matches`. The API answers the merchant's
live orders for that exact amount and currency, each scored 1 for the amount, +1 when the payer's
name matches and +1 when the document matches, with its unsigned `release` transaction.

**What it decides** (`chooseMatch`, exported and unit tested):

| Situation                                              | Decision                        |
| ------------------------------------------------------ | ------------------------------- |
| No match                                               | skip (`no_matches`)             |
| Best score below `MIN_SCORE` (default 3)               | skip (`below_threshold`)        |
| Two or more matches share the best score               | skip (`ambiguous`): for a human |
| The single best match is not a purchase (e.g. CHARGE)  | skip (`not_a_purchase`)         |
| One BUY order has the best score, at least `MIN_SCORE` | release it                      |

The bot treats every API answer as untrusted. Before signing, it decodes the transaction with the
passphrase it knows for the order's network (pinned in the bot: testnet, mainnet, local; never taken
from the API) and requires exactly one `release(<the bot's account>, <the order's on-chain id>)` on
its OWN `MARKET_CONTRACT` (never the contract the API names), from the bot's account, with no memo,
no preconditions but an upper time bound at most 6 minutes ahead, a fee (resource fee included)
under `MAX_FEE_STROOPS`, and either no authorization entries or one source-account entry for that
same call with no sub-invocations; a test key never signs on mainnet. Anything else is refused. It
then signs with `BOT_SECRET`, submits through the API (`POST /v1/p2p/submit`: the API's sponsor pays
the network fee when gasless is on), waits for the result (`GET /v1/p2p/submissions/{hash}`), and
never releases the same order twice in one run. Every outcome is one JSON line on stdout; keys are
never logged. The exit code is 1 when any transfer failed or was refused.

**The key.** Run the bot with a separate key that can only release: from the merchant account,
grant it `PERM_RELEASE` (2) with `set_operator` (`POST /v1/p2p/transactions`, action `setOperator`,
`{ "operator": "<bot G...>", "permissions": ["release"] }`). The bot asks the transfer-match route to
build each release for its own account (`signer`), as `release(caller = the operator, id)`; that key
cannot withdraw or move the merchant's balance. The merchant account's own secret also works, but a
leak of it is a leak of the merchant's balance.

| Variable           | Meaning                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `MIDPOINT_API_URL` | The API origin                                                                                                       |
| `MIDPOINT_API_KEY` | The merchant organization's API key (`p2p:read` and `p2p:write`); its prefix is the tier                             |
| `BOT_SECRET`       | The bot's Stellar secret (`S...`): a release-only operator (best) or the merchant account; not needed with `DRY_RUN` |
| `MARKET_CONTRACT`  | Required: the market contract (`C...`, on the tier's network) or `network=C...` pairs                                |
| `MAX_FEE_STROOPS`  | The largest fee it signs, stroops (default 1 000 000 = 0.1 XLM)                                                      |
| `MIN_SCORE`        | Lowest score that releases, 1 to 3 (default 3)                                                                       |
| `DRY_RUN`          | `true`: decide and log, never sign or send                                                                           |

```sh
# In this repository
npm run build -w @midpoint/sdk
DRY_RUN=true MIDPOINT_API_URL=http://localhost:4100 MIDPOINT_API_KEY=pk_test_... MARKET_CONTRACT=C... \
  npm run bot -w @midpoint/sdk -- transfers.jsonl

# Following a live feed
tail -f bank-feed.jsonl | node node_modules/@midpoint/sdk/dist/bot/auto-release.js
```

Start with `DRY_RUN=true` and read the log before letting it sign.

## Development

| Command                              | What it does                                                       |
| ------------------------------------ | ------------------------------------------------------------------ |
| `npm run generate -w @midpoint/sdk`  | Regenerates `src/generated/schema.ts` from `apps/api/openapi.json` |
| `npm run build -w @midpoint/sdk`     | Compiles to `dist/` and rewrites the `@/` imports (`tsc-alias`)    |
| `npm test -w @midpoint/sdk`          | Runs the tests                                                     |
| `npm run typecheck -w @midpoint/sdk` | Type-checks sources and tests                                      |
| `npm run lint -w @midpoint/sdk`      | ESLint and Prettier                                                |

Run `generate` whenever the API contract changes and commit `src/generated/schema.ts`: it is the
source the client is typed by. The build does not regenerate it.

## License

MIT
