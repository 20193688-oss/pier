/* Every API path the web app calls, in one table, so aligning with the API's final route list is
   one edit here. Paths follow the design's route list without the old `/p2p` prefix.

   Who calls what:
   - Session (SIWE cookie): the buy/sell app's user (quotes, their own orders, transactions for
     their own sales) and dashboard members.
   - Dashboard calls also send the organization and tier headers below.
   - Keyless: the hosted charge page's `/v1/checkout/*` (a payer token for its own order). */

const enc = encodeURIComponent;

/** Headers that scope a dashboard member's call to one organization and one tier (an API key's
    prefix decides its tier; a session picks one with this header). */
export const ORG_HEADER = 'X-Organization-Id';
export const TIER_HEADER = 'X-Tier';
/** The hosted charge page's capability for one order. */
export const PAYER_TOKEN_HEADER = 'X-Payer-Token';

export const ROUTES = {
  // Sign-in with Ethereum (EIP-4361)
  authNonce: '/v1/auth/nonce',
  authVerify: '/v1/auth/verify',
  authSession: '/v1/auth/session',
  authLogout: '/v1/auth/logout',

  // Organizations, members, API keys, webhooks
  orgs: '/v1/orgs',
  org: (id: string) => `/v1/orgs/${enc(id)}`,
  members: (org: string) => `/v1/orgs/${enc(org)}/members`,
  member: (org: string, address: string) => `/v1/orgs/${enc(org)}/members/${enc(address)}`,
  apiKeys: '/v1/api-keys',
  apiKey: (id: string) => `/v1/api-keys/${enc(id)}`,
  webhooks: '/v1/webhooks',
  webhook: (id: string) => `/v1/webhooks/${enc(id)}`,
  webhookDeliveries: (id: string) => `/v1/webhooks/${enc(id)}/deliveries`,
  webhookRotate: (id: string) => `/v1/webhooks/${enc(id)}/rotate-secret`,
  webhookTest: (id: string) => `/v1/webhooks/${enc(id)}/test`,

  // The market
  market: '/v1/market',
  accountChallenge: '/v1/accounts/challenge',
  accounts: '/v1/accounts',
  account: (id: string) => `/v1/accounts/${enc(id)}`,
  methods: '/v1/payment-methods',
  method: (id: string) => `/v1/payment-methods/${enc(id)}`,
  offers: '/v1/offers',
  offer: (id: string) => `/v1/offers/${enc(id)}`,
  quotes: '/v1/quotes',
  orders: '/v1/orders',
  order: (id: string) => `/v1/orders/${enc(id)}`,
  orderAction: (id: string, action: 'paid' | 'cancel' | 'dispute') =>
    `/v1/orders/${enc(id)}/${action}`,
  merchantOrders: '/v1/merchant/orders',
  merchantOrder: (id: string) => `/v1/merchant/orders/${enc(id)}`,
  transferMatches: '/v1/merchant/transfer-matches',
  transactions: '/v1/transactions',
  charges: '/v1/charges',
  charge: (id: string) => `/v1/charges/${enc(id)}`,
  payouts: '/v1/payouts',
  payout: (id: string) => `/v1/payouts/${enc(id)}`,

  // The hosted charge page (keyless)
  checkoutCharge: (id: string) => `/v1/checkout/charges/${enc(id)}`,
  checkoutChargeOrders: (id: string) => `/v1/checkout/charges/${enc(id)}/orders`,
  checkoutOrder: (id: string) => `/v1/checkout/orders/${enc(id)}`,
  checkoutOrderAction: (id: string, action: 'paid' | 'cancel') =>
    `/v1/checkout/orders/${enc(id)}/${action}`,
} as const;
