/* The API's operations as typed functions, aligned with apps/api/openapi.json: each sends one
   request (src/lib/api/client.ts) and reads the answer through a normalizer, so the screens get
   one vocabulary whatever the exact wire shape. `scope` adds the organization and tier headers to
   a member's dashboard calls. */
import { ApiError, itemOf, listOf, request, type Tier } from '@/lib/api/client';
import { ORG_HEADER, PAYER_TOKEN_HEADER, ROUTES, TIER_HEADER } from '@/lib/api/routes';
import {
  normalizeApiKey,
  normalizeCreatedApiKey,
  normalizeCreatedWebhook,
  normalizeDelivery,
  normalizeMember,
  normalizeOrganization,
  normalizeSession,
  normalizeWebhook,
  type ApiScope,
  type Role,
} from '@/lib/api/types';
import {
  normalizeAccount,
  normalizeCharge,
  normalizeMarket,
  normalizeMethod,
  normalizeOffer,
  normalizeOrder,
  normalizePayoutBatch,
  normalizeQuote,
  normalizeTransferMatches,
  type Decimals,
} from '@/lib/p2p/normalize';
import { parseCheckoutCharge, parseCheckoutOrder, parseCreatedOrder } from '@/lib/p2p/checkout';
import type { P2pChallenge, P2pMarket, P2pTransaction } from '@/lib/p2p/types';

/** A member's dashboard call: which organization, which tier (`live` or `test`). */
export interface Scope {
  org?: string | null;
  tier?: Tier | null;
}

const scoped = (scope?: Scope): Record<string, string> => ({
  ...(scope?.org ? { [ORG_HEADER]: scope.org } : {}),
  ...(scope?.tier ? { [TIER_HEADER]: scope.tier } : {}),
});

const bad = () =>
  new ApiError(502, 'bad_response', 'The API answered something this page cannot read.');
const must = <T>(v: T | null): T => {
  if (v === null) throw bad();
  return v;
};

/** The tier the public buy/sell app trades on: the API's APP_TIER (`live` unless the deployment
    says otherwise; a local stack on the development chain uses `test`). */
export const APP_TIER: Tier = import.meta.env.VITE_APP_TIER === 'test' ? 'test' : 'live';

/* --- Sign-in with Ethereum --- */

