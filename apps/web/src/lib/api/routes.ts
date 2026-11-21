/* Every API path the web app calls, in one table, aligned with the API's committed OpenAPI
   document (apps/api/openapi.json).

   Who calls what:
   - Wallet session (SEP-10, HttpOnly cookie): the payments app's user on `/v1/app/*` (their own
     profile, balances, transfers, quotes and orders, and the transactions they sign), and
     dashboard members on `/v1/organizations/*` and, with the organization and tier headers below,
     `/v1/p2p/*` and `/v1/webhook-endpoints`.
   - No credentials: the market overview, sign-in, and the hosted charge page's
     `/v1/p2p-checkout/*` (a payer token for its own order). */

const enc = encodeURIComponent;

/** Headers that scope a member's session call to one organization and one tier (an API key
    carries both). */
export const ORG_HEADER = 'Midpoint-Organization';
export const TIER_HEADER = 'Midpoint-Tier';
/** The hosted charge page's capability for one order. */
export const PAYER_TOKEN_HEADER = 'X-Payer-Token';

export const ROUTES = {
  // Sign-in with a Stellar wallet (SEP-10)
  authChallenge: '/v1/auth/challenge',
  authVerify: '/v1/auth/verify',
  authSession: '/v1/auth/session',
  authLogout: '/v1/auth/logout',

  // Organizations, members, API keys
  orgs: '/v1/organizations',
  org: (id: string) => `/v1/organizations/${enc(id)}`,
  members: (org: string) => `/v1/organizations/${enc(org)}/members`,
  member: (org: string, memberId: string) =>
    `/v1/organizations/${enc(org)}/members/${enc(memberId)}`,
  apiKeys: (org: string) => `/v1/organizations/${enc(org)}/api-keys`,
  apiKey: (org: string, id: string) => `/v1/organizations/${enc(org)}/api-keys/${enc(id)}`,

  // Webhook endpoints (organization and tier headers)
  webhooks: '/v1/webhook-endpoints',
  webhook: (id: string) => `/v1/webhook-endpoints/${enc(id)}`,
  webhookDeliveries: (id: string) => `/v1/webhook-endpoints/${enc(id)}/deliveries`,

  // The market overview (public; `?tier=live|test`)
  market: '/v1/market',

  // The payments app (the signed-in wallet acting for itself)
  appProfile: '/v1/app/profile',
  appHandle: (handle: string) => `/v1/app/handles/${enc(handle)}`,
  appBalances: '/v1/app/balances',
  appActivate: '/v1/app/activate',
  appTransfers: '/v1/app/transfers',
  appTransfer: (id: string) => `/v1/app/transfers/${enc(id)}`,
  appActivity: '/v1/app/activity',
  appCharge: (id: string) => `/v1/app/charges/${enc(id)}`,
  appChargePayments: (id: string) => `/v1/app/charges/${enc(id)}/payments`,
  appSubmit: '/v1/app/submit',
  appSubmission: (hash: string) => `/v1/app/submissions/${enc(hash)}`,
  appQuotes: '/v1/app/quotes',
  appOrders: '/v1/app/orders',
  appOrder: (id: string) => `/v1/app/orders/${enc(id)}`,
  appOrderAction: (id: string, action: 'paid' | 'cancel' | 'dispute') =>
    `/v1/app/orders/${enc(id)}/${action}`,
  appOrderTransactions: (id: string) => `/v1/app/orders/${enc(id)}/transactions`,
  /* An order's chat: the app wallet's, an integrator's (creator) or the merchant's side. */
  orderMessages: (scope: 'app' | 'org' | 'merchant', id: string) =>
    `${scope === 'app' ? '/v1/app/orders' : scope === 'org' ? '/v1/p2p/orders' : '/v1/p2p/merchant/orders'}/${enc(id)}/messages`,
  orderMessageAttachment: (scope: 'app' | 'org' | 'merchant', id: string, messageId: string) =>
    `${scope === 'app' ? '/v1/app/orders' : scope === 'org' ? '/v1/p2p/orders' : '/v1/p2p/merchant/orders'}/${enc(id)}/messages/${enc(messageId)}/attachment`,
  // Development only (the local network): the merchant bot's part of a purchase, simulated.
  devSimulateTransfer: (id: string) => `/v1/dev/orders/${enc(id)}/simulate-transfer`,

  // The dashboard's market (organization and tier headers)
  accountChallenge: '/v1/p2p/accounts/challenge',
  accounts: '/v1/p2p/accounts',
  account: (id: string) => `/v1/p2p/accounts/${enc(id)}`,
  methods: '/v1/p2p/payment-methods',
  method: (id: string) => `/v1/p2p/payment-methods/${enc(id)}`,
  offers: '/v1/p2p/offers',
  offer: (id: string) => `/v1/p2p/offers/${enc(id)}`,
  quotes: '/v1/p2p/quotes',
  orders: '/v1/p2p/orders',
  order: (id: string) => `/v1/p2p/orders/${enc(id)}`,
  orderAction: (id: string, action: 'paid' | 'cancel' | 'dispute') =>
    `/v1/p2p/orders/${enc(id)}/${action}`,
  merchantOrders: '/v1/p2p/merchant/orders',
  merchantOrder: (id: string) => `/v1/p2p/merchant/orders/${enc(id)}`,
  transferMatches: '/v1/p2p/merchant/transfer-matches',
  transactions: '/v1/p2p/transactions',
  submit: '/v1/p2p/submit',
  submission: (hash: string) => `/v1/p2p/submissions/${enc(hash)}`,
  charges: '/v1/p2p/charges',
  charge: (id: string) => `/v1/p2p/charges/${enc(id)}`,
  payouts: '/v1/p2p/payouts',
  payout: (id: string) => `/v1/p2p/payouts/${enc(id)}`,

  // The hosted charge page (keyless)
  checkoutCharge: (id: string) => `/v1/p2p-checkout/charges/${enc(id)}`,
  checkoutChargeOrders: (id: string) => `/v1/p2p-checkout/charges/${enc(id)}/orders`,
  checkoutOrder: (id: string) => `/v1/p2p-checkout/orders/${enc(id)}`,
  checkoutOrderAction: (id: string, action: 'paid' | 'cancel') =>
    `/v1/p2p-checkout/orders/${enc(id)}/${action}`,
} as const;
