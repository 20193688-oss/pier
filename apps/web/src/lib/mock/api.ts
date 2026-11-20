/* The mock API: answers the web app's requests (src/lib/api/routes.ts) from the mock state, with
   the API's wire shapes, status codes and error shape `{ error: { code, message } }`. Installed
   as the client's transport in mock mode (src/lib/mock/index.ts). */
import type { ApiRequest, ApiResponse } from '@/lib/api/client';
import { ORG_HEADER, PAYER_TOKEN_HEADER } from '@/lib/api/routes';
import { checkBeneficiary, isRailId, RAILS } from '@/lib/p2p/rails';
import {
  CURRENCIES,
  MARKET,
  MERCHANTS,
  MERCHANT_ACCOUNTS,
  NETWORKS,
  OTHER_MERCHANT,
  PRICES,
  RULES,
} from '@/lib/mock/fixtures';
import { db, iso, makeOrder, now, pub, rid, save, tick, units, type Wire } from '@/lib/mock/db';
import {
  buildTransaction,
  chainAccount,
  orderCall,
  saleOpen,
  submitEnvelope,
  fnOf,
} from '@/lib/mock/chain';
import { appRoutes, qrQuote, qrOrder, sep10Challenge, sep10Verify } from '@/lib/mock/app-api';
import { myAppOrders, orderView } from '@/lib/mock/views';
import { isAccount } from '@/lib/stellar/network';
import { byNewest, fail, list, none, ok, session, type Ctx, type Handler } from '@/lib/mock/http';

const MERCHANT_SELLER = OTHER_MERCHANT;


/** The organization a dashboard call names, if the signed-in wallet belongs to it. */
function orgOf(ctx: Ctx): string | ApiResponse {
  const s = session();
  if (!s) return fail(401, 'unauthenticated', 'Sign in first.');
  const org = ctx.header(ORG_HEADER) ?? ctx.params.org;
  if (!org) return fail(400, 'organization_required', 'Name the organization.');
  const member = (db().members[org] ?? []).some((m) => m.address === s.address);
  return member ? org : fail(403, 'forbidden', 'Not a member of this organization.');
}
const isResp = (v: unknown): v is ApiResponse =>
  typeof v === 'object' && v !== null && 'status' in v && 'json' in v;

function withOrg(fn: (ctx: Ctx, org: string) => ApiResponse | Promise<ApiResponse>): Handler {
  return (ctx) => {
    const org = orgOf(ctx);
    return isResp(org) ? org : fn(ctx, org);
  };
}

const network = (id: string) => NETWORKS.find((n) => n.id === id);
const tokenOf = (networkId: string, symbolOrContract: string) =>
  network(networkId)?.tokens.find(
    (t) => t.symbol === symbolOrContract || t.contract === String(symbolOrContract),
  );

function accountView(a: Wire) {
  return pub({
    ...a,
    networks: a.networks.map((c: Wire) => ({
      ...c,
      matcher: {
        maxPerOrderUnits: c.matcher?.maxPerOrder ?? '0',
        autoSettle: c.matcher?.autoSettle === true,
      },
    })),
  });
}

function checkoutView(o: Wire) {
  tick(o);
  return {
    id: o.id,
    chargeId: o.chargeId,
    status: o.status,
    currency: o.currency,
    fiatAmount: o.fiatAmount,
    rail: o.rail,
    merchantName: o.merchant?.displayName ?? null,
    paymentDeadline: o.paymentDeadline,
    paymentDetails: o.status === 'awaiting_payment' ? o.paymentDetails : null,
    paidAt: o._t?.paid ? iso(o._t.paid) : null,
    createdAt: o.createdAt,
  };
}

/* --- Routes --- */

