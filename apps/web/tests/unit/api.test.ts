/* api.test.ts: the client's error shape and list readers (src/lib/api/client.ts), the account-side
   readers (types.ts), a request through a fake transport with the scope headers
   (endpoints.ts), SEP-10 sign-in's requests, and the payments app's readers (app.ts). */
import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  ApiError,
  errorFrom,
  fetchTransport,
  itemOf,
  listOf,
  request,
  setTransport,
  setUnauthorizedHandler,
  type ApiRequest,
} from '@/lib/api/client';
import { apiKeys, auth, checkout, market, trade, webhooks } from '@/lib/api/endpoints';
import { ORG_HEADER, PAYER_TOKEN_HEADER, TIER_HEADER } from '@/lib/api/routes';
import {
  keyTier,
  normalizeApiKey,
  normalizeCreatedApiKey,
  normalizeCreatedWebhook,
  normalizeDelivery,
  normalizeMember,
  normalizeSession,
} from '@/lib/api/types';
import {
  app,
  readActivity,
  readBalances,
  readChargePayment,
  readPayerCharge,
  readProfile,
  readTransfer,
} from '@/lib/api/app';
import { readSubmit } from '@/lib/api/endpoints';

const G = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const G2 = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const C = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

afterEach(() => {
  setTransport(fetchTransport);
  market.clear();
});

test('the error shape, flat or nested, with its retry hint', () => {
  const e = errorFrom(422, {
    error: { code: 'no_match', message: 'No merchant', details: { field: 'x' } },
  });
  assert.deepEqual(
    [e.status, e.code, e.message, e.details],
    [422, 'no_match', 'No merchant', { field: 'x' }],
  );
  assert.equal(errorFrom(400, { code: 'bad', message: 'Bad' }).code, 'bad');
  assert.equal(errorFrom(500, null).code, 'http_500');
  assert.equal(errorFrom(429, {}, { 'retry-after': '30' }).retryAfter, 30);
  assert.deepEqual(listOf({ data: [1, 2] }), [1, 2]);
  assert.deepEqual(listOf([3]), [3]);
  assert.deepEqual(listOf({ nope: 1 }), []);
  assert.deepEqual(itemOf({ data: { id: 'x' } }), { id: 'x' });
  assert.deepEqual(itemOf({ id: 'x', data: {} }), { id: 'x', data: {} });
});

test('a call carries the organization and tier, and a failure becomes an ApiError', async () => {
  const seen: ApiRequest[] = [];
  setTransport(async (req) => {
    seen.push(req);
    if (req.path === '/v1/organizations/org_1/api-keys' && req.method === 'GET')
      return {
        status: 200,
        json: { data: [{ id: 'k', name: 'Bot', prefix: 'pk_live_ab12', scopes: ['p2p:read'] }] },
      };
    if (req.path === '/v1/webhook-endpoints') return { status: 200, json: { data: [] } };
    return { status: 401, json: { error: { code: 'unauthenticated', message: 'Sign in' } } };
  });
  const keys = await apiKeys.list('org_1');
  assert.equal(keys[0].tier, 'live', 'the prefix decides the tier');
  await webhooks.list({ org: 'org_1', tier: 'test' });
  assert.equal(seen[1].headers?.[ORG_HEADER], 'org_1');
  assert.equal(seen[1].headers?.[TIER_HEADER], 'test');
  assert.equal(ORG_HEADER, 'Pier-Organization');
  assert.equal(TIER_HEADER, 'Pier-Tier');
  assert.equal(await auth.session(), null, 'a 401 on the session means nobody is signed in');
  await assert.rejects(
    () => market.get(),
    (e: unknown) => e instanceof ApiError && e.status === 401,
  );
  setTransport(async () => {
    throw new TypeError('offline');
  });
  await assert.rejects(
    () => market.get(),
    (e: unknown) => e instanceof ApiError && e.status === 0,
  );
});

test('the charge page sends its payer token as a header and refuses a malformed answer', async () => {
  const seen: ApiRequest[] = [];
  setTransport(async (req) => {
    seen.push(req);
    return {
      status: 200,
      json: {
        id: 'ord_12345678',
        chargeId: 'ch_12345678',
        status: 'nope',
        currency: 'ARS',
        fiatAmount: '1.00',
        rail: 'ar_bank_transfer',
      },
    };
  });
  await assert.rejects(
    () => checkout.order('ord_12345678', 'tok'),
    (e: unknown) => e instanceof ApiError && e.code === 'bad_response',
  );
  assert.equal(seen[0].headers?.[PAYER_TOKEN_HEADER], 'tok');
  assert.equal(seen[0].path, '/v1/p2p-checkout/orders/ord_12345678');
});

