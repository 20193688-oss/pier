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
  transaction,
  type Decimals,
} from '@/lib/p2p/normalize';
import { parseCheckoutCharge, parseCheckoutOrder, parseCreatedOrder } from '@/lib/p2p/checkout';
import type { P2pChallenge, P2pMarket, P2pTransaction } from '@/lib/p2p/types';
import type { SubmitResult } from '@/lib/app/types';
import { body as checked, type Body } from '@/lib/api/spec';

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

/** The tier the public buy/sell app trades on: the API's APP_TIER, `live` unless VITE_APP_TIER
    says otherwise. A development server with no tier set falls back to `test` when `live` has no
    market (the local stack runs the development chain on `test`); a production build never does. */
const TIER_FROM_ENV: Tier | null =
  import.meta.env.VITE_APP_TIER === 'test'
    ? 'test'
    : import.meta.env.VITE_APP_TIER === 'live'
      ? 'live'
      : null;
export const APP_TIER: Tier = TIER_FROM_ENV ?? 'live';

/* --- Sign-in with a Stellar wallet (SEP-10) --- */

export const auth = {
  /** The SEP-10 challenge for `account`: a transaction the wallet signs, never submitted. */
  challenge: async (account: string): Promise<{ transaction: string; networkPassphrase: string }> => {
    const r = await request<{ transaction?: unknown; network_passphrase?: unknown }>({
      method: 'GET',
      path: ROUTES.authChallenge,
      query: { account },
    });
    if (typeof r?.transaction !== 'string' || typeof r.network_passphrase !== 'string') throw bad();
    return { transaction: r.transaction, networkPassphrase: r.network_passphrase };
  },
  /** Verify the signed challenge; the session arrives as an HttpOnly cookie (the token the body
      also carries, for non-browser clients, is never kept). Then read who is signed in. */
  verify: async (transaction: string) => {
    await request({ method: 'POST', path: ROUTES.authVerify, body: checked('SignIn', { transaction }) });
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
      itemOf(
        await request({
          method: 'POST',
          path: ROUTES.orgs,
          body: checked('CreateOrganization', { name }),
        }),
      ),
    ),
  rename: async (org: string, name: string) =>
    normalizeOrganization(
      itemOf(
        await request({
          method: 'PATCH',
          path: ROUTES.org(org),
          body: checked('UpdateOrganization', { name }),
        }),
      ),
    ),
  members: async (org: string) =>
    listOf(await request({ method: 'GET', path: ROUTES.members(org) })).map(normalizeMember),
  addMember: async (org: string, body: { address: string; role: Role }) =>
    normalizeMember(
      itemOf(
        await request({
          method: 'POST',
          path: ROUTES.members(org),
          body: checked('AddMember', body),
        }),
      ),
    ),
  updateMember: async (org: string, memberId: string, body: { role: Role }) =>
    normalizeMember(
      itemOf(
        await request({
          method: 'PATCH',
          path: ROUTES.member(org, memberId),
          body: checked('UpdateMember', body),
        }),
      ),
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
        itemOf(
          await request({
            method: 'POST',
            path: ROUTES.apiKeys(org),
            body: checked('CreateApiKey', body),
          }),
        ),
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
          await request({
            method: 'POST',
            path: ROUTES.webhooks,
            body: checked('CreateWebhookEndpoint', body),
            headers: scoped(scope),
          }),
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
        await request({
          method: 'PATCH',
          path: ROUTES.webhook(id),
          body: checked('UpdateWebhookEndpoint', body),
          headers: scoped(scope),
        }),
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
  /** The buy/sell app's market (see APP_TIER). */
  app: async (): Promise<P2pMarket> => {
    const m = await market.get(APP_TIER);
    if (!m.available && !TIER_FROM_ENV && import.meta.env.DEV) return market.get('test');
    return m;
  },
  /** Forget the cached copies (tests; a market that changed its rules). */
  clear: () => marketCache.clear(),
};

/** An unsigned transaction answer (bare, or `{ transaction }`). */
export const tx = (raw: unknown, action?: string): P2pTransaction => {
  const o = itemOf(raw) as Record<string, unknown> | null;
  const t = transaction(o && typeof o === 'object' && 'transaction' in o ? o.transaction : o, action);
  if (!t) throw bad();
  return t;
};

/** The API's names for the transaction builder's actions (the contract's function names
    differ in case: `mark_paid` is `markPaid`). */
const API_ACTION: Record<string, string> = {
  accept: 'accept',
  mark_paid: 'markPaid',
  release: 'release',
  cancel: 'cancel',
  dispute: 'dispute',
  deposit: 'deposit',
  withdraw: 'withdraw',
  set_operator: 'setOperator',
  set_matcher: 'setMatcher',
};
/** An API action name for a contract function (unknown names pass as they are). */
export const apiAction = (fn: string) => API_ACTION[fn] ?? fn;
export type OrderTxAction = 'accept' | 'mark_paid' | 'release' | 'cancel' | 'dispute';

export interface QrQuoteInput {
  kind: 'QR_PAY';
  network: string;
  token: string;
  /* The scanned EMV payload, exactly as read. */
  qr: string;
  /* The local amount, typed for a static QR; a dynamic QR's own amount wins. */
  fiatAmount?: string;
}

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
      itemOf(
        await request({ method: 'POST', path: ROUTES.appQuotes, body: checked('AppQuote', input) }),
      ),
      decimals,
    ),
  qrQuote: async (input: QrQuoteInput, decimals: Decimals = null) =>
    normalizeQuote(
      itemOf(
        await request({ method: 'POST', path: ROUTES.appQuotes, body: checked('AppQuote', input) }),
      ),
      decimals,
    ),
  /** A QR payment's order: a sale to the matched merchant, with its unsigned
      `open_with_deposit`. */
  createQrOrder: async (input: { quoteId: string; qr: string }, decimals: Decimals = null) =>
    normalizeOrder(
      itemOf(
        await request({
          method: 'POST',
          path: ROUTES.appOrders,
          body: checked('AppOrder', { kind: 'QR_PAY', quoteId: input.quoteId, qr: input.qr }),
        }),
      ),
      decimals,
    ),
  createOrder: async (input: BuyOrderInput | SellOrderInput, decimals: Decimals = null) => {
    // The API takes only these fields: the side comes from the quote.
    const body =
      input.side === 'BUY'
        ? { quoteId: input.quoteId, payer: input.payer }
        : { quoteId: input.quoteId, beneficiary: input.beneficiary };
    return normalizeOrder(
      itemOf(
        await request({ method: 'POST', path: ROUTES.appOrders, body: checked('AppOrder', body) }),
      ),
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
          body: action === 'paid' ? checked('ReportPaidDto', body) : undefined,
        }),
      ),
      decimals,
    ),
  /** Development only (the local network): play the merchant's bot, mark the purchase's
      transfer received and release it. The API refuses it anywhere else. */
  simulateTransfer: (orderId: string) =>
    request({ method: 'POST', path: ROUTES.devSimulateTransfer(orderId), body: {} }),
  /** An unsigned transaction for the seller's own wallet, on its own sale. */
  transaction: async (orderId: string, action: OrderTxAction) =>
    tx(
      await request({
        method: 'POST',
        path: ROUTES.appOrderTransactions(orderId),
        body: checked('AppTransaction', { action: apiAction(action) }),
      }),
      action,
    ),
};

