# @pedospe/sdk

TypeScript client for the pedospe API, webhook signature verification, and a reference merchant
bot that auto-releases purchases when the local money reaches the merchant's bank account.

- **Typed client**: every route, body and response is typed from the API contract
  (`apps/api/openapi.json`) through [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/).
- **Webhooks**: `verifyWebhook` / `parseWebhook` check the `pedospe-signature` header.
- **Reference bot**: `dist/bot/auto-release.js` matches incoming bank transfers to orders and
  signs their release with the merchant bot's own key.

Requires Node.js 24.9 or later (ESM only).

## Install

```sh
npm install @pedospe/sdk
# only to run the reference bot, which signs transactions:
npm install @stellar/stellar-sdk
```

`@stellar/stellar-sdk` (17.x) is an optional peer dependency: the client and the webhook helpers
do not need it.

## Client

```ts
import { createPedospeClient, PedospeError, unwrap, type Order } from '@pedospe/sdk';

const pedospe = createPedospeClient({
  baseUrl: 'https://api.pedospe.com',
  apiKey: process.env.PEDOSPE_API_KEY, // pk_live_... or pk_test_...
});

// Public: networks, tokens, currencies and rails.
const market = await unwrap(pedospe.GET('/v1/market'));

// A quote: 125050 ARS of USDC on Stellar testnet, paid by bank transfer.
const quote = await unwrap(
  pedospe.POST('/v1/p2p/quotes', {
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
    pedospe.GET('/v1/p2p/orders/{id}', { params: { path: { id: 'order-id' } } }),
  );
  console.log(order.status);
} catch (error) {
  if (error instanceof PedospeError) {
    console.error(error.status, error.code, error.message, error.details);
  }
}
```

- `unwrap(call)` returns the success body, or throws a `PedospeError` with the HTTP `status` and the
  API's `code`, `message` and `details` (every API error is
  `{ "error": { "code", "message", "details"? } }`). Without `unwrap`, each call resolves to
  `{ data, error, response }` as in `openapi-fetch`.
- **Wallet sessions**: pass `sessionToken` (`ps_sess_...`) instead of `apiKey`, with the
  `organizationId` and `tier` (`live` or `test`) to act for; they are sent as the
  `Pedospe-Organization` and `Pedospe-Tier` headers. An API key already carries its organization
  and tier, so the client refuses those options next to one.
- `fetch` replaces `globalThis.fetch` (tests, proxies, retries).
- Friendly type names (`Order`, `MerchantOrder`, `Quote`, `TransferMatch`, `Transaction`, `Submission`,
  `MarketOverview`, `WebhookEnvelope`, `ErrorCode`, ...) are exported next to the raw generated
  `paths`, `components` and `operations`.

## Webhooks

Each delivery is signed:
`pedospe-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. Verify the
**raw** body (not re-serialized JSON) with the endpoint's secret, which the API shows once when the
endpoint is created.

```ts
import express from 'express';
import { parseWebhook, PEDOSPE_SIGNATURE_HEADER, PedospeWebhookError } from '@pedospe/sdk/webhooks';

const app = express();

app.post('/hooks/pedospe', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = parseWebhook({
      payload: req.body.toString('utf8'),
      header: req.get(PEDOSPE_SIGNATURE_HEADER),
      secret: process.env.PEDOSPE_WEBHOOK_SECRET!,
    });
    // Retries carry the same event id: deduplicate on it.
    if (event.type === 'P2P_ORDER_PAID') {
      // event.data is the order
    }
    res.sendStatus(204);
  } catch (error) {
    if (error instanceof PedospeWebhookError) return res.status(400).send(error.reason);
    throw error;
  }
});
```

- `verifyWebhook(options)` returns `true` or `false`; `parseWebhook(options)` returns the
  `{ id, type, createdAt, data }` envelope or throws a `PedospeWebhookError` whose `reason` is
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

Before signing, the bot decodes the transaction (stellar-sdk, the network passphrase from
`GET /v1/market`) and checks that it is exactly `release(<the bot's account>, <the order's on-chain
id>)` on the order's contract (and on `MARKET_CONTRACT` when set), for the order's network, from the
bot's account, with one operation, time bounds and only source-account authorization; anything else
is refused. It signs the envelope with the merchant account's secret (`BOT_SECRET`) and submits it
through the API (`POST /v1/p2p/submit`: the API's sponsor pays the network fee when gasless is on),
waits for the result (`GET /v1/p2p/submissions/{hash}`), and never releases the same order twice in
one run. Every outcome is one JSON line on stdout; keys are never logged. The exit code is 1 when any
transfer failed or was refused.

**The key.** The transfer-match route builds each release for the merchant account (it is the
order's seller), so the bot holds that account's secret: run it where that secret is safe. A
dedicated release-only key (an operator with `PERM_RELEASE` through `set_operator`) cannot be used
by this bot yet, because the route does not build releases for an operator.

| Variable          | Meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `PEDOSPE_API_URL` | The API origin                                                            |
| `PEDOSPE_API_KEY` | The merchant organization's API key (`p2p:read` and `p2p:write`)          |
| `BOT_SECRET`      | The merchant account's Stellar secret (`S...`); not needed with `DRY_RUN` |
| `MIN_SCORE`       | Lowest score that releases, 1 to 3 (default 3)                            |
| `DRY_RUN`         | `true`: decide and log, never sign or send                                |
| `MARKET_CONTRACT` | Optional: the only contract (`C...`) the bot will call                    |

```sh
# In this repository
npm run build -w @pedospe/sdk
DRY_RUN=true PEDOSPE_API_URL=http://localhost:4100 PEDOSPE_API_KEY=pk_test_... \
  npm run bot -w @pedospe/sdk -- transfers.jsonl

# Following a live feed
tail -f bank-feed.jsonl | node node_modules/@pedospe/sdk/dist/bot/auto-release.js
```

Start with `DRY_RUN=true` and read the log before letting it sign.

## Development

| Command                             | What it does                                                       |
| ----------------------------------- | ------------------------------------------------------------------ |
| `npm run generate -w @pedospe/sdk`  | Regenerates `src/generated/schema.ts` from `apps/api/openapi.json` |
| `npm run build -w @pedospe/sdk`     | Compiles to `dist/` and rewrites the `@/` imports (`tsc-alias`)    |
| `npm test -w @pedospe/sdk`          | Runs the tests                                                     |
| `npm run typecheck -w @pedospe/sdk` | Type-checks sources and tests                                      |
| `npm run lint -w @pedospe/sdk`      | ESLint and Prettier                                                |

Run `generate` whenever the API contract changes and commit `src/generated/schema.ts`: it is the
source the client is typed by. The build does not regenerate it.

## License

MIT