test('sessions, members, keys, webhooks and deliveries are read tolerantly', () => {
  assert.equal(normalizeSession({ address: 'nope' }), null);
  assert.equal(
    normalizeSession({ address: '0xde3000000000000000000000000000000000a11e' }),
    null,
    'an EVM address is no Stellar account',
  );
  assert.equal(normalizeSession({ address: C }), null, 'a contract is no session');
  const s = normalizeSession({
    session: {
      address: G,
      expiresAt: '2026-11-20T00:00:00Z',
    },
    organizations: [
      { id: 'o', name: 'Norte', role: 'admin' },
      { id: 'p', name: 'X', role: 'root' },
    ],
  });
  assert.deepEqual(
    s?.organizations.map((o) => o.role),
    ['admin', 'member'],
    'an unknown role reads as the least',
  );
  assert.equal(normalizeMember({ address: '0x1', role: 'owner', createdAt: 'x' }).addedAt, 'x');
  assert.equal(keyTier({ tier: 'mainnet' }), 'live');
  assert.equal(keyTier({ prefix: 'pk_test_1' }), 'test');
  assert.equal(normalizeApiKey({ id: 'k' }).revokedAt, null);
  assert.equal(
    normalizeCreatedApiKey({ id: 'k', name: 'n', key: 'pk_live_abcdefgh12345678', scopes: [] })
      ?.prefix,
    'pk_live_abcd',
  );
  assert.equal(
    normalizeCreatedApiKey({ id: 'k', key: 'sk_live_x' }),
    null,
    'only a Pier key is shown',
  );
  assert.equal(
    normalizeCreatedApiKey({ apiKey: { id: 'k', name: 'n' }, key: 'pk_test_abcdefgh12345678' })
      ?.key,
    'pk_test_abcdefgh12345678',
  );
  assert.equal(
    normalizeCreatedWebhook({ id: 'w', url: 'https://x' }),
    null,
    'no secret, nothing to show once',
  );
  assert.equal(
    normalizeCreatedWebhook({ id: 'w', url: 'https://x', secret: 'whsec_1', events: ['A'] })
      ?.events[0],
    'A',
  );
  assert.equal(normalizeDelivery({ status: 'succeeded' }).status, 'delivered');
});

test('the market is read once per tier and reused; a failure is not kept', async () => {
  let calls = 0;
  setTransport(async (req) => {
    calls += 1;
    if (calls === 1) return { status: 503, json: { error: { code: 'unavailable', message: 'x' } } };
    return {
      status: 200,
      json: {
        available: true,
        tier: req.query?.tier,
        networks: [],
        currencies: [],
        bondBps: 1000,
        windows: {
          buyPaymentWindow: 1800,
          sellAcceptWindow: 300,
          sellPaymentWindow: 2400,
          sellSettleWindow: 21600,
        },
      },
    };
  });
  await assert.rejects(() => market.get('test'));
  const m = await market.get('test');
  assert.equal(await market.get('test'), m);
  assert.equal(calls, 2);
  assert.deepEqual(
    [m.sellBondBps, m.windows.sellPaymentSeconds, m.windows.paymentSeconds, m.available],
    [1000, 2400, 1800, true],
  );
});

test("the app's order body carries only the quote and who pays or is paid", async () => {
  const seen: ApiRequest[] = [];
  setTransport(async (req) => {
    seen.push(req);
    return {
      status: 201,
      json: { id: '0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e', kind: 'BUY', status: 'pending' },
    };
  });
  await trade.createOrder({ side: 'BUY', quoteId: 'q1', payer: { name: 'Ana', document: '1' } });
  await trade.createOrder({
    side: 'SELL',
    quoteId: 'q2',
    beneficiary: { holderName: 'Ana', document: '1', details: {} },
  });
  assert.deepEqual(
    seen.map((r) => [r.path, r.body]),
    [
      ['/v1/app/orders', { quoteId: 'q1', payer: { name: 'Ana', document: '1' } }],
      [
        '/v1/app/orders',
        { quoteId: 'q2', beneficiary: { holderName: 'Ana', document: '1', details: {} } },
      ],
    ],
  );
  setTransport(async (req) => {
    seen.push(req);
    return {
      status: 200,
      json: {
        network: 'testnet',
        action: 'release',
        description: 'Release',
        xdr: 'AAAAAgAAAAA=',
        hash: 'ab'.repeat(32),
        expiresAt: '2026-11-19T12:05:00Z',
      },
    };
  });
  const t = await trade.transaction('o1', 'release');
  assert.deepEqual(
    [seen.at(-1)?.path, seen.at(-1)?.body, t.action, t.xdr],
    ['/v1/app/orders/o1/transactions', { action: 'release' }, 'release', 'AAAAAgAAAAA='],
  );
  await trade.transaction('o1', 'mark_paid');
  assert.deepEqual(seen.at(-1)?.body, { action: 'markPaid' }, "the API's own action name");
  setTransport(async () => ({ status: 200, json: { to: '0x1', data: '0x' } }));
  await assert.rejects(trade.transaction('o1', 'release'), ApiError, 'an EVM answer is unreadable');
});