/* --- The merchant / business dashboard (`/v1/p2p/*`) --- */

export const accounts = {
  /** The wallet proof's challenge for `address` (SEP-10 shaped, bound to the organization). */
  challenge: async (scope: Scope, address: string): Promise<P2pChallenge> => {
    const o = itemOf(
      await request({
        method: 'POST',
        path: ROUTES.accountChallenge,
        body: checked('CreateChallengeDto', { address }),
        headers: scoped(scope),
      }),
    ) as Record<string, unknown>;
    if (!o || typeof o.transaction !== 'string') throw bad();
    const passphrase = o.networkPassphrase ?? o.network_passphrase;
    if (typeof passphrase !== 'string') throw bad();
    return {
      transaction: o.transaction,
      networkPassphrase: passphrase,
      expiresAt: String(o.expiresAt ?? ''),
    };
  },
  /** Register the wallet with its signed challenge (the API reads the address from it). */
  register: async (
    scope: Scope,
    body: { address: string; transaction: string; label?: string; displayName?: string },
  ) =>
    normalizeAccount(
      itemOf(
        await request({
          method: 'POST',
          path: ROUTES.accounts,
          body: checked('RegisterAccountDto', {
            transaction: body.transaction,
            ...(body.label ? { label: body.label } : {}),
            ...(body.displayName ? { displayName: body.displayName } : {}),
          }),
          headers: scoped(scope),
        }),
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
        await request({
          method: 'PATCH',
          path: ROUTES.account(id),
          body: checked('UpdateAccountDto', body),
          headers: scoped(scope),
        }),
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
      itemOf(
        await request({
          method: 'POST',
          path: ROUTES.methods,
          body: checked('CreatePaymentMethodDto', body),
          headers: scoped(scope),
        }),
      ),
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
        await request({
          method: 'PATCH',
          path: ROUTES.method(id),
          body: checked('UpdatePaymentMethodDto', body),
          headers: scoped(scope),
        }),
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
      itemOf(
        await request({
          method: 'POST',
          path: ROUTES.offers,
          body: checked('CreateOfferDto', body),
          headers: scoped(scope),
        }),
      ),
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
        await request({
          method: 'PATCH',
          path: ROUTES.offer(id),
          body: checked('UpdateOfferDto', body),
          headers: scoped(scope),
        }),
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
      await request({
        method: 'POST',
        path: ROUTES.transferMatches,
        body: checked('TransferMatchesDto', body),
        headers: scoped(scope),
      }),
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
          body: action === 'paid' ? checked('ReportPaidDto', body) : undefined,
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
      await request({
        method: 'POST',
        path: ROUTES.transactions,
        body: checked('BuildTransactionDto', { ...body, action: apiAction(body.action) }),
        headers: scoped(scope),
      }),
      body.action,
    ),
  /** Submit a signed envelope of one of the organization's accounts (the API fee-bumps it). */
  submit: async (scope: Scope, xdr: string) =>
    must(
      readSubmit(
        await request({
          method: 'POST',
          path: ROUTES.submit,
          body: checked('Submit', { xdr }),
          headers: scoped(scope),
        }),
      ),
    ),
  submission: async (scope: Scope, hash: string) =>
    must(
      readSubmit(
        await request({ method: 'GET', path: ROUTES.submission(hash), headers: scoped(scope) }),
      ),
    ),
};

/** A submission's answer: `{ hash, status: PENDING | SUCCESS | FAILED, error }`. */
export function readSubmit(raw: unknown): SubmitResult | null {
  const o = itemOf(raw) as Record<string, unknown> | null;
  if (!o || typeof o.hash !== 'string') return null;
  const status = o.status === 'SUCCESS' || o.status === 'FAILED' ? o.status : 'PENDING';
  return {
    hash: o.hash,
    status,
    error: typeof o.error === 'string' ? o.error : o.error ? JSON.stringify(o.error) : null,
  };
}

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
      itemOf(
        await request({
          method: 'POST',
          path: ROUTES.charges,
          body: checked('CreateChargeDto', body),
          headers: scoped(scope),
        }),
      ),
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
    body: Body<'CreatePayoutDto'> & { accountId: string },
    decimals: Decimals = null,
  ) =>
    normalizePayoutBatch(
      itemOf(
        await request({
          method: 'POST',
          path: ROUTES.payouts,
          body: checked('CreatePayoutDto', body),
          headers: scoped(scope),
        }),
      ),
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
          body: checked('CreateCheckoutOrderDto', {
            rail: input.rail,
            payer: {
              name: input.name.trim(),
              document: input.document.trim(),
              email: input.email.trim(),
            },
          }),
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
