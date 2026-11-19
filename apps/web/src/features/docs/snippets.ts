/* snippets.ts: the docs' code samples, shared by every language (code is not translated; its
   comments are in English like all code). A catalog block '@@code <name>' places one. */

export interface Snippet {
  lang: 'bash' | 'ts' | 'json' | 'csv';
  code: string;
}

const env = `export API="$PEDOSPE_API_URL/v1"
export AUTH="Authorization: Bearer $PEDOSPE_API_KEY"   # pk_test_... or pk_live_...`;

export const SNIPPETS: Record<string, Snippet> = {
  env: { lang: 'bash', code: env },

  market: {
    lang: 'bash',
    code: `curl "$PEDOSPE_API_URL/v1/market" -H "Authorization: Bearer $PEDOSPE_API_KEY"
# -> { "tier": "testnet", "networks": [ { "id": "base", "chainId": 84532, "contract": "0x...",
#      "tokens": [ { "symbol": "USDC", "address": "0x...", "decimals": 6 } ] } ],
#      "currencies": [ { "code": "ARS", "rails": [ { "id": "ar_bank_transfer", "fields": [...] } ] } ],
#      "protocolFeeBps": 30, "windows": { ... }, "sellBondBps": 1000, "matcher": "0x..." }`,
  },

  registerWallet: {
    lang: 'bash',
    code: `curl -X POST $API/accounts/challenge -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "address": "0xYourWallet" }'
# -> { "id": "chl_...", "message": "pedospe wallet registration ...", "expiresAt": "..." }

# Sign "message" with personal_sign in the wallet, then:
curl -X POST $API/accounts -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "challengeId": "chl_...", "signature": "0x...", "label": "Treasury",
        "merchant": { "displayName": "Norte Cambios" } }'`,
  },

  merchantProfile: {
    lang: 'bash',
    code: `curl -X PATCH $API/accounts/ACCOUNT_ID -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "merchant": { "displayName": "Norte Cambios", "status": "PAUSED" } }'`,
  },

  approveDeposit: {
    lang: 'bash',
    code: `curl -X POST $API/transactions -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "network": "base", "from": "0xYourWallet", "action": "approve",
        "args": { "token": "USDC", "amount": "5000000000" } }'
# -> { "chainId": 8453, "to": "0x...", "data": "0x095ea7b3...", "value": "0",
#      "description": "approve" }

# Send it from the wallet, wait until it is mined, then the same with "action": "deposit".`,
  },

  setMatcher: {
    lang: 'bash',
    code: `curl -X POST $API/transactions -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "network": "base", "from": "0xYourWallet", "action": "setMatcher",
        "args": { "maxPerOrder": "1000000000", "autoSettle": false } }'`,
  },

  paymentMethod: {
    lang: 'bash',
    code: `curl -X POST $API/payment-methods -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{
    "accountId": "ACCOUNT_ID",
    "rail": "ar_bank_transfer",
    "holderName": "Norte Cambios SRL",
    "details": { "alias": "norte.cambios.ars", "cuit": "30712345679" },
    "label": "Main account"
  }'`,
  },

  offer: {
    lang: 'bash',
    code: `curl -X POST $API/offers -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{
    "accountId": "ACCOUNT_ID",
    "side": "SELL_TOKEN",
    "network": "base",
    "token": "USDC",
    "currency": "ARS",
    "rails": ["ar_bank_transfer"],
    "price": "1488.50",
    "priceTtlSeconds": 600,
    "minFiat": "10000",
    "maxFiat": "2000000",
    "active": true
  }'`,
  },

  release: {
    lang: 'bash',
    code: `curl -X POST $API/transactions -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "network": "base", "from": "0xYourWallet", "action": "release",
        "args": { "orderId": "ORDER_ID" } }'`,
  },

  setOperator: {
    lang: 'bash',
    code: `curl -X POST $API/transactions -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "network": "base", "from": "0xMerchantWallet", "action": "setOperator",
        "args": { "operator": "0xBotWallet", "permissions": 6 } }'`,
  },

  botMatches: {
    lang: 'ts',
    code: `const API = \`\${process.env.PEDOSPE_API_URL}/v1\`;
const headers = {
  Authorization: \`Bearer \${process.env.PEDOSPE_API_KEY}\`,
  'Content-Type': 'application/json',
};

interface BankTransfer {
  currency: string; // ISO 4217, e.g. "ARS"
  amount: string; // local money as received, e.g. "150000.00"
  payerName?: string; // the sender's name, as the bank reports it
  payerDocument?: string; // the sender's tax id, when the bank reports it
  reference?: string; // the bank's transfer id
}

// Called by your bank integration for every incoming transfer.
export async function onBankTransfer(
  transfer: BankTransfer,
  wallet: { sendTransaction(tx: object): Promise<string> },
) {
  const res = await fetch(\`\${API}/merchant/transfer-matches\`, {
    method: 'POST',
    headers,
    body: JSON.stringify(transfer),
  });
  if (!res.ok) throw new Error(\`transfer-matches failed with \${res.status}\`);
  const { data } = await res.json();

  const best = data[0];
  // Release on its own only when amount, name and document all match; leave the rest to a person.
  if (!best || best.score < 3) return;

  // The bot's wallet signs; its release permission lets it release the merchant's order.
  const hash = await wallet.sendTransaction(best.transaction);
  console.log(\`released order \${best.order.id} (\${best.matchedOn.join(', ')}) in \${hash}\`);
}`,
  },

  botPrice: {
    lang: 'ts',
    code: `await fetch(\`\${API}/offers/\${offerId}\`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({ price: '1488.50' }),
});`,
  },

  buy: {
    lang: 'bash',
    code: `curl -X POST $API/quotes -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "side": "BUY", "network": "base", "token": "USDC", "currency": "ARS",
        "rail": "ar_bank_transfer", "fiatAmount": "50000" }'

curl -X POST $API/orders -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{
    "kind": "BUY",
    "quoteId": "QUOTE_ID",
    "recipient": "0xUserWallet",
    "payer": { "name": "Ana Gómez", "document": "20329642330" },
    "externalReference": "order-881"
  }'
# -> { "id": "...", "status": "pending", "paymentDetails": { ... }, "paymentDeadline": "..." }`,
  },

  buyPaid: {
    lang: 'bash',
    code: `curl -X POST $API/orders/ORDER_ID/paid -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "reference": "TRX-88421" }'`,
  },

  sell: {
    lang: 'bash',
    code: `curl -X POST $API/quotes -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "side": "SELL", "network": "base", "token": "USDC", "currency": "ARS",
        "rail": "ar_bank_transfer", "tokenAmount": "25000000" }'

curl -X POST $API/orders -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{
    "kind": "SELL",
    "quoteId": "QUOTE_ID",
    "seller": "0xUserWallet",
    "beneficiary": { "holderName": "Ana Gómez", "document": "20329642330",
                     "details": { "alias": "ana.gomez.mp", "cuit": "20329642330" } }
  }'
# -> { "id": "...", "status": "pending",
#      "transactions": [ { "action": "approve", ... }, { "action": "openWithDeposit", ... } ] }`,
  },

  charge: {
    lang: 'bash',
    code: `curl -X POST $API/charges -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{
    "currency": "ARS",
    "fiatAmount": "25000",
    "network": "base",
    "token": "USDC",
    "recipient": "ACCOUNT_ID",
    "description": "Order #1042",
    "payeeName": "Tienda Lerma",
    "expiresAt": "2026-12-01T00:00:00Z",
    "multiUse": false
  }'
# -> { "id": "ch_...", "url": "https://<pedospe web>/c/ch_...", "status": "open", ... }`,
  },

  checkout: {
    lang: 'bash',
    code: `# No API key: these are the payer's routes.
curl "$PEDOSPE_API_URL/v1/checkout/charges/CHARGE_ID"

curl -X POST "$PEDOSPE_API_URL/v1/checkout/charges/CHARGE_ID/orders" \\
  -H "Content-Type: application/json" \\
  -d '{ "rail": "ar_bank_transfer",
        "payer": { "name": "Ana Gómez", "document": "32964233", "email": "ana@example.com" } }'
# -> { "id": "...", "status": "pending", "payerToken": "..." }

curl "$PEDOSPE_API_URL/v1/checkout/orders/ORDER_ID" -H "X-Payer-Token: PAYER_TOKEN"`,
  },

  payouts: {
    lang: 'bash',
    code: `curl -X POST $API/payouts -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{
    "network": "base",
    "token": "USDC",
    "accountId": "ACCOUNT_ID",
    "items": [
      {
        "currency": "ARS",
        "fiatAmount": "150000",
        "rail": "ar_bank_transfer",
        "beneficiary": {
          "holderName": "Ana Gómez",
          "document": "20329642330",
          "details": { "cbu": "0170099222000001234561", "cuit": "20329642330" }
        },
        "externalReference": "payroll-2026-11-ana"
      }
    ]
  }'`,
  },

  payoutsCsv: {
    lang: 'csv',
    code: `currency,amount,rail,holderName,document,cbu,alias,cuit,keyType,key,clabe,reference
ARS,150000,ar_bank_transfer,Ana Gómez,20329642330,0170099222000001234561,,20329642330,,,,inv-1001
BRL,820.50,br_pix,João Silva,52998224725,,,,email,joao@example.com,,inv-1002
MXN,2500,mx_spei,María López,GODE561231GR8,,,,,,002010077777777771,inv-1003`,
  },

  apiKey: {
    lang: 'bash',
    code: `# A test key trades on test networks, a live key on mainnets.
curl "$PEDOSPE_API_URL/v1/orders" -H "Authorization: Bearer pk_test_..."`,
  },

  webhookPayload: {
    lang: 'json',
    code: `{
  "id": "evt_01JD6Q...",
  "type": "P2P_ORDER_PAID",
  "createdAt": "2026-11-19T14:02:11.000Z",
  "data": {
    "role": "merchant",
    "id": "ord_...",
    "kind": "BUY",
    "status": "paid",
    "network": "base",
    "token": "0x...",
    "tokenSymbol": "USDC",
    "tokenDecimals": 6,
    "currency": "ARS",
    "rail": "ar_bank_transfer",
    "fiatAmount": "150000.00",
    "tokenAmount": "100771000",
    "paymentDeadline": "2026-11-19T14:30:02.000Z",
    "paidReference": "TRX-88421"
  }
}`,
  },

  webhookVerify: {
    lang: 'ts',
    code: `import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 5 * 60;

/** True when the pedospe-signature header was made with your endpoint's secret over this exact
    raw body, less than five minutes ago. Call it before parsing the JSON. */
export function verifyPedospeSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  if (Math.abs(Date.now() / 1000 - t) > TOLERANCE_SECONDS) return false;

  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest();
  const received = Buffer.from(parts.v1, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// Express: keep the raw body for this route.
// app.post('/hooks/pedospe', express.raw({ type: 'application/json' }), (req, res) => {
//   const ok = verifyPedospeSignature(req.body.toString('utf8'), req.header('pedospe-signature'), SECRET);
//   if (!ok) return res.sendStatus(400);
//   const event = JSON.parse(req.body.toString('utf8'));
//   // Process event.id once; read the order from the API before moving money.
//   res.sendStatus(204);
// });`,
  },
};