test('SEP-10 sign-in: the challenge for the account, then the signed transaction', async () => {
  const seen: ApiRequest[] = [];
  setTransport(async (req) => {
    seen.push(req);
    if (req.path === '/v1/auth/challenge')
      return {
        status: 200,
        json: { transaction: 'AAAA', network_passphrase: 'Test SDF Network ; September 2015' },
      };
    if (req.path === '/v1/auth/verify')
      return { status: 200, json: { token: 'ps_sess_x', session: { address: G } } };
    return { status: 200, json: { address: G, organizations: [] } };
  });
  assert.deepEqual(await auth.challenge(G), {
    transaction: 'AAAA',
    networkPassphrase: 'Test SDF Network ; September 2015',
  });
  assert.deepEqual(seen[0].query, { account: G });
  const s = await auth.verify('SIGNED');
  assert.equal(s.address, G);
  assert.deepEqual(seen[1].body, { transaction: 'SIGNED' }, 'only the signed challenge is sent');
  assert.equal(seen[2].path, '/v1/auth/session', 'the session is then read from the API');
  setTransport(async () => ({ status: 200, json: { transaction: 1 } }));
  await assert.rejects(auth.challenge(G), ApiError);
});

test("the app's readers: profile, balances, transfers, activity, charges, submissions", () => {
  assert.deepEqual(readProfile({ address: G, handle: '@Lucia' }), { address: G, handle: 'lucia' });
  assert.deepEqual(readProfile({ address: G, handle: 'no way' }), { address: G, handle: null });
  assert.equal(readProfile({ address: 'nope' }), null);
  const b = readBalances({
    network: 'testnet',
    account: { exists: true },
    xlm: '0',
    tokens: [{ symbol: 'USDC', contract: C, amount: '125000000', trustline: true, authorized: true }],
  });
  assert.deepEqual(b?.tokens[0], {
    symbol: 'USDC',
    contract: C,
    amount: '125000000',
    trustline: true,
    authorized: true,
  });
  assert.equal(
    readBalances({ tokens: [{ symbol: 'USDC', amount: '-1', trustline: false }] })?.tokens[0].amount,
    '0',
    'a malformed amount reads as nothing',
  );
  assert.equal(
    readBalances({ tokens: [{ symbol: 'USDC', amount: '1', trustline: false, authorized: true }] })
      ?.tokens[0].authorized,
    false,
    'no trustline, not authorized',
  );
  const tr = readTransfer({
    id: 't1',
    network: 'testnet',
    token: 'USDC',
    amount: '10',
    from: G,
    to: G2,
    toHandle: 'lucia',
    direction: 'out',
    status: 'COMPLETED',
    createdAt: '2026-11-19T12:00:00Z',
  });
  assert.deepEqual([tr?.direction, tr?.status, tr?.fromHandle, tr?.note], ['out', 'COMPLETED', null, null]);
  assert.equal(readTransfer({ id: 't', status: 'WEIRD' })?.status, 'PENDING');
  const page = readActivity({
    items: [
      { type: 'transfer', at: '2026-11-19T12:00:00Z', transfer: { id: 't1', direction: 'in' } },
      { type: 'order', at: '2026-11-19T11:00:00Z', order: { id: 'o1', kind: 'QR_PAY' } },
      { type: 'other' },
    ],
    nextCursor: 'c2',
  });
  assert.deepEqual(
    [page.items.length, page.items[1].type === 'order' && page.items[1].order.kind, page.nextCursor],
    [2, 'QR_PAY', 'c2'],
  );
  assert.equal(
    readPayerCharge({ id: 'ch', status: 'open', payWithBalance: { token: 'USDC', amount: '0' } })
      ?.payWithBalance,
    null,
    'nothing to pay is no price',
  );
  assert.equal(
    readPayerCharge({
      id: 'ch',
      payWithBalance: { token: 'USDC', amount: '5', expiresAt: '2026-11-19T12:01:00Z', recipient: G2 },
    })?.payWithBalance?.recipient,
    G2,
  );
  assert.equal(readChargePayment({ amount: '5' }), null, 'no id');
  assert.equal(readChargePayment({ id: 'p', amount: '5', hash: 'ab' })?.amount, '5');
  assert.equal(
    readPayerCharge({
      id: 'ch',
      payWithBalance: { token: 'USDC', amount: '5', expiresAt: '2026-11-19T12:01:00Z', recipient: '0xabc' },
    })?.payWithBalance,
    null,
    'a price with no Stellar recipient is no price',
  );
  assert.deepEqual(readSubmit({ hash: 'h', status: 'SUCCESS' }), { hash: 'h', status: 'SUCCESS', error: null });
  assert.equal(readSubmit({ hash: 'h', status: '??' })?.status, 'PENDING');
  assert.equal(readSubmit({ status: 'SUCCESS' }), null);
});