const routes: [ApiRequest['method'], string, Handler][] = [
  // Sign-in with a Stellar wallet (SEP-10)
  [
    'GET',
    '/v1/auth/challenge',
    ({ req }) => {
      const account = String(req.query?.account ?? '');
      if (!isAccount(account)) return fail(422, 'invalid_account', 'Not a Stellar account.');
      return ok(sep10Challenge(account));
    },
  ],
  [
    'POST',
    '/v1/auth/verify',
    ({ body }) => {
      const account = sep10Verify(String(body.transaction ?? ''));
      if (!account) return fail(401, 'invalid_signature', 'The challenge is not signed.');
      db().session = { address: account };
      save();
      return ok({
        token: 'ps_sess_demo',
        session: { address: account, expiresAt: iso(now() + 12 * 3600_000) },
      });
    },
  ],
  [
    'GET',
    '/v1/auth/session',
    () => (session() ? sessionAnswer() : fail(401, 'unauthenticated', 'Sign in first.')),
  ],
  [
    'POST',
    '/v1/auth/logout',
    () => {
      db().session = null;
      save();
      return none();
    },
  ],

  // Organizations and members
  [
    'GET',
    '/v1/organizations',
    () => (session() ? list(myOrgs()) : fail(401, 'unauthenticated', 'Sign in first.')),
  ],
  [
    'POST',
    '/v1/organizations',
    ({ body }) => {
      const s = session();
      if (!s) return fail(401, 'unauthenticated', 'Sign in first.');
      const name = String(body.name ?? '').trim();
      if (name.length < 2 || name.length > 60)
        return fail(422, 'invalid_name', 'An organization name has 2 to 60 characters.');
      const org = { id: rid('org', 10), name, role: 'owner', createdAt: iso(now()) };
      db().orgs.push(org);
      db().members[org.id] = [
        { address: s.address, role: 'owner', label: null, addedAt: org.createdAt },
      ];
      save();
      return ok(org, 201);
    },
  ],
  ['GET', '/v1/organizations/:org/members', withOrg((_c, org) => list(db().members[org] ?? []))],
  [
    'POST',
    '/v1/organizations/:org/members',
    withOrg(({ body }, org) => {
      const address = String(body.address ?? '');
      if (!isAccount(address)) return fail(422, 'invalid_address', 'Not a Stellar account.');
      const members = (db().members[org] ??= []);
      if (members.some((m) => m.address === address))
        return fail(409, 'already_member', 'Already a member.');
      const m = {
        id: rid('mem', 10),
        address,
        role: body.role ?? 'member',
        label: null,
        createdAt: iso(now()),
      };
      members.push(m);
      save();
      return ok(m, 201);
    }),
  ],
  [
    'PATCH',
    '/v1/organizations/:org/members/:memberId',
    withOrg(({ body, params }, org) => {
      const m = (db().members[org] ?? []).find((x) => x.id === params.memberId);
      if (!m) return fail(404, 'not_found', 'Member not found.');
      if (
        m.role === 'owner' &&
        body.role !== 'owner' &&
        (db().members[org] ?? []).filter((x) => x.role === 'owner').length < 2
      )
        return fail(409, 'last_owner', 'An organization keeps at least one owner.');
      m.role = body.role;
      save();
      return ok(m);
    }),
  ],
  [
    'DELETE',
    '/v1/organizations/:org/members/:memberId',
    withOrg(({ params }, org) => {
      const members = db().members[org] ?? [];
      const m = members.find((x) => x.id === params.memberId);
      if (!m) return fail(404, 'not_found', 'Member not found.');
      if (m.role === 'owner' && members.filter((x) => x.role === 'owner').length < 2)
        return fail(409, 'last_owner', 'An organization keeps at least one owner.');
      db().members[org] = members.filter((x) => x !== m);
      save();
      return none();
    }),
  ],

  // API keys
  [
    'GET',
    '/v1/organizations/:org/api-keys',
    withOrg((_c, org) => list(db().keys.filter((k) => k._org === org))),
  ],
  [
    'POST',
    '/v1/organizations/:org/api-keys',
    withOrg(({ body }, org) => {
      const tier = body.tier === 'live' ? 'live' : 'test';
      const scopes = Array.isArray(body.scopes)
        ? body.scopes.filter((x: unknown) => x === 'p2p:read' || x === 'p2p:write')
        : [];
      if (!String(body.name ?? '').trim() || !scopes.length)
        return fail(422, 'invalid_key', 'A key needs a name and at least one scope.');
      const secret = rid(`pk_${tier}`, 32);
      const k = {
        id: rid('key', 10),
        _org: org,
        name: String(body.name).trim(),
        prefix: secret.slice(0, 12),
        tier,
        scopes,
        createdAt: iso(now()),
        lastUsedAt: null,
        revokedAt: null,
      };
      db().keys.push(k);
      save();
      return ok({ ...pub(k), key: secret }, 201);
    }),
  ],
  [
    'DELETE',
    '/v1/organizations/:org/api-keys/:id',
    withOrg(({ params }, org) => {
      const k = db().keys.find((x) => x.id === params.id && x._org === org);
      if (!k) return fail(404, 'not_found', 'Key not found.');
      k.revokedAt = iso(now());
      save();
      return none();
    }),
  ],

  // Webhooks
  [
    'GET',
    '/v1/webhook-endpoints',
    withOrg((_c, org) => list(db().webhooks.filter((w) => w._org === org))),
  ],
  [
    'POST',
    '/v1/webhook-endpoints',
    withOrg(({ body }, org) => {
      const url = String(body.url ?? '');
      if (!/^https:\/\/[^\s/$.?#].[^\s]*$/i.test(url))
        return fail(422, 'invalid_url', 'Webhook URLs use https.');
      const events = Array.isArray(body.events) ? body.events.map(String) : [];
      if (!events.length) return fail(422, 'invalid_events', 'Pick at least one event.');
      const w = {
        id: rid('wh', 10),
        _org: org,
        url,
        description: body.description || null,
        events,
        active: true,
        createdAt: iso(now()),
      };
      db().webhooks.push(w);
      save();
      return ok({ ...pub(w), tier: 'test', updatedAt: w.createdAt, secret: rid('whsec', 24) }, 201);
    }),
  ],
  [
    'PATCH',
    '/v1/webhook-endpoints/:id',
    withOrg(({ body, params }, org) => {
      const w = db().webhooks.find((x) => x.id === params.id && x._org === org);
      if (!w) return fail(404, 'not_found', 'Endpoint not found.');
      Object.assign(
        w,
        Object.fromEntries(
          Object.entries(body).filter(([k]) =>
            ['url', 'events', 'active', 'description'].includes(k),
          ),
        ),
      );
      save();
      return ok(pub(w));
    }),
  ],
  [
    'DELETE',
    '/v1/webhook-endpoints/:id',
    withOrg(({ params }, org) => {
      const before = db().webhooks.length;
      db().webhooks = db().webhooks.filter((x) => !(x.id === params.id && x._org === org));
      save();
      return before === db().webhooks.length
        ? fail(404, 'not_found', 'Endpoint not found.')
        : none();
    }),
  ],
  [
    'GET',
    '/v1/webhook-endpoints/:id/deliveries',
    withOrg(({ params }) =>
      list(
        db()
          .deliveries.filter((d) => d._endpoint === params.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      ),
    ),
  ],

  // The market
  [
    'GET',
    '/v1/market',
    ({ req }) => ok({ ...MARKET, tier: req.query?.tier === 'test' ? 'test' : 'live' }),
  ],
  ['POST', '/v1/app/quotes', ({ body }) => (body.kind === 'QR_PAY' ? qrQuote(body) : quote(body))],
  [
    'POST',
    '/v1/app/orders',
    ({ body }) => {
      const q = db().quotes[String(body.quoteId)];
      return body.kind === 'QR_PAY' || q?.kind === 'QR_PAY' ? qrOrder(body) : createOrder(body);
    },
  ],
  ...appRoutes,
  [
    'GET',
    '/v1/app/orders',
    () => {
      const s = session();
      if (!s) return fail(401, 'unauthenticated', 'Sign in first.');
      const data = myAppOrders(s.address)
        .map((x) => orderView(x, 'client'))
        .sort(byNewest);
      return ok({ data, skip: 0, take: 50, total: data.length });
    },
  ],
  [
    'GET',
    '/v1/p2p/orders',
    withOrg((_c, org) => {
      const data = db()
        .orders.filter((x) => x._owner === org)
        .map((x) => orderView(x, 'client'))
        .sort(byNewest);
      return ok({ data, skip: 0, take: 100, total: data.length });
    }),
  ],
  [
    'POST',
    '/v1/app/orders/:id/transactions',
    ({ params, body }) => {
      const s = session();
      if (!s) return fail(401, 'unauthenticated', 'Sign in first.');
      const o = myAppOrders(s.address).find((x) => x.id === params.id);
      if (!o) return fail(404, 'not_found', 'Order not found.');
      if ((o.kind !== 'SELL' && o.kind !== 'QR_PAY') || o.sellerAddress !== s.address)
        return fail(409, 'not_seller', "Only a sale's seller signs its actions.");
      const tx = orderCall(tick(o), fnOf(String(body.action)), s.address);
      return tx ? ok(tx) : fail(409, 'invalid_state', 'This order has no on-chain id yet.');
    },
  ],
  [
    'GET',
    '/v1/app/orders/:id',
    ({ params }) => {
      const s = session();
      if (!s) return fail(401, 'unauthenticated', 'Sign in first.');
      const o = myAppOrders(s.address).find((x) => x.id === params.id);
      if (!o) return fail(404, 'not_found', 'Order not found.');
      const v = orderView(o, 'client');
      // A sale's unsigned open_with_deposit, while its seller has not sent it.
      return ok(
        (o.kind === 'SELL' || o.kind === 'QR_PAY') && o.status === 'pending'
          ? { ...v, transactions: [saleOpen(o)] }
          : v,
      );
    },
  ],
  ['POST', '/v1/app/orders/:id/paid', ({ params, body }) => buyerAction(params.id, 'paid', body)],
  [
    'POST',
    '/v1/app/orders/:id/cancel',
    ({ params, body }) => buyerAction(params.id, 'cancel', body),
  ],
  [
    'POST',
    '/v1/app/orders/:id/dispute',
    ({ params, body }) => buyerAction(params.id, 'dispute', body),
  ],
  [
    'POST',
    '/v1/p2p/transactions',
    withOrg(({ body }, org) => {
      const acc = db().accounts.find(
        (a) => a._org === org && (a.id === body.from || a.address === body.from),
      );
      if (!acc) return fail(422, 'unknown_account', 'Act from a registered wallet.');
      const r = buildTransaction(acc.address, String(body.action), (body.args ?? {}) as Wire);
      return r.error ? fail(...r.error) : ok(r.tx);
    }),
  ],
  [
    'POST',
    '/v1/p2p/submit',
    withOrg(({ body }, org) => {
      const sources = db()
        .accounts.filter((a) => a._org === org)
        .map((a) => a.address);
      return ok(submitEnvelope(String(body.xdr ?? ''), sources));
    }),
  ],
  [
    'GET',
    '/v1/p2p/submissions/:hash',
    withOrg(({ params }) => {
      const r = db().chain.submissions[params.hash];
      return r
        ? ok({ hash: params.hash, status: r.status, error: r.error })
        : fail(404, 'not_found', 'Submission not found.');
    }),
  ],

  // The dashboard: accounts, methods, offers, merchant orders
  [
    'POST',
    '/v1/p2p/accounts/challenge',
    withOrg(({ body }, org) => {
      const address = String(body.address ?? '');
      if (!isAccount(address)) return fail(422, 'invalid_address', 'Not a Stellar account.');
      if (db().accounts.some((a) => a.address === address))
        return fail(409, 'address_taken', 'This wallet is already registered.');
      const c = sep10Challenge(address, org);
      return ok({ ...c, networkPassphrase: c.network_passphrase, expiresAt: iso(now() + 5 * 60_000) });
    }),
  ],
  [
    'POST',
    '/v1/p2p/accounts',
    withOrg(({ body }, org) => {
      // The address is the one the signed challenge proves; the body names none.
      const address = sep10Verify(String(body.transaction ?? ''), org);
      if (!address) return fail(401, 'invalid_signature', 'The challenge is not signed by this wallet.');
      if (db().accounts.some((a) => a.address === address))
        return fail(409, 'address_taken', 'This wallet is already registered.');
      const displayName = body.displayName ? String(body.displayName) : null;
      const a = {
        id: rid('acc', 10),
        _org: org,
        address,
        label: body.label || null,
        verifiedAt: iso(now()),
        createdAt: iso(now()),
        ...(displayName
          ? {
              displayName,
              merchantStatus: 'ACTIVE',
              stats: {
                completedOrders: 0,
                cancelledOrders: 0,
                disputesLost: 0,
                medianReleaseSeconds: null,
                lastActiveAt: null,
              },
            }
          : {}),
        networks: [],
      };
      db().accounts.push(a);
      save();
      return ok(accountView(a), 201);
    }),
  ],
  [
    'GET',
    '/v1/p2p/accounts',
    withOrg((_c, org) =>
      ok({
        data: db()
          .accounts.filter((a) => a._org === org)
          .map(accountView),
      }),
    ),
  ],
  [
    'GET',
    '/v1/p2p/accounts/:id',
    withOrg(({ params }, org) => {
      const a = db().accounts.find((x) => x.id === params.id && x._org === org);
      return a ? ok(accountView(a)) : fail(404, 'not_found', 'Account not found.');
    }),
  ],
  [
    'PATCH',
    '/v1/p2p/accounts/:id',
    withOrg(({ params, body }, org) => {
      const a = db().accounts.find((x) => x.id === params.id && x._org === org);
      if (!a) return fail(404, 'not_found', 'Account not found.');
      if ('label' in body) a.label = body.label || null;
      if (body.displayName) a.displayName = body.displayName;
      if (body.merchantStatus && a.merchantStatus !== 'SUSPENDED')
        a.merchantStatus = body.merchantStatus;
      save();
      return ok(accountView(a));
    }),
  ],
  [
    'DELETE',
    '/v1/p2p/accounts/:id',
    withOrg(({ params }, org) => {
      db().accounts = db().accounts.filter((x) => !(x.id === params.id && x._org === org));
      save();
      return none();
    }),
  ],
  [
    'GET',
    '/v1/p2p/payment-methods',
    withOrg((_c, org) => list(db().methods.filter((m) => m._org === org))),
  ],
  [
    'POST',
    '/v1/p2p/payment-methods',
    withOrg(({ body }, org) => {
      if (!isRailId(body.rail)) return fail(422, 'unknown_rail', 'Unknown rail.');
      const m = {
        id: rid('pm', 10),
        _org: org,
        accountId: body.accountId,
        currency: RAILS[body.rail as keyof typeof RAILS].currency,
        rail: body.rail,
        label: body.label || null,
        holderName: body.holderName,
        document: body.document || null,
        details: body.details ?? {},
        active: body.active !== false,
        createdAt: iso(now()),
      };
      db().methods.push(m);
      save();
      return ok(pub(m), 201);
    }),
  ],
  [
    'PATCH',
    '/v1/p2p/payment-methods/:id',
    withOrg(({ params, body }, org) => {
      const m = db().methods.find((x) => x.id === params.id && x._org === org);
      if (!m) return fail(404, 'not_found', 'Payment method not found.');
      Object.assign(
        m,
        Object.fromEntries(
          Object.entries(body).filter(([k]) =>
            ['label', 'holderName', 'document', 'details', 'active'].includes(k),
          ),
        ),
      );
      save();
      return ok(pub(m));
    }),
  ],
  [
    'DELETE',
    '/v1/p2p/payment-methods/:id',
    withOrg(({ params }, org) => {
      db().methods = db().methods.filter((x) => !(x.id === params.id && x._org === org));
      save();
      return none();
    }),
  ],
  ['GET', '/v1/p2p/offers', withOrg((_c, org) => list(db().offers.filter((m) => m._org === org)))],
  [
    'POST',
    '/v1/p2p/offers',
    withOrg(({ body }, org) => {
      const t = tokenOf(String(body.network), String(body.token));
      if (!t) return fail(422, 'unknown_token', 'Unknown token on this network.');
      const o = {
        id: rid('off', 10),
        _org: org,
        accountId: body.accountId,
        side: body.side,
        network: body.network,
        token: t.contract,
        tokenSymbol: t.symbol,
        currency: body.currency,
        rails: body.rails ?? [],
        price: String(body.price),
        priceUpdatedAt: iso(now()),
        priceTtlSeconds: Number(body.priceTtlSeconds ?? 3600),
        minFiat: String(body.minFiat),
        maxFiat: String(body.maxFiat),
        active: body.active !== false,
        createdAt: iso(now()),
      };
      db().offers.push(o);
      save();
      return ok(pub(o), 201);
    }),
  ],
  [
    'PATCH',
    '/v1/p2p/offers/:id',
    withOrg(({ params, body }, org) => {
      const o = db().offers.find((x) => x.id === params.id && x._org === org);
      if (!o) return fail(404, 'not_found', 'Offer not found.');
      for (const k of ['price', 'priceTtlSeconds', 'minFiat', 'maxFiat', 'active', 'rails'])
        if (k in body) o[k] = body[k];
      if ('price' in body) o.priceUpdatedAt = iso(now());
      save();
      return ok(pub(o));
    }),
  ],
  [
    'DELETE',
    '/v1/p2p/offers/:id',
    withOrg(({ params }, org) => {
      db().offers = db().offers.filter((x) => !(x.id === params.id && x._org === org));
      save();
      return none();
    }),
  ],
  [
    'GET',
    '/v1/p2p/merchant/orders',
    withOrg((_c, org) =>
      ok({
        data: db()
          .orders.filter((o) => o._merchantOrg === org)
          .map((o) => orderView(o, 'merchant'))
          .sort(byNewest),
      }),
    ),
  ],
  [
    'GET',
    '/v1/p2p/merchant/orders/:id',
    withOrg(({ params }, org) => {
      const o = db().orders.find((x) => x.id === params.id && x._merchantOrg === org);
      return o ? ok(orderView(o, 'merchant')) : fail(404, 'not_found', 'Order not found.');
    }),
  ],
  [
    'POST',
    '/v1/p2p/merchant/transfer-matches',
    withOrg(({ body }, org) => {
      const amount = Number(body.amount);
      const name = String(body.payerName ?? '').toLowerCase();
      const doc = String(body.payerDocument ?? '').replace(/\D/g, '');
      const data = db()
        .orders.filter(
          (o) =>
            o._merchantOrg === org &&
            (o.kind === 'BUY' || o.kind === 'CHARGE') &&
            ['awaiting_payment', 'paid'].includes(tick(o).status),
        )
        .filter(
          (o) => o.currency === body.currency && Math.abs(Number(o.fiatAmount) - amount) < 0.005,
        )
        .map((o) => {
          const matchedOn = ['amount'];
          if (
            name &&
            String(o.payer?.name ?? '')
              .toLowerCase()
              .includes(name)
          )
            matchedOn.push('name');
          if (doc && String(o.payer?.document ?? '').replace(/\D/g, '') === doc)
            matchedOn.push('document');
          return {
            order: orderView(o, 'merchant'),
            score: matchedOn.length,
            matchedOn,
            transaction: orderCall(o, 'release', o.sellerAddress),
          };
        })
        .sort((a, b) => b.score - a.score);
      return ok({ data });
    }),
  ],

  // Charges and payouts
  [
    'GET',
    '/v1/p2p/charges',
    withOrg((_c, org) =>
      ok({
        data: db()
          .charges.filter((c) => c._org === org)
          .map(chargeView)
          .sort(byNewest),
      }),
    ),
  ],
  [
    'POST',
    '/v1/p2p/charges',
    withOrg(({ body }, org) => {
      const t = tokenOf(String(body.network), String(body.token));
      if (!t) return fail(422, 'unknown_token', 'Unknown token on this network.');
      const recipient = db().accounts.find(
        (a) =>
          a._org === org &&
          (a.id === body.recipient || a.address === String(body.recipient)),
      );
      if (!recipient)
        return fail(
          422,
          'unknown_recipient',
          'The recipient must be a registered wallet of this organization.',
        );
      const c = {
        id: rid('ch', 12),
        _org: org,
        currency: body.currency,
        fiatAmount: Number(body.fiatAmount).toFixed(body.currency === 'CLP' ? 0 : 2),
        network: body.network,
        token: t.contract,
        tokenSymbol: t.symbol,
        recipientAddress: recipient.address,
        description: body.description || null,
        status: 'open',
        multiUse: body.multiUse === true,
        expiresAt: body.expiresAt ?? null,
        payeeName: body.payeeName || db().orgs.find((o) => o.id === org)?.name || null,
        paidAt: null,
        orders: 0,
        createdAt: iso(now()),
      };
      db().charges.push(c);
      save();
      return ok(chargeView(c), 201);
    }),
  ],
  [
    'DELETE',
    '/v1/p2p/charges/:id',
    withOrg(({ params }, org) => {
      const c = db().charges.find((x) => x.id === params.id && x._org === org);
      if (!c) return fail(404, 'not_found', 'Charge not found.');
      c.status = 'cancelled';
      save();
      return ok(chargeView(c));
    }),
  ],
  [
    'GET',
    '/v1/p2p/payouts',
    withOrg((_c, org) =>
      ok({
        data: db()
          .payouts.filter((p) => p._org === org)
          .map(payoutView)
          .sort(byNewest),
      }),
    ),
  ],
  [
    'GET',
    '/v1/p2p/payouts/:id',
    withOrg(({ params }, org) => {
      const p = db().payouts.find((x) => x.id === params.id && x._org === org);
      return p ? ok(payoutView(p)) : fail(404, 'not_found', 'Payout batch not found.');
    }),
  ],
  ['POST', '/v1/p2p/payouts', withOrg(({ body }, org) => createPayouts(body, org))],

  // The hosted charge page (keyless)
  [
    'GET',
    '/v1/p2p-checkout/charges/:id',
    ({ params }) => {
      const c = db().charges.find((x) => x.id === params.id);
      if (!c) return fail(404, 'not_found', 'Charge not found.');
      if (c.status === 'open' && c.expiresAt && Date.parse(c.expiresAt) < now())
        c.status = 'expired';
      const cur = CURRENCIES.find((x) => x.code === c.currency);
      return ok({
        id: c.id,
        network: c.network,
        tokenSymbol: c.tokenSymbol,
        currency: c.currency,
        fiatAmount: c.fiatAmount,
        description: c.description,
        merchantName: c.payeeName,
        status: c.status,
        // The checkout pays a merchant's account: never a QR rail.
        rails: cur?.rails.filter((r) => r.fields.length).map((r) => r.id) ?? [],
        expiresAt: c.expiresAt,
      });
    },
  ],
  [
    'POST',
    '/v1/p2p-checkout/charges/:id/orders',
    ({ params, body }) => {
      const c = db().charges.find((x) => x.id === params.id);
      if (!c) return fail(404, 'not_found', 'Charge not found.');
      if (c.status !== 'open') return fail(409, 'charge_closed', 'This charge is not open.');
      if (
        !c.multiUse &&
        db().orders.some(
          (o) =>
            o.chargeId === c.id && ['pending', 'awaiting_payment', 'paid'].includes(tick(o).status),
        )
      )
        return fail(409, 'charge_busy', 'Someone is paying this charge now.');
      const payer = body.payer ?? {};
      if (
        !String(payer.name ?? '').trim() ||
        !String(payer.document ?? '').trim() ||
        !String(payer.email ?? '').includes('@')
      )
        return fail(422, 'invalid_payer', 'Name, document and email are required.');
      const price = PRICES[c.currency]?.buy ?? 1;
      const o = makeOrder({
        kind: 'CHARGE',
        status: 'pending',
        owner: c._org,
        merchantOrg: 'org_other',
        fiat: Number(c.fiatAmount),
        currency: c.currency,
        rail: body.rail,
        price,
        buyer: c.recipientAddress,
        seller: MERCHANT_SELLER,
      });
      o.chargeId = c.id;
      o.payer = { name: String(payer.name).trim(), document: String(payer.document).trim() };
      o.paymentDetails = { rail: body.rail, ...MERCHANT_ACCOUNTS[body.rail] };
      db().orders.push(o);
      const payerToken = rid('pt', 40).replace('_', '');
      db().payerTokens[o.id] = payerToken;
      save();
      return ok({ ...checkoutView(o), payerToken }, 201);
    },
  ],
  ['GET', '/v1/p2p-checkout/orders/:id', (ctx) => payerOrder(ctx, (o) => ok(checkoutView(o)))],
  [
    'POST',
    '/v1/p2p-checkout/orders/:id/paid',
    (ctx) =>
      payerOrder(ctx, (o) => {
        if (tick(o).status !== 'awaiting_payment')
          return fail(409, 'invalid_state', 'This order is not waiting for a payment.');
        o.status = 'paid';
        o._t = { ...o._t, paid: now() };
        o.paidReference = ctx.body.reference ?? null;
        save();
        return ok(checkoutView(o));
      }),
  ],
  [
    'POST',
    '/v1/p2p-checkout/orders/:id/cancel',
    (ctx) =>
      payerOrder(ctx, (o) => {
        if (!['pending', 'awaiting_payment'].includes(tick(o).status))
          return fail(409, 'invalid_state', 'This order can no longer be cancelled.');
        o.status = 'cancelled';
        save();
        return ok(checkoutView(o));
      }),
  ],
];

/* --- Handlers with more to them --- */


function myOrgs() {
  const s = session();
  if (!s) return [];
  return db().orgs.flatMap((o): Wire[] => {
    const m = (db().members[o.id] ?? []).find((x) => x.address === s.address);
    return m ? [{ ...o, role: m.role }] : [];
  });
}

function sessionAnswer() {
  const s = session()!;
  return ok({
    address: s.address,
    expiresAt: iso(now() + 12 * 3600_000),
    organizations: myOrgs().map((o) => ({ id: o.id, name: o.name, role: o.role })),
  });
}

function quote(body: Wire): ApiResponse {
  if (!session()) return fail(401, 'unauthenticated', 'Sign in first.');
  const n = network(String(body.network));
  const t = n && tokenOf(n.id, String(body.token));
  const prices = PRICES[String(body.currency)];
  if (!n || !t || !prices)
    return fail(422, 'unsupported', 'This network, token or currency is not offered.');
  const buy = body.side === 'BUY';
  const price = buy ? prices.buy : prices.sell;
  const dec = body.currency === 'CLP' ? 0 : 2;
  let fiat: number;
  let tokenUnits: bigint;
  if (buy) {
    fiat = Number(body.fiatAmount);
    tokenUnits = BigInt(Math.floor((fiat / price) * 1e7));
  } else {
    tokenUnits = BigInt(String(body.tokenAmount ?? '0'));
    fiat = Math.floor((Number(tokenUnits) / 1e7) * price * 10 ** dec) / 10 ** dec;
  }
  const usd = Number(tokenUnits) / 1e7;
  if (!(usd >= 5 && usd <= 5000))
    return fail(422, 'no_match', 'No merchant takes this amount right now.');
  const fee = (tokenUnits * BigInt(RULES.protocolFeeBps)) / 10000n;
  const merchant = usd > 1500 ? MERCHANTS[1] : MERCHANTS[0];
  const q = {
    id: rid('qt', 12),
    side: buy ? 'BUY' : 'SELL',
    network: n.id,
    token: t.contract,
    tokenSymbol: t.symbol,
    tokenDecimals: t.decimals,
    currency: body.currency,
    rail: body.rail,
    price: String(price),
    fiatAmount: fiat.toFixed(dec),
    tokenAmount: tokenUnits.toString(),
    protocolFee: fee.toString(),
    integratorFee: '0',
    netAmount: (tokenUnits - fee).toString(),
    merchant,
    merchantAddress: buy ? null : MERCHANT_SELLER,
    bond: buy ? '0' : ((tokenUnits * BigInt(RULES.bondBps)) / 10000n).toString(),
    protocolFeeBps: RULES.protocolFeeBps,
    integratorFeeBps: 0,
    windows: buy
      ? { acceptWindow: 0, paymentWindow: RULES.buyPaymentSeconds, settleWindow: 0 }
      : {
          acceptWindow: RULES.sellAcceptSeconds,
          paymentWindow: RULES.sellPaymentSeconds,
          settleWindow: RULES.sellSettleSeconds,
        },
    expiresAt: iso(now() + 60_000),
  };
  db().quotes[q.id] = q;
  save();
  return ok(q, 201);
}

function createOrder(body: Wire): ApiResponse {
  const s = session();
  if (!s) return fail(401, 'unauthenticated', 'Sign in first.');
  const q = db().quotes[String(body.quoteId)];
  if (!q || Date.parse(q.expiresAt) < now())
    return fail(409, 'quote_expired', 'Ask for a new quote.');
  delete db().quotes[q.id];
  const buy = q.side === 'BUY';
  if (buy && (!String(body.payer?.name ?? '').trim() || !String(body.payer?.document ?? '').trim()))
    return fail(422, 'invalid_payer', 'Who pays is required.');
  if (!buy) {
    const have = BigInt(chainAccount(s.address)?.trust.USDC ?? '0');
    if (have < BigInt(q.tokenAmount))
      return fail(422, 'insufficient_balance', 'Not enough USDC in this wallet.');
    const b = body.beneficiary ?? {};
    const errors = checkBeneficiary(q.rail, {
      holderName: String(b.holderName ?? ''),
      document: String(b.document ?? ''),
      details: b.details ?? {},
    });
    if (Object.keys(errors).length)
      return fail(422, 'invalid_beneficiary', `Check: ${Object.keys(errors).join(', ')}.`);
  }
  const o = makeOrder({
    kind: buy ? 'BUY' : 'SELL',
    status: 'pending',
    owner: 'app',
    merchantOrg: 'org_other',
    network: q.network,
    symbol: q.tokenSymbol,
    fiat: Number(q.fiatAmount),
    currency: q.currency,
    rail: q.rail,
    price: Number(q.price),
    buyer: buy ? s.address : MERCHANT_SELLER,
    seller: buy ? MERCHANT_SELLER : s.address,
    merchant: q.merchant,
  });
  o.tokenAmount = q.tokenAmount;
  if (!buy) o.bond = (BigInt(q.tokenAmount) / 10n).toString();
  if (buy) {
    o.payer = {
      name: String(body.payer.name).trim(),
      document: String(body.payer.document).trim(),
    };
    o.paymentDetails = { rail: q.rail, ...MERCHANT_ACCOUNTS[q.rail] };
  } else {
    o.beneficiary = { rail: q.rail, ...body.beneficiary };
  }
  db().orders.push(o);
  save();
  const v = orderView(o, 'client');
  return ok(buy ? v : { ...v, transactions: [saleOpen(o)] }, 201);
}

function buyerAction(id: string, action: 'paid' | 'cancel' | 'dispute', body: Wire): ApiResponse {
  const s = session();
  if (!s) return fail(401, 'unauthenticated', 'Sign in first.');
  const o = myAppOrders(s.address).find((x) => x.id === id);
  if (!o) return fail(404, 'not_found', 'Order not found.');
  tick(o);
  const buyLike = o.kind === 'BUY' || o.kind === 'CHARGE';
  if (!buyLike)
    return fail(409, 'sign_in_wallet', "A sale's actions are its seller's own transactions.");
  const t = now();
  if (action === 'paid') {
    if (o.status !== 'awaiting_payment')
      return fail(409, 'invalid_state', 'This order is not waiting for a payment.');
    o.status = 'paid';
    o._t = { ...o._t, paid: t };
    o.paidReference = body.reference ? String(body.reference).slice(0, 60) : null;
  } else if (action === 'cancel') {
    if (!['pending', 'awaiting_payment'].includes(o.status))
      return fail(409, 'invalid_state', 'This order can no longer be cancelled.');
    o.status = 'cancelled';
  } else {
    if (o.status !== 'paid')
      return fail(409, 'invalid_state', 'Only a paid order can be disputed.');
    o.status = 'disputed';
    o._auto = false;
  }
  o.updatedAt = iso(t);
  save();
  return ok(orderView(o, 'client'));
}

function chargeView(c: Wire) {
  if (c.status === 'open' && c.expiresAt && Date.parse(c.expiresAt) < now()) c.status = 'expired';
  return { ...pub(c), url: `${location.origin}/pay/${c.id}` };
}

function payoutView(p: Wire) {
  const orders = (p._orderIds as string[])
    .map((id) => db().orders.find((o) => o.id === id))
    .filter(Boolean)
    .map((o) => tick(o!));
  const done = orders.filter((o) => o.status === 'completed').length;
  const over = orders.filter((o) =>
    ['completed', 'cancelled', 'expired', 'resolved', 'failed'].includes(o.status),
  ).length;
  const status =
    over < orders.length
      ? 'processing'
      : done === orders.length && !p.failedItems?.length
        ? 'completed'
        : done > 0
          ? 'partially_completed'
          : 'failed';
  return {
    ...pub(p),
    status,
    itemCount: orders.length + (p.failedItems?.length ?? 0),
    orders: orders.map((o, i) => ({ ...orderView(o, 'client'), index: i })),
  };
}

function createPayouts(body: Wire, org: string): ApiResponse {
  const account = db().accounts.find((a) => a.id === body.accountId && a._org === org);
  if (!account)
    return fail(422, 'unknown_account', 'Pay from a registered wallet of this organization.');
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 100)
    return fail(422, 'invalid_items', `Send 1 to ${100} payouts.`);
  const t = tokenOf(String(body.network), String(body.token));
  if (!t) return fail(422, 'unknown_token', 'Unknown token on this network.');
  const id = rid('pob', 10);
  const orderIds: string[] = [];
  const failedItems: Wire[] = [];
  items.forEach((it: Wire, index: number) => {
    const price = PRICES[it.currency]?.sell;
    if (!price || Number(it.fiatAmount) / price > 2000) {
      failedItems.push({
        index,
        currency: it.currency,
        fiatAmount: it.fiatAmount,
        rail: it.rail,
        holderName: it.beneficiary?.holderName,
        externalReference: it.externalReference ?? null,
        reason: 'No merchant takes this amount right now.',
      });
      return;
    }
    const o = makeOrder({
      kind: 'PAYOUT',
      status: 'awaiting_acceptance',
      owner: org,
      merchantOrg: 'org_other',
      network: body.network,
      symbol: t.symbol,
      fiat: Number(it.fiatAmount),
      currency: it.currency,
      rail: it.rail,
      price,
      buyer: MERCHANT_SELLER,
      seller: account.address,
    });
    o.onchainId = String(db().nextOnchainId++);
    o.acceptDeadline = iso(now() + RULES.sellAcceptSeconds * 1000);
    o._t = { opened: now() };
    o.beneficiary = { rail: it.rail, ...it.beneficiary };
    o.payoutBatchId = id;
    o.externalReference = it.externalReference ?? null;
    db().orders.push(o);
    orderIds.push(o.id);
  });
  const batch = {
    id,
    _org: org,
    network: body.network,
    token: t.contract,
    tokenSymbol: t.symbol,
    accountId: account.id,
    _orderIds: orderIds,
    failedItems,
    createdAt: iso(now()),
  };
  db().payouts.push(batch);
  save();
  return ok(payoutView(batch), 201);
}

function payerOrder(ctx: Ctx, fn: (o: Wire) => ApiResponse): ApiResponse {
  const o = db().orders.find((x) => x.id === ctx.params.id && x.kind === 'CHARGE');
  const token = ctx.header(PAYER_TOKEN_HEADER);
  if (!o || !token || db().payerTokens[o.id] !== token)
    return fail(404, 'not_found', 'Order not found.');
  return fn(o);
}

/* --- The transport --- */

const compiled = routes.map(([method, pattern, handler]) => {
  const keys: string[] = [];
  const re = new RegExp(
    `^${pattern.replace(/:(\w+)/g, (_m, k: string) => (keys.push(k), '([^/]+)'))}$`,
  );
  return { method, re, keys, handler };
});

export async function mockTransport(req: ApiRequest): Promise<ApiResponse> {
  // A short, uneven delay: screens must show their loading states.
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 260));
  for (const r of compiled) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(req.path);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const headers = Object.fromEntries(
      Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const res = await r.handler({
      req,
      params,
      body: (req.body ?? {}) as Wire,
      header: (n) => headers[n.toLowerCase()],
    });
    save();
    return JSON.parse(JSON.stringify(res)) as ApiResponse;
  }
  return fail(404, 'not_found', `No mock route for ${req.method} ${req.path}.`);
}

export { units };
