/* The API's operations as typed functions: each sends one request (src/lib/api/client.ts) and reads
   the answer through a normalizer, so the screens get one vocabulary whatever the exact wire
   shape. `scope` adds the organization and tier headers for dashboard calls. */
import { itemOf, listOf, request, type Tier } from '@/lib/api/client';
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
  type KeyTier,
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
import { ApiError } from '@/lib/api/client';

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

/* --- Sign-in with Ethereum --- */

export const auth = {
  nonce: async (address: string) => {
    const r = await request<{ nonce?: unknown }>({
      method: 'POST',
      path: ROUTES.authNonce,
      body: { address },
    });
    if (typeof r?.nonce !== 'string' || !/^[A-Za-z0-9]{8,}$/.test(r.nonce)) throw bad();
    return r.nonce;
  },
  verify: async (message: string, signature: string) =>
    must(
      normalizeSession(
        await request({ method: 'POST', path: ROUTES.authVerify, body: { message, signature } }),
      ),
    ),
  session: async () => {
    try {
      return normalizeSession(await request({ method: 'GET', path: ROUTES.authSession }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  logout: () => request({ method: 'POST', path: ROUTES.authLogout, body: {} }),
};

/* --- Organizations, members, keys, webhooks --- */

export const orgs = {
  list: async () =>
    listOf(await request({ method: 'GET', path: ROUTES.orgs })).map(normalizeOrganization),
  create: async (name: string) =>
    normalizeOrganization(
      itemOf(await request({ method: 'POST', path: ROUTES.orgs, body: { name } })),
    ),
  members: async (org: string) =>
    listOf(await request({ method: 'GET', path: ROUTES.members(org) })).map(normalizeMember),
  addMember: async (org: string, body: { address: string; role: Role; label?: string }) =>
    normalizeMember(itemOf(await request({ method: 'POST', path: ROUTES.members(org), body }))),
  updateMember: async (org: string, address: string, body: { role: Role }) =>
    normalizeMember(
      itemOf(await request({ method: 'PATCH', path: ROUTES.member(org, address), body })),
    ),
  removeMember: (org: string, address: string) =>
    request({ method: 'DELETE', path: ROUTES.member(org, address) }),
};

export const apiKeys = {
  list: async (scope: Scope) =>
    listOf(await request({ method: 'GET', path: ROUTES.apiKeys, headers: scoped(scope) })).map(
      normalizeApiKey,
    ),
  create: async (scope: Scope, body: { name: string; tier: KeyTier; scopes: ApiScope[] }) =>
    must(
      normalizeCreatedApiKey(
        itemOf(
          await request({ method: 'POST', path: ROUTES.apiKeys, body, headers: scoped(scope) }),
        ),
      ),
    ),
  revoke: (scope: Scope, id: string) =>
    request({ method: 'DELETE', path: ROUTES.apiKey(id), headers: scoped(scope) }),
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
      await request({ method: 'GET', path: ROUTES.webhookDeliveries(id), headers: scoped(scope) }),
    ).map(normalizeDelivery),
  rotate: async (scope: Scope, id: string) =>
    must(
      normalizeCreatedWebhook(
        itemOf(
          await request({
            method: 'POST',
            path: ROUTES.webhookRotate(id),
            body: {},
            headers: scoped(scope),
          }),
        ),
      ),
    ),
  test: (scope: Scope, id: string) =>
    request({ method: 'POST', path: ROUTES.webhookTest(id), body: {}, headers: scoped(scope) }),
};

/* --- The market --- */

/* The market's published rules (contracts, tokens, bond rate, windows) are read once per tab and
   tier and reused: a sale's terms are checked against this copy, never against a quote. */
const marketCache = new Map<string, P2pMarket>();

async function fetchMarket(scope?: Scope): Promise<P2pMarket> {
  return must(
    normalizeMarket(
      itemOf(await request({ method: 'GET', path: ROUTES.market, headers: scoped(scope) })),
    ),
  );
}

export const market = {
  get: async (scope?: Scope): Promise<P2pMarket> => {
    const key = `${scope?.org ?? ''}:${scope?.tier ?? ''}`;
    const hit = marketCache.get(key);
    if (hit) return hit;
    const m = await fetchMarket(scope);
    marketCache.set(key, m);
    return m;
  },
  /** Forget the cached copy (tests; a market that changed its rules). */
  clear: () => marketCache.clear(),
};

const tx = (raw: unknown): P2pTransaction => {
  const o = itemOf(raw) as Record<string, unknown> | null;
  if (!o || typeof o.to !== 'string' || typeof o.data !== 'string') throw bad();
  return {
    chainId: Number(o.chainId),
    to: o.to,
    data: o.data,
    value: typeof o.value === 'string' ? o.value : '0',
    description: typeof o.description === 'string' ? o.description : undefined,
    action: typeof o.action === 'string' ? o.action : undefined,
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

/** The buy/sell app's user (session) and the dashboard's client view of orders. */
export const trade = {
  quote: async (input: QuoteInput, decimals: Decimals = null, scope?: Scope) =>
    normalizeQuote(
      itemOf(
        await request({ method: 'POST', path: ROUTES.quotes, body: input, headers: scoped(scope) }),
      ),
      decimals,
    ),
  createOrder: async (
    input: BuyOrderInput | SellOrderInput,
    decimals: Decimals = null,
    scope?: Scope,
  ) =>
    normalizeOrder(
      itemOf(
        await request({
          method: 'POST',
          path: ROUTES.orders,
          body: { kind: input.side, ...input },
          headers: scoped(scope),
        }),
      ),
      decimals,
    ),
  orders: async (decimals: Decimals = null, scope?: Scope, query?: Record<string, string>) =>
    listOf(
      await request({ method: 'GET', path: ROUTES.orders, query, headers: scoped(scope) }),
    ).map((o) => normalizeOrder(o, decimals)),
  order: async (id: string, decimals: Decimals = null, scope?: Scope) =>
    normalizeOrder(
      itemOf(await request({ method: 'GET', path: ROUTES.order(id), headers: scoped(scope) })),
      decimals,
    ),
  act: async (
    id: string,
    action: 'paid' | 'cancel' | 'dispute',
    body: { reference?: string } = {},
    decimals: Decimals = null,
    scope?: Scope,
  ) =>
    normalizeOrder(
      itemOf(
        await request({
          method: 'POST',
          path: ROUTES.orderAction(id, action),
          body,
          headers: scoped(scope),
        }),
      ),
      decimals,
    ),
  /** An unsigned transaction for the caller's own wallet (the API builds it, the wallet signs). */
  transaction: async (
    body: { network: string; from: string; action: string; args: Record<string, unknown> },
    scope?: Scope,
  ) =>
    tx(await request({ method: 'POST', path: ROUTES.transactions, body, headers: scoped(scope) })),
};

/* --- The merchant / business dashboard --- */

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
    if (!o || typeof o.message !== 'string' || typeof o.id !== 'string') throw bad();
    return { id: o.id, message: o.message, expiresAt: String(o.expiresAt ?? '') };
  },
  register: async (
    scope: Scope,
    body: {
      challengeId: string;
      signature: string;
      label?: string;
      merchant?: { displayName: string };
    },
  ) =>
    normalizeAccount(
      itemOf(
        await request({ method: 'POST', path: ROUTES.accounts, body, headers: scoped(scope) }),
      ),
    ),
  list: async (scope: Scope) =>
    listOf(await request({ method: 'GET', path: ROUTES.accounts, headers: scoped(scope) })).map(
      normalizeAccount,
    ),
  get: async (scope: Scope, id: string) =>
    normalizeAccount(
      itemOf(await request({ method: 'GET', path: ROUTES.account(id), headers: scoped(scope) })),
    ),
  update: async (
    scope: Scope,
    id: string,
    body: {
      label?: string | null;
      merchant?: { displayName?: string; status?: 'ACTIVE' | 'PAUSED' };
    },
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
    listOf(await request({ method: 'GET', path: ROUTES.methods, headers: scoped(scope) })).map(
      normalizeMethod,
    ),
  create: async (scope: Scope, body: Record<string, unknown>) =>
    normalizeMethod(
      itemOf(await request({ method: 'POST', path: ROUTES.methods, body, headers: scoped(scope) })),
    ),
  update: async (scope: Scope, id: string, body: Record<string, unknown>) =>
    normalizeMethod(
      itemOf(
        await request({ method: 'PATCH', path: ROUTES.method(id), body, headers: scoped(scope) }),
      ),
    ),
  remove: (scope: Scope, id: string) =>
    request({ method: 'DELETE', path: ROUTES.method(id), headers: scoped(scope) }),
};

export const offers = {
  list: async (scope: Scope) =>
    listOf(await request({ method: 'GET', path: ROUTES.offers, headers: scoped(scope) })).map(
      normalizeOffer,
    ),
  create: async (scope: Scope, body: Record<string, unknown>) =>
    normalizeOffer(
      itemOf(await request({ method: 'POST', path: ROUTES.offers, body, headers: scoped(scope) })),
    ),
  update: async (scope: Scope, id: string, body: Record<string, unknown>) =>
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
      await request({ method: 'GET', path: ROUTES.merchantOrders, headers: scoped(scope) }),
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

export const charges = {
  list: async (scope: Scope) =>
    listOf(await request({ method: 'GET', path: ROUTES.charges, headers: scoped(scope) })).map(
      normalizeCharge,
    ),
  create: async (scope: Scope, body: Record<string, unknown>) =>
    normalizeCharge(
      itemOf(await request({ method: 'POST', path: ROUTES.charges, body, headers: scoped(scope) })),
    ),
  remove: (scope: Scope, id: string) =>
    request({ method: 'DELETE', path: ROUTES.charge(id), headers: scoped(scope) }),
};

export const payouts = {
  list: async (scope: Scope, decimals: Decimals = null) =>
    listOf(await request({ method: 'GET', path: ROUTES.payouts, headers: scoped(scope) })).map(
      (b) => normalizePayoutBatch(b, decimals),
    ),
  get: async (scope: Scope, id: string, decimals: Decimals = null) =>
    normalizePayoutBatch(
      itemOf(await request({ method: 'GET', path: ROUTES.payout(id), headers: scoped(scope) })),
      decimals,
    ),
  create: async (scope: Scope, body: Record<string, unknown>, decimals: Decimals = null) =>
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
          body: {},
        }),
      ),
    ),
};