test('app calls: handles resolve or are null, transfers carry base units and the note', async () => {
  const seen: ApiRequest[] = [];
  setTransport(async (req) => {
    seen.push(req);
    if (req.path === '/v1/app/handles/lucia') return { status: 200, json: { handle: 'lucia', address: G2 } };
    if (req.path.startsWith('/v1/app/handles/'))
      return { status: 404, json: { error: { code: 'not_found', message: 'x' } } };
    if (req.path === '/v1/app/transfers')
      return {
        status: 201,
        json: {
          transfer: { id: 't1', to: G2, amount: '125000000', status: 'PENDING' },
          transaction: { network: 'testnet', xdr: 'AAAA', hash: 'ab'.repeat(32), action: 'payment' },
        },
      };
    if (req.path === '/v1/app/activate') return { status: 200, json: { transaction: null } };
    return { status: 200, json: {} };
  });
  assert.deepEqual(await app.resolveHandle('@Lucia'), { handle: 'lucia', address: G2 });
  assert.equal(await app.resolveHandle('@nobody'), null);
  assert.equal(await app.resolveHandle('no way'), null, 'not a handle: not even asked');
  const r = await app.transfer({ network: 'testnet', to: '@lucia', token: 'USDC', amount: '125000000', note: 'Café' });
  assert.equal(r.transaction.xdr, 'AAAA');
  assert.deepEqual(seen.at(-1)?.body, {
    network: 'testnet',
    to: '@lucia',
    token: 'USDC',
    amount: '125000000',
    note: 'Café',
  });
  assert.equal(await app.activate('testnet', 'USDC'), null, 'nothing to activate');
});

test('a write asked again while the first is in flight goes out once; reads and later writes do not', async () => {
  const seen: string[] = [];
  // The writes wait until let go, in the order they went out.
  const waiting: (() => void)[] = [];
  const open = () => waiting.splice(0).forEach((r) => r());
  setTransport(async (req) => {
    seen.push(`${req.method} ${req.path} ${JSON.stringify(req.body ?? null)}`);
    if (req.method === 'POST') await new Promise<void>((r) => waiting.push(r));
    return { status: 200, json: { ok: seen.length } };
  });
  const body = { action: 'release' };
  // A double tap: two identical writes at once share one request and one answer.
  const a = request({ method: 'POST', path: '/v1/app/orders/o1/transactions', body });
  const b = request({ method: 'POST', path: '/v1/app/orders/o1/transactions', body });
  assert.equal(a, b, 'the same promise');
  // Another write (another body) is its own request.
  const c = request({
    method: 'POST',
    path: '/v1/app/orders/o1/transactions',
    body: { action: 'dispute' },
  });
  // Reads are never shared.
  await Promise.all([
    request({ method: 'GET', path: '/v1/app/orders/o1' }),
    request({ method: 'GET', path: '/v1/app/orders/o1' }),
  ]);
  await new Promise((r) => setTimeout(r, 0));
  open();
  await Promise.all([a, b, c]);
  assert.equal(seen.filter((x) => x.includes('release')).length, 1);
  assert.equal(seen.filter((x) => x.includes('dispute')).length, 1);
  assert.equal(seen.filter((x) => x.startsWith('GET')).length, 2);
  // Once answered, the same write may go out again (a deliberate retry).
  const d = request({ method: 'POST', path: '/v1/app/orders/o1/transactions', body });
  await new Promise((r) => setTimeout(r, 0));
  open();
  await d;
  assert.equal(seen.filter((x) => x.includes('release')).length, 2);
});

test("a 401 from any screen's call tells the session; sign-in's own routes do not", async () => {
  let told = 0;
  setUnauthorizedHandler(() => told++);
  setTransport(async () => ({ status: 401, json: { error: { code: 'unauthenticated' } } }));
  try {
    await assert.rejects(() => request({ method: 'GET', path: '/v1/app/activity' }));
    assert.equal(told, 1);
    await assert.rejects(() => request({ method: 'GET', path: '/v1/auth/session' }));
    await assert.rejects(() => request({ method: 'POST', path: '/v1/auth/verify', body: {} }));
    assert.equal(told, 1, 'sign-in answers its own 401s');
    setTransport(async () => ({ status: 403, json: {} }));
    await assert.rejects(() => request({ method: 'GET', path: '/v1/app/activity' }));
    assert.equal(told, 1, 'only a 401');
  } finally {
    setUnauthorizedHandler(null);
  }
});