export const auth = {
  /** A single-use nonce and the domain the message must name (the API's SIWE domain). */
  nonce: async (): Promise<{ nonce: string; domain: string | null }> => {
    const r = await request<{ nonce?: unknown; domain?: unknown }>({
      method: 'POST',
      path: ROUTES.authNonce,
    });
    if (typeof r?.nonce !== 'string' || !/^[A-Za-z0-9]{8,}$/.test(r.nonce)) throw bad();
    const domain =
      typeof r.domain === 'string' && /^[a-z0-9.-]+(:\d+)?$/i.test(r.domain) ? r.domain : null;
    return { nonce: r.nonce, domain };
  },
  /** Verify the signed message; the session arrives as an HttpOnly cookie (the token the body
      also carries, for non-browser clients, is never kept). Then read who is signed in. */
  verify: async (message: string, signature: string) => {
    await request({ method: 'POST', path: ROUTES.authVerify, body: { message, signature } });
    const s = await auth.session();
    if (!s) throw bad();
    return s;
  },
  session: async () => {
    try {
      return normalizeSession(await request({ method: 'GET', path: ROUTES.authSession }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  logout: () => request({ method: 'POST', path: ROUTES.authLogout }),
};

/* --- Organizations, members, keys, webhooks --- */

export const orgs = {
  list: async () =>
    listOf(await request({ method: 'GET', path: ROUTES.orgs })).map(normalizeOrganization),
  create: async (name: string) =>
    normalizeOrganization(
      itemOf(await request({ method: 'POST', path: ROUTES.orgs, body: { name } })),
    ),
  rename: async (org: string, name: string) =>
    normalizeOrganization(
      itemOf(await request({ method: 'PATCH', path: ROUTES.org(org), body: { name } })),
    ),
  members: async (org: string) =>
    listOf(await request({ method: 'GET', path: ROUTES.members(org) })).map(normalizeMember),
  addMember: async (org: string, body: { address: string; role: Role }) =>
    normalizeMember(itemOf(await request({ method: 'POST', path: ROUTES.members(org), body }))),
  updateMember: async (org: string, memberId: string, body: { role: Role }) =>
    normalizeMember(
      itemOf(await request({ method: 'PATCH', path: ROUTES.member(org, memberId), body })),
    ),
  removeMember: (org: string, memberId: string) =>
    request({ method: 'DELETE', path: ROUTES.member(org, memberId) }),
};

export const apiKeys = {
  list: async (org: string) =>
    listOf(await request({ method: 'GET', path: ROUTES.apiKeys(org) })).map(normalizeApiKey),
  create: async (org: string, body: { name: string; tier: Tier; scopes: ApiScope[] }) =>
    must(
      normalizeCreatedApiKey(
        itemOf(await request({ method: 'POST', path: ROUTES.apiKeys(org), body })),
      ),
    ),
  revoke: (org: string, id: string) => request({ method: 'DELETE', path: ROUTES.apiKey(org, id) }),
};

export const webhooks = {
  list: async (scope: Scope) =>
    listOf(await request({ method: 'GET', path: ROUTES.webhooks, headers: scoped(scope) })).map(
      normalizeWebhook,
    ),
  create: async (scope: Scope, body: { url: string; events: string[]; description?: string }) =>
    must(
      normalizeCreatedWebhook(
        itemOf(
          await request({ method: 'POST', path: ROUTES.webhooks, body, headers: scoped(scope) }),
        ),
      ),
    ),
  update: async (
    scope: Scope,
    id: string,
    body: { url?: string; events?: string[]; active?: boolean; description?: string },
  ) =>
    normalizeWebhook(
      itemOf(
        await request({ method: 'PATCH', path: ROUTES.webhook(id), body, headers: scoped(scope) }),
      ),
    ),
  remove: (scope: Scope, id: string) =>
    request({ method: 'DELETE', path: ROUTES.webhook(id), headers: scoped(scope) }),
  deliveries: async (scope: Scope, id: string) =>
    listOf(
      await request({
        method: 'GET',
        path: ROUTES.webhookDeliveries(id),
        query: { take: 50 },
        headers: scoped(scope),
      }),
    ).map(normalizeDelivery),
};

/* --- The market --- */

/* The market's published rules (contracts, tokens, bond rate, windows) are read once per tab and
   tier and reused: a sale's terms are checked against this copy, never against a quote. */
const marketCache = new Map<string, P2pMarket>();

async function fetchMarket(tier: Tier): Promise<P2pMarket> {
  return must(
    normalizeMarket(itemOf(await request({ method: 'GET', path: ROUTES.market, query: { tier } }))),
  );
}

export const market = {
  get: async (tier: Tier = APP_TIER): Promise<P2pMarket> => {
    const hit = marketCache.get(tier);
    if (hit) return hit;
    const m = await fetchMarket(tier);
    marketCache.set(tier, m);
    return m;
  },
  /** Forget the cached copies (tests; a market that changed its rules). */
  clear: () => marketCache.clear(),
};

const tx = (raw: unknown, action?: string): P2pTransaction => {
  const o = itemOf(raw) as Record<string, unknown> | null;
  if (!o || typeof o.to !== 'string' || typeof o.data !== 'string') throw bad();
  return {
    chainId: Number(o.chainId),
    to: o.to,
    data: o.data,
    value: typeof o.value === 'string' ? o.value : '0',
    description: typeof o.description === 'string' ? o.description : undefined,
    action: typeof o.action === 'string' ? o.action : action,
  };
};

export interface QuoteInput {
  side: 'BUY' | 'SELL';
  network: string;
  token: string;
  currency: string;
  rail: string;
  fiatAmount?: string;
  tokenAmount?: string;
}

export interface BuyOrderInput {
  side: 'BUY';
  quoteId: string;
  payer: { name: string; document: string };
}
export interface SellOrderInput {
  side: 'SELL';
  quoteId: string;
  beneficiary: { holderName: string; document: string; details: Record<string, string> };
}

/** The buy/sell app: the signed-in wallet's own quotes and orders (`/v1/app/*`). */
export const trade = {
  quote: async (input: QuoteInput, decimals: Decimals = null) =>
    normalizeQuote(
      itemOf(await request({ method: 'POST', path: ROUTES.appQuotes, body: input })),
      decimals,
    ),
  createOrder: async (input: BuyOrderInput | SellOrderInput, decimals: Decimals = null) => {
    // The API takes only these fields: the side comes from the quote.
    const body =
      input.side === 'BUY'
        ? { quoteId: input.quoteId, payer: input.payer }
        : { quoteId: input.quoteId, beneficiary: input.beneficiary };
    return normalizeOrder(
      itemOf(await request({ method: 'POST', path: ROUTES.appOrders, body })),
      decimals,
    );
  },
  orders: async (decimals: Decimals = null) =>
    listOf(await request({ method: 'GET', path: ROUTES.appOrders, query: { take: 50 } })).map((o) =>
      normalizeOrder(o, decimals),
    ),
  order: async (id: string, decimals: Decimals = null) =>
    normalizeOrder(itemOf(await request({ method: 'GET', path: ROUTES.appOrder(id) })), decimals),
  act: async (
    id: string,
    action: 'paid' | 'cancel' | 'dispute',
    body: { reference?: string } = {},
    decimals: Decimals = null,
  ) =>
    normalizeOrder(
      itemOf(
        await request({
          method: 'POST',
          path: ROUTES.appOrderAction(id, action),
          body: action === 'paid' ? body : undefined,
        }),
      ),
      decimals,
    ),
  /** An unsigned transaction for the seller's own wallet, on its own sale. */
  transaction: async (
    orderId: string,
    action: 'accept' | 'markPaid' | 'release' | 'cancel' | 'dispute',
  ) =>
    tx(
      await request({
        method: 'POST',
        path: ROUTES.appOrderTransactions(orderId),
        body: { action },
      }),
      action,
    ),
};

/* --- The merchant / business dashboard (`/v1/p2p/*`) --- */

export const accounts = {
  challenge: async (scope: Scope, address: string): Promise<P2pChallenge> => {
    const o = itemOf(
      await request({
        method: 'POST',
        path: ROUTES.accountChallenge,
        body: { address },
        headers: scoped(scope),
      }),
    ) as Record<string, unknown>;
    if (!o || typeof o.message !== 'string') throw bad();
    return {
      id: typeof o.id === 'string' ? o.id : '',
      message: o.message,
      expiresAt: String(o.expiresAt ?? ''),
    };
  },
  register: async (
    scope: Scope,
    body: { address: string; signature: string; label?: string; displayName?: string },
  ) =>
    normalizeAccount(
      itemOf(
        await request({ method: 'POST', path: ROUTES.accounts, body, headers: scoped(scope) }),
      ),
    ),
  list: async (scope: Scope) =>
    listOf(
      await request({
        method: 'GET',
        path: ROUTES.accounts,
        query: { take: 100 },
        headers: scoped(scope),
      }),
    ).map(normalizeAccount),
  get: async (scope: Scope, id: string) =>
    normalizeAccount(
      itemOf(await request({ method: 'GET', path: ROUTES.account(id), headers: scoped(scope) })),
    ),
  update: async (
    scope: Scope,
    id: string,
    body: { label?: string; displayName?: string; merchantStatus?: 'ACTIVE' | 'PAUSED' },
  ) =>
    normalizeAccount(
      itemOf(
        await request({ method: 'PATCH', path: ROUTES.account(id), body, headers: scoped(scope) }),
      ),
    ),
  remove: (scope: Scope, id: string) =>
    request({ method: 'DELETE', path: ROUTES.account(id), headers: scoped(scope) }),
};

export const methods = {
  list: async (scope: Scope) =>
    listOf(
      await request({
        method: 'GET',
        path: ROUTES.methods,
        query: { take: 100 },
        headers: scoped(scope),
      }),
    ).map(normalizeMethod),
  create: async (
    scope: Scope,
    body: {
      accountId: string;
      currency: string;
      rail: string;
      holderName: string;
      details: Record<string, string>;
      label?: string;
    },
  ) =>
    normalizeMethod(
      itemOf(await request({ method: 'POST', path: ROUTES.methods, body, headers: scoped(scope) })),
    ),
  update: async (
    scope: Scope,
    id: string,
    body: {
      active?: boolean;
      details?: Record<string, string>;
      holderName?: string;
      label?: string;
    },
  ) =>
    normalizeMethod(
      itemOf(
        await request({ method: 'PATCH', path: ROUTES.method(id), body, headers: scoped(scope) }),
      ),
    ),
  remove: (scope: Scope, id: string) =>
    request({ method: 'DELETE', path: ROUTES.method(id), headers: scoped(scope) }),
};

export interface OfferInput {
  accountId: string;
  side: 'SELL_TOKEN' | 'BUY_TOKEN';
  network: string;
  token: string;
  currency: string;
  rails: string[];
  price: string;
  priceTtlSeconds: number;
  minFiat: string;
  maxFiat: string;
  active: boolean;
}

export const offers = {
  list: async (scope: Scope) =>
    listOf(
      await request({
        method: 'GET',
        path: ROUTES.offers,
        query: { take: 100 },
        headers: scoped(scope),
      }),
    ).map(normalizeOffer),
  create: async (scope: Scope, body: OfferInput) =>
    normalizeOffer(
      itemOf(await request({ method: 'POST', path: ROUTES.offers, body, headers: scoped(scope) })),
    ),
  update: async (
    scope: Scope,
    id: string,
    body: Partial<
      Pick<OfferInput, 'active' | 'maxFiat' | 'minFiat' | 'price' | 'priceTtlSeconds' | 'rails'>
    >,
  ) =>
    normalizeOffer(
      itemOf(
        await request({ method: 'PATCH', path: ROUTES.offer(id), body, headers: scoped(scope) }),
      ),
    ),
  remove: (scope: Scope, id: string) =>
    request({ method: 'DELETE', path: ROUTES.offer(id), headers: scoped(scope) }),
};

export const merchant = {
  orders: async (scope: Scope, decimals: Decimals = null) =>
    listOf(
      await request({
        method: 'GET',
        path: ROUTES.merchantOrders,
        query: { take: 100 },
        headers: scoped(scope),
      }),
    ).map((o) => normalizeOrder({ role: 'merchant', ...(o as object) }, decimals)),
  order: async (scope: Scope, id: string, decimals: Decimals = null) =>
    normalizeOrder(
      {
        role: 'merchant',
        ...(itemOf(
          await request({ method: 'GET', path: ROUTES.merchantOrder(id), headers: scoped(scope) }),
        ) as object),
      },
      decimals,
    ),
  transferMatches: async (
    scope: Scope,
    body: {
      currency: string;
      amount: string;
      payerName?: string;
      payerDocument?: string;
      reference?: string;
    },
  ) =>
    normalizeTransferMatches(
      await request({ method: 'POST', path: ROUTES.transferMatches, body, headers: scoped(scope) }),
    ),
};

/** The organization's own orders (as a client) and the unsigned transactions for its wallets. */
export const clientOrders = {
  list: async (scope: Scope, decimals: Decimals = null) =>
    listOf(
      await request({
        method: 'GET',
        path: ROUTES.orders,
        query: { take: 100 },
        headers: scoped(scope),
      }),
    ).map((o) => normalizeOrder(o, decimals)),
  act: async (
    scope: Scope,
    id: string,
    action: 'paid' | 'cancel' | 'dispute',
    body: { reference?: string } = {},
    decimals: Decimals = null,
  ) =>
    normalizeOrder(
      itemOf(
        await request({
          method: 'POST',
          path: ROUTES.orderAction(id, action),
          body: action === 'paid' ? body : undefined,
          headers: scoped(scope),
        }),
      ),
      decimals,
    ),
  /** `from`: one of the organization's account ids (or, on a sale, the seller's address). */
  transaction: async (
    scope: Scope,
    body: { network: string; from: string; action: string; args: Record<string, unknown> },
  ) =>
    tx(
      await request({ method: 'POST', path: ROUTES.transactions, body, headers: scoped(scope) }),
      body.action,
    ),
};

export const charges = {
  list: async (scope: Scope) =>
    listOf(
      await request({
        method: 'GET',
        path: ROUTES.charges,
        query: { take: 100 },
        headers: scoped(scope),
      }),
    ).map(normalizeCharge),
  create: async (
    scope: Scope,
    body: {
      currency: string;
      fiatAmount: string;
      network: string;
      token: string;
      recipient: string;
      payeeName: string;
      description?: string;
      expiresAt?: string;
      multiUse?: boolean;
    },
  ) =>
    normalizeCharge(
      itemOf(await request({ method: 'POST', path: ROUTES.charges, body, headers: scoped(scope) })),
    ),
  remove: async (scope: Scope, id: string) =>
    request({ method: 'DELETE', path: ROUTES.charge(id), headers: scoped(scope) }),
};

export const payouts = {
  list: async (scope: Scope, decimals: Decimals = null) =>
    listOf(
      await request({
        method: 'GET',
        path: ROUTES.payouts,
        query: { take: 50 },
        headers: scoped(scope),
      }),
    ).map((b) => normalizePayoutBatch(b, decimals)),
  get: async (scope: Scope, id: string, decimals: Decimals = null) =>
    normalizePayoutBatch(
      itemOf(await request({ method: 'GET', path: ROUTES.payout(id), headers: scoped(scope) })),
      decimals,
    ),
  create: async (
    scope: Scope,
    body: { accountId: string; network: string; token: string; items: unknown[] },
    decimals: Decimals = null,
  ) =>
    normalizePayoutBatch(
      itemOf(await request({ method: 'POST', path: ROUTES.payouts, body, headers: scoped(scope) })),
      decimals,
    ),
};

/* --- The hosted charge page (keyless) --- */

const payer = (token: string) => ({ [PAYER_TOKEN_HEADER]: token });

export const checkout = {
  charge: async (id: string) =>
    must(parseCheckoutCharge(await request({ method: 'GET', path: ROUTES.checkoutCharge(id) }))),
  open: async (
    id: string,
    input: { rail: string; name: string; document: string; email: string },
  ) =>
    must(
      parseCreatedOrder(
        await request({
          method: 'POST',
          path: ROUTES.checkoutChargeOrders(id),
          body: {
            rail: input.rail,
            payer: {
              name: input.name.trim(),
              document: input.document.trim(),
              email: input.email.trim(),
            },
          },
        }),
      ),
    ),
  order: async (orderId: string, token: string) =>
    must(
      parseCheckoutOrder(
        await request({
          method: 'GET',
          path: ROUTES.checkoutOrder(orderId),
          headers: payer(token),
        }),
      ),
    ),
  paid: async (orderId: string, token: string, reference: string) =>
    must(
      parseCheckoutOrder(
        await request({
          method: 'POST',
          path: ROUTES.checkoutOrderAction(orderId, 'paid'),
          headers: payer(token),
          body: reference.trim() ? { reference: reference.trim().slice(0, 60) } : {},
        }),
      ),
    ),
  cancel: async (orderId: string, token: string) =>
    must(
      parseCheckoutOrder(
        await request({
          method: 'POST',
          path: ROUTES.checkoutOrderAction(orderId, 'cancel'),
          headers: payer(token),
        }),
      ),
    ),
};
