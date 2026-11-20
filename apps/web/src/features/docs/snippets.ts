/* snippets.ts: the docs' code samples, shared by every language (code is not translated; its
   comments are in English like all code). A catalog block '@@code <name>' places one. Addresses
   in them are placeholders (G... for accounts, C... for contracts); amounts are base units of a
   7-decimal Stellar asset. */

export interface Snippet {
  lang: 'bash' | 'ts' | 'json' | 'csv';
  code: string;
}

const env = `export API="$PEDOSPE_API_URL/v1/p2p"
export AUTH="Authorization: Bearer $PEDOSPE_API_KEY"   # pk_test_... or pk_live_...`;

export const SNIPPETS: Record<string, Snippet> = {
  env: { lang: 'bash', code: env },

  market: {
    lang: 'bash',
    code: `curl "$PEDOSPE_API_URL/v1/market?tier=test"
# -> { "available": true, "tier": "test",
#      "networks": [ { "id": "testnet", "name": "Stellar Testnet",
#        "networkPassphrase": "Test SDF Network ; September 2015",
#        "rpcUrl": "https://soroban-testnet.stellar.org", "horizonUrl": "https://horizon-testnet.stellar.org",
#        "explorerUrl": "https://stellar.expert/explorer/testnet",
#        "contract": "C...", "protocolFeeBps": 30, "paused": false,
#        "tokens": [ { "symbol": "USDC", "code": "USDC", "issuer": "G...", "contract": "C...", "decimals": 7 } ] } ],
#      "currencies": [ { "code": "ARS", "decimals": 2,
#        "rails": [ { "id": "ar_bank_transfer", "fields": [...] }, { "id": "ar_qr", "fields": [] } ] } ],
#      "bondBps": 1000, "maxIntegratorFeeBps": 500, "matcher": "G...", "sponsor": { "enabled": true },
#      "windows": { "buyPaymentWindow": 1800, "sellAcceptWindow": 300,
#                   "sellPaymentWindow": 1800, "sellSettleWindow": 21600 } }`,
  },

  signIn: {
    lang: 'ts',
    code: `import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

// SEP-10: the API answers a challenge transaction for the account; the wallet signs it (it can
// never be submitted: its sequence number is 0) and the API answers a session.
const account = keypair.publicKey(); // G...
const { transaction, network_passphrase } = await (
  await fetch(\`\${BASE}/v1/auth/challenge?account=\${account}\`)
).json();

// Check it before signing: only manage_data operations, the first one "<home domain> auth"
// for this account, signed by the SIGNING_KEY of the site's /.well-known/stellar.toml.
const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
tx.sign(keypair);

const { token } = await (
  await fetch(\`\${BASE}/v1/auth/verify\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: tx.toXDR() }),
  })
).json(); // token: "ps_sess_..." (a browser gets an HttpOnly cookie instead)`,
  },

  registerWallet: {
    lang: 'bash',
    code: `curl -X POST $API/accounts/challenge -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "address": "GYOURWALLET..." }'
# -> { "transaction": "AAAAAgAAAA...", "networkPassphrase": "Test SDF Network ; September 2015",
#      "expiresAt": "..." }
# A SEP-10-shaped challenge bound to your organization: sign it with the wallet (never submit it).

curl -X POST $API/accounts -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "address": "GYOURWALLET...", "transaction": "AAAAAgAAAA...(signed)",
        "label": "Treasury", "displayName": "Norte Cambios" }'`,
  },

  merchantProfile: {
    lang: 'bash',
    code: `curl -X PATCH $API/accounts/ACCOUNT_ID -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "displayName": "Norte Cambios", "merchantStatus": "PAUSED" }'`,
  },

  deposit: {
    lang: 'bash',
    code: `curl -X POST $API/transactions -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "network": "testnet", "from": "ACCOUNT_ID", "action": "deposit",
        "args": { "token": "USDC", "amount": "50000000000" } }'
# -> { "network": "testnet", "action": "deposit", "description": "...",
#      "xdr": "AAAAAgAAAA...", "hash": "9f2c...", "expiresAt": "..." }

# Decode and check the XDR, sign it with the wallet, then hand it back (see "Submit").`,
  },

  submit: {
    lang: 'ts',
    code: `import { TransactionBuilder } from '@stellar/stellar-sdk';

// The API built an unsigned, prepared envelope; the wallet signs it and the API submits it,
// wrapped in a fee-bump from its sponsor account: the wallet never needs XLM for fees.
const tx = TransactionBuilder.fromXDR(built.xdr, networkPassphrase);
// ...check tx: source, one operation, the market contract, the function and every argument...
tx.sign(walletKeypair);

let r = await (
  await fetch(\`\${API}/submit\`, { method: 'POST', headers, body: JSON.stringify({ xdr: tx.toXDR() }) })
).json(); // { hash, status: "PENDING" | "SUCCESS" | "FAILED", error }
while (r.status === 'PENDING') {
  await new Promise((ok) => setTimeout(ok, 1500));
  r = await (await fetch(\`\${API}/submissions/\${r.hash}\`, { headers })).json();
}`,
  },

  setMatcher: {
    lang: 'bash',
    code: `curl -X POST $API/transactions -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "network": "testnet", "from": "ACCOUNT_ID", "action": "set_matcher",
        "args": { "maxPerOrder": "10000000000", "autoSettle": false } }'`,
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
    "network": "testnet",
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

  qrOffer: {
    lang: 'bash',
    code: `# Pay shops' QRs for people (QR_PAY): a BUY_TOKEN offer on the QR rails.
curl -X POST $API/offers -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "accountId": "ACCOUNT_ID", "side": "BUY_TOKEN", "network": "testnet", "token": "USDC",
        "currency": "ARS", "rails": ["ar_qr"], "price": "1452", "priceTtlSeconds": 600,
        "minFiat": "1000", "maxFiat": "500000", "active": true }'`,
  },

  release: {
    lang: 'bash',
    code: `curl -X POST $API/transactions -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "network": "testnet", "from": "ACCOUNT_ID", "action": "release",
        "args": { "orderId": "ORDER_ID" } }'
# Then sign the XDR with the wallet and POST it to $API/submit.`,
  },

  setOperator: {
    lang: 'bash',
    code: `curl -X POST $API/transactions -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{ "network": "testnet", "from": "ACCOUNT_ID", "action": "set_operator",
        "args": { "operator": "GBOTWALLET...", "permissions": 6 } }'`,
  },

  botMatches: {
    lang: 'ts',
    code: `import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

const API = \`\${process.env.PEDOSPE_API_URL}/v1/p2p\`;
const headers = {
  Authorization: \`Bearer \${process.env.PEDOSPE_API_KEY}\`,
  'Content-Type': 'application/json',
};
const bot = Keypair.fromSecret(process.env.BOT_SECRET!); // the bot's own key, never the merchant's

interface BankTransfer {
  currency: string; // ISO 4217, e.g. "ARS"
  amount: string; // local money as received, e.g. "150000.00"
  payerName?: string; // the sender's name, as the bank reports it
  payerDocument?: string; // the sender's tax id, when the bank reports it
  reference?: string; // the bank's transfer id
}

// Called by your bank integration for every incoming transfer.
export async function onBankTransfer(transfer: BankTransfer, networkPassphrase: string) {
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

  // The release is a Stellar transaction; the bot's key signs it (its release permission lets it
  // release the merchant's order) and the API submits it.
  const tx = TransactionBuilder.fromXDR(best.transaction.xdr, networkPassphrase);
  tx.sign(bot);
  await fetch(\`\${API}/submit\`, { method: 'POST', headers, body: JSON.stringify({ xdr: tx.toXDR() }) });
  console.log(\`released order \${best.order.id} (\${best.matchedOn.join(', ')})\`);
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
  -d '{ "side": "BUY", "network": "testnet", "token": "USDC", "currency": "ARS",
        "rail": "ar_bank_transfer", "fiatAmount": "50000" }'

curl -X POST $API/orders -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{
    "kind": "BUY",
    "quoteId": "QUOTE_ID",
    "recipient": "GUSERWALLET...",
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
  -d '{ "side": "SELL", "network": "testnet", "token": "USDC", "currency": "ARS",
        "rail": "ar_bank_transfer", "tokenAmount": "250000000" }'

curl -X POST $API/orders -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{
    "kind": "SELL",
    "quoteId": "QUOTE_ID",
    "seller": "GUSERWALLET...",
    "beneficiary": { "holderName": "Ana Gómez", "document": "20329642330",
                     "details": { "alias": "ana.gomez.mp", "cuit": "20329642330" } }
  }'
# -> { "id": "...", "status": "pending",
#      "transactions": [ { "action": "open_with_deposit", "xdr": "AAAAAgAAAA...", "hash": "...", ... } ] }`,
  },

  qrPay: {
    lang: 'bash',
    code: `# The person scanned a shop's QR (EMV payload, CRC checked). Session routes: the app's own.
curl -X POST "$PEDOSPE_API_URL/v1/app/quotes" -b session.txt -H "Content-Type: application/json" \\
  -d '{ "kind": "QR_PAY", "network": "testnet", "token": "USDC",
        "qr": "00020101021243...6304ABCD", "fiatAmount": "12500.00" }'

curl -X POST "$PEDOSPE_API_URL/v1/app/orders" -b session.txt -H "Content-Type: application/json" \\
  -d '{ "kind": "QR_PAY", "quoteId": "QUOTE_ID", "qr": "00020101021243...6304ABCD" }'
# -> the order and its unsigned open_with_deposit: accept 2 min, payment 10 min, settle 1 h.`,
  },

  appTransfer: {
    lang: 'bash',
    code: `curl -X POST "$PEDOSPE_API_URL/v1/app/transfers" -b session.txt -H "Content-Type: application/json" \\
  -d '{ "network": "testnet", "to": "@lucia", "token": "USDC", "amount": "125000000",
        "note": "Asado" }'
# -> { "transfer": { "id": "...", "to": "G...", "toHandle": "lucia", "status": "PENDING", ... },
#      "transaction": { "xdr": "AAAAAgAAAA...", ... } }   # a payment; sign it, then POST /v1/app/submit`,
  },

  charge: {
    lang: 'bash',
    code: `curl -X POST $API/charges -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{
    "currency": "ARS",
    "fiatAmount": "25000",
    "network": "testnet",
    "token": "USDC",
    "recipient": "ACCOUNT_ID",
    "description": "Order #1042",
    "payeeName": "Tienda Lerma",
    "expiresAt": "2026-12-01T00:00:00Z",
    "multiUse": false
  }'
# -> { "id": "ch_...", "url": "https://<web>/pay/ch_...", "status": "open", ... }`,
  },

  checkout: {
    lang: 'bash',
    code: `# No API key: these are the payer's routes.
curl "$PEDOSPE_API_URL/v1/p2p-checkout/charges/CHARGE_ID"

curl -X POST "$PEDOSPE_API_URL/v1/p2p-checkout/charges/CHARGE_ID/orders" \\
  -H "Content-Type: application/json" \\
  -d '{ "rail": "ar_bank_transfer",
        "payer": { "name": "Ana Gómez", "document": "32964233", "email": "ana@example.com" } }'
# -> { "id": "...", "status": "pending", "payerToken": "..." }

curl "$PEDOSPE_API_URL/v1/p2p-checkout/orders/ORDER_ID" -H "X-Payer-Token: PAYER_TOKEN"`,
  },

  payouts: {
    lang: 'bash',
    code: `curl -X POST $API/payouts -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{
    "network": "testnet",
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
    code: `# A test key trades on Stellar testnet, a live key on mainnet.
curl "$PEDOSPE_API_URL/v1/p2p/orders" -H "Authorization: Bearer pk_test_..."`,
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
    "network": "testnet",
    "token": "C...",
    "tokenSymbol": "USDC",
    "tokenDecimals": 7,
    "currency": "ARS",
    "rail": "ar_bank_transfer",
    "fiatAmount": "150000.00",
    "tokenAmount": "1007710000",
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
