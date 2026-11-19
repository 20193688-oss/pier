/* api.test.ts: the client's error shape and list readers (src/lib/api/client.ts), the account-side
   readers (types.ts), a request through a fake transport with the scope headers
   (endpoints.ts), and the wallet announcement and sign-in message readers. */
import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  ApiError,
  errorFrom,
  fetchTransport,
  itemOf,
  listOf,
  setTransport,
  type ApiRequest,
} from '@/lib/api/client';
import { apiKeys, auth, checkout, market } from '@/lib/api/endpoints';
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
import { readAnnouncement } from '@/lib/wallet/eip6963';
import { siweMessage } from '@/lib/wallet/actions';
import { getAddress } from 'viem';

afterEach(() => setTransport(fetchTransport));

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
    return req.path === '/v1/api-keys' && req.method === 'GET'
      ? {
          status: 200,
          json: { data: [{ id: 'k', name: 'Bot', prefix: 'pk_live_ab12', scopes: ['p2p:read'] }] },
        }
      : { status: 401, json: { error: { code: 'unauthenticated', message: 'Sign in' } } };
  });
  const keys = await apiKeys.list({ org: 'org_1', tier: 'testnet' });
  assert.equal(keys[0].tier, 'live', 'the prefix decides the tier');
  assert.equal(seen[0].headers?.[ORG_HEADER], 'org_1');
  assert.equal(seen[0].headers?.[TIER_HEADER], 'testnet');
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
  assert.equal(seen[0].path, '/v1/checkout/orders/ord_12345678');
});

test('sessions, members, keys, webhooks and deliveries are read tolerantly', () => {
  assert.equal(normalizeSession({ address: 'nope' }), null);
  const s = normalizeSession({
    session: {
      address: '0xde3000000000000000000000000000000000a11e',
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
    'only a pedospe key is shown',
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

test('a wallet announcement is checked; only a data-URI icon is kept', () => {
  const provider = { request: async () => null };
  assert.equal(readAnnouncement(null), null);
  assert.equal(readAnnouncement({ info: { name: 'X', uuid: '1' } }), null, 'no provider');
  assert.equal(readAnnouncement({ info: { uuid: '1' }, provider }), null, 'no name');
  const w = readAnnouncement({
    info: { name: ' Wallet ', uuid: '1', icon: 'https://evil.example/x.png', rdns: 'a.b' },
    provider,
  });
  assert.equal(w?.info.name, 'Wallet');
  assert.equal(w?.info.icon, null, 'a remote icon is dropped');
  assert.equal(
    readAnnouncement({
      info: { name: 'W', uuid: '1', icon: 'data:image/png;base64,iVBORw0=' },
      provider,
    })?.info.icon,
    'data:image/png;base64,iVBORw0=',
  );
});

test('the sign-in message names this site, the address, the nonce and a short expiry', () => {
  const m = siweMessage({
    address: '0xde3000000000000000000000000000000000a11e',
    nonce: 'abcdef123456',
    statement: 'Sign in to pedospe.',
    chainId: 8453,
    domain: 'pedospe.example',
    uri: 'https://pedospe.example',
    now: new Date('2026-11-19T12:00:00Z'),
  });
  assert.ok(
    m.startsWith(
      `pedospe.example wants you to sign in with your Ethereum account:\n${getAddress('0xde3000000000000000000000000000000000a11e')}\n`,
    ),
  );
  assert.match(m, /Nonce: abcdef123456/);
  assert.match(m, /Chain ID: 8453/);
  assert.match(m, /Expiration Time: 2026-11-19T12:10:00.000Z/);
});
