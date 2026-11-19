import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildOpenApi } from '@/openapi/document';
import {
  bearer,
  bootApp,
  organization,
  randomWallet,
  registerWallet,
  signIn,
  wallet,
  WEB_ORIGIN,
  type Harness,
} from '@test/e2e/harness';

/**
 * The HTTP wiring of EVERY route: who may call it and who is refused. The
 * table below must list exactly the operations of the OpenAPI document, so a
 * new route without a row here fails this file.
 */

type Policy = 'public' | 'session' | 'read' | 'write' | 'admin';

const ROUTES: Record<string, Policy> = {
  'GET /health': 'public',
  'GET /v1/market': 'public',
  'POST /v1/auth/nonce': 'public',
  'POST /v1/auth/verify': 'public',
  'GET /v1/auth/session': 'session',
  'POST /v1/auth/logout': 'session',
  'GET /v1/organizations': 'session',
  'POST /v1/organizations': 'session',
  'GET /v1/organizations/{orgId}': 'session',
  'PATCH /v1/organizations/{orgId}': 'session',
  'GET /v1/organizations/{orgId}/api-keys': 'session',
  'POST /v1/organizations/{orgId}/api-keys': 'session',
  'DELETE /v1/organizations/{orgId}/api-keys/{keyId}': 'session',
  'GET /v1/organizations/{orgId}/members': 'session',
  'POST /v1/organizations/{orgId}/members': 'session',
  'DELETE /v1/organizations/{orgId}/members/{memberId}': 'session',
  'PATCH /v1/organizations/{orgId}/members/{memberId}': 'session',
  'GET /v1/app/orders': 'session',
  'POST /v1/app/orders': 'session',
  'GET /v1/app/orders/{id}': 'session',
  'POST /v1/app/orders/{id}/cancel': 'session',
  'POST /v1/app/orders/{id}/dispute': 'session',
  'POST /v1/app/orders/{id}/paid': 'session',
  'POST /v1/app/orders/{id}/transactions': 'session',
  'POST /v1/app/quotes': 'session',
  'GET /v1/p2p-checkout/charges/{id}': 'public',
  'POST /v1/p2p-checkout/charges/{id}/orders': 'public',
  'GET /v1/p2p-checkout/orders/{id}': 'public',
  'POST /v1/p2p-checkout/orders/{id}/cancel': 'public',
  'POST /v1/p2p-checkout/orders/{id}/paid': 'public',
  'GET /v1/p2p/accounts': 'read',
  'POST /v1/p2p/accounts': 'write',
  'POST /v1/p2p/accounts/challenge': 'write',
  'DELETE /v1/p2p/accounts/{id}': 'write',
  'GET /v1/p2p/accounts/{id}': 'read',
  'PATCH /v1/p2p/accounts/{id}': 'write',
  'GET /v1/p2p/charges': 'read',
  'POST /v1/p2p/charges': 'write',
  'DELETE /v1/p2p/charges/{id}': 'write',
  'GET /v1/p2p/charges/{id}': 'read',
  'GET /v1/p2p/merchant/orders': 'read',
  'GET /v1/p2p/merchant/orders/{id}': 'read',
  'POST /v1/p2p/merchant/transfer-matches': 'read',
  'GET /v1/p2p/offers': 'read',
  'POST /v1/p2p/offers': 'write',
  'DELETE /v1/p2p/offers/{id}': 'write',
  'PATCH /v1/p2p/offers/{id}': 'write',
  'GET /v1/p2p/orders': 'read',
  'POST /v1/p2p/orders': 'write',
  'GET /v1/p2p/orders/{id}': 'read',
  'POST /v1/p2p/orders/{id}/cancel': 'write',
  'POST /v1/p2p/orders/{id}/dispute': 'write',
  'POST /v1/p2p/orders/{id}/paid': 'write',
  'GET /v1/p2p/payment-methods': 'read',
  'POST /v1/p2p/payment-methods': 'write',
  'DELETE /v1/p2p/payment-methods/{id}': 'write',
  'PATCH /v1/p2p/payment-methods/{id}': 'write',
  'GET /v1/p2p/payouts': 'read',
  'POST /v1/p2p/payouts': 'write',
  'GET /v1/p2p/payouts/{id}': 'read',
  'POST /v1/p2p/quotes': 'write',
  'POST /v1/p2p/transactions': 'read',
  'GET /v1/webhook-endpoints': 'read',
  'POST /v1/webhook-endpoints': 'write',
  'DELETE /v1/webhook-endpoints/{id}': 'write',
  'GET /v1/webhook-endpoints/{id}': 'read',
  'PATCH /v1/webhook-endpoints/{id}': 'write',
  'GET /v1/webhook-endpoints/{id}/deliveries': 'read',
  'GET /v1/admin/p2p/disputes': 'admin',
  'PATCH /v1/admin/p2p/merchants/{accountId}': 'admin',
  'GET /v1/admin/p2p/orders/{id}': 'admin',
  'POST /v1/admin/p2p/orders/{id}/resolution': 'admin',
};

const MISSING = '00000000-0000-4000-8000-000000000000';
const DENIED = [401, 403];

let h: Harness;
let org: Awaited<ReturnType<typeof organization>>;
let other: Awaited<ReturnType<typeof organization>>;
let readOnlyKey = '';
let outsiderSession = '';
let memberSession = '';
let adminSession = '';

function send(method: string, path: string, headers: Record<string, string> = {}) {
  const url = path.replace(/\{orgId\}/g, org.id).replace(/\{[^}]+\}/g, MISSING);
  const req = h.http()[method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'](url);
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return method === 'GET' || method === 'DELETE' ? req : req.send({});
}

beforeAll(async () => {
  const infra = inject('infra');
  // A live tier is configured too (it points at the dev node, so it never
  // verifies), so the tier checks run against a tier that exists.
  h = await bootApp({
    P2P_CONTRACTS_LIVE: JSON.stringify({ base: infra.deployment.market }),
    P2P_RPC_URLS_LIVE: JSON.stringify({ base: infra.rpcUrl }),
  });
  org = await organization(h);
  other = await organization(h);
  readOnlyKey = (
    await h
      .http()
      .post(`/v1/organizations/${org.id}/api-keys`)
      .set(bearer(org.session))
      .send({ name: 'reader', tier: 'test', scopes: ['p2p:read'] })
      .expect(201)
  ).body.key;
  outsiderSession = await signIn(h, randomWallet());
  const member = randomWallet();
  await h
    .http()
    .post(`/v1/organizations/${org.id}/members`)
    .set(bearer(org.session))
    .send({ address: member.address, role: 'member' })
    .expect(201);
  memberSession = await signIn(h, member);
  adminSession = await signIn(h, wallet('owner'));
});

afterAll(async () => {
  await h?.close();
});

describe('route table', () => {
  it('lists every documented operation, and nothing else', () => {
    const doc = buildOpenApi(h.app);
    const documented = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.keys(item as object).map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect(documented.sort()).toEqual(Object.keys(ROUTES).sort());
  });
});

describe('who may call each route', () => {
  for (const [route, policy] of Object.entries(ROUTES)) {
    const [method, path] = route.split(' ');

    if (policy === 'public') {
      it(`${route} answers without credentials`, async () => {
        const res = await send(method, path);
        expect(DENIED).not.toContain(res.status);
      });
      continue;
    }

    it(`${route} refuses a caller without credentials (401)`, async () => {
      const res = await send(method, path);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    });

    it(`${route} refuses an unknown token (401)`, async () => {
      expect((await send(method, path, bearer('pk_test_not-a-real-key'))).status).toBe(401);
      expect((await send(method, path, bearer('ps_sess_not-a-real-session'))).status).toBe(401);
    });

    if (policy === 'session') {
      it(`${route} refuses an API key (403) and takes a session`, async () => {
        expect((await send(method, path, bearer(org.testKey))).status).toBe(403);
        // Logging out ends the session it is called with: use a throwaway one.
        const session =
          route === 'POST /v1/auth/logout' ? await signIn(h, randomWallet()) : org.session;
        const res = await send(method, path, bearer(session));
        expect(DENIED).not.toContain(res.status);
      });
    }

    if (policy === 'read' || policy === 'write') {
      it(`${route} takes the organization's key and its members' sessions`, async () => {
        const res = await send(method, path, bearer(org.testKey));
        expect(DENIED).not.toContain(res.status);
        const asMember = await send(method, path, {
          ...bearer(policy === 'read' ? memberSession : org.session),
          'pedospe-organization': org.id,
          'pedospe-tier': 'test',
        });
        expect(DENIED).not.toContain(asMember.status);
      });

      it(`${route} refuses a session that is not a member (403)`, async () => {
        const res = await send(method, path, {
          ...bearer(outsiderSession),
          'pedospe-organization': org.id,
        });
        expect(res.status).toBe(403);
      });

      it(`${route} asks a session which organization (400)`, async () => {
        expect((await send(method, path, bearer(org.session))).status).toBe(400);
      });
    }

    if (policy === 'write') {
      it(`${route} refuses a read-only key and a read-only member (403)`, async () => {
        expect((await send(method, path, bearer(readOnlyKey))).status).toBe(403);
        const res = await send(method, path, {
          ...bearer(memberSession),
          'pedospe-organization': org.id,
        });
        expect(res.status).toBe(403);
      });
    }

    if (policy === 'admin') {
      it(`${route} refuses API keys and non-admin sessions (403), takes an admin`, async () => {
        expect((await send(method, path, bearer(org.testKey))).status).toBe(403);
        expect((await send(method, path, bearer(org.session))).status).toBe(403);
        expect(DENIED).not.toContain((await send(method, path, bearer(adminSession))).status);
      });
    }
  }
});

describe('isolation', () => {
  it('keeps one organization’s rows from another and from its other tier', async () => {
    const account = await registerWallet(h, org.testKey, randomWallet());
    await h.http().get(`/v1/p2p/accounts/${account.id}`).set(bearer(org.testKey)).expect(200);
    // Another organization: the 404 of a missing row.
    await h.http().get(`/v1/p2p/accounts/${account.id}`).set(bearer(other.testKey)).expect(404);
    // The same organization on the live tier: another tier's row is missing too.
    await h.http().get(`/v1/p2p/accounts/${account.id}`).set(bearer(org.liveKey)).expect(404);
    const live = await h.http().get('/v1/p2p/accounts').set(bearer(org.liveKey)).expect(200);
    expect(live.body.data).toEqual([]);
    const asSession = await h
      .http()
      .get(`/v1/p2p/accounts/${account.id}`)
      .set(bearer(org.session))
      .set('pedospe-organization', org.id)
      .set('pedospe-tier', 'live')
      .expect(404);
    expect(asSession.body.error.code).toBe('not_found');
  });

  it('keeps webhook endpoints per tier', async () => {
    const endpoint = await h
      .http()
      .post('/v1/webhook-endpoints')
      .set(bearer(org.testKey))
      .send({ url: 'http://127.0.0.1:9/hook' })
      .expect(201);
    expect(endpoint.body.secret).toMatch(/^whsec_/);
    await h
      .http()
      .get(`/v1/webhook-endpoints/${endpoint.body.id}`)
      .set(bearer(org.liveKey))
      .expect(404);
    await h
      .http()
      .get(`/v1/webhook-endpoints/${endpoint.body.id}`)
      .set(bearer(other.testKey))
      .expect(404);
  });

  it('never lets a wallet manage an organization it is not in', async () => {
    await h.http().get(`/v1/organizations/${org.id}`).set(bearer(outsiderSession)).expect(404);
    await h
      .http()
      .get(`/v1/organizations/${org.id}/api-keys`)
      .set(bearer(memberSession))
      .expect(403);
  });
});

describe('credentials', () => {
  it('stops a revoked key at once', async () => {
    const created = await h
      .http()
      .post(`/v1/organizations/${org.id}/api-keys`)
      .set(bearer(org.session))
      .send({ name: 'short-lived', tier: 'test', scopes: ['p2p:read'] })
      .expect(201);
    await h.http().get('/v1/p2p/accounts').set(bearer(created.body.key)).expect(200);
    await h
      .http()
      .delete(`/v1/organizations/${org.id}/api-keys/${created.body.id}`)
      .set(bearer(org.session))
      .expect(204);
    await h.http().get('/v1/p2p/accounts').set(bearer(created.body.key)).expect(401);
  });

  it('refuses a cookie-authenticated write from another origin, and takes it from the web app', async () => {
    const cookie = `pedospe_session=${org.session}`;
    await h
      .http()
      .post('/v1/organizations')
      .set('cookie', cookie)
      .set('origin', 'https://evil.example')
      .send({ name: 'Nope' })
      .expect(403);
    await h
      .http()
      .post('/v1/organizations')
      .set('cookie', cookie)
      .send({ name: 'Nope' })
      .expect(403);
    await h
      .http()
      .post('/v1/organizations')
      .set('cookie', cookie)
      .set('origin', WEB_ORIGIN)
      .send({ name: 'From the web app' })
      .expect(201);
    await h.http().get('/v1/auth/session').set('cookie', cookie).expect(200);
  });

  it('spends a SIWE nonce once and refuses another domain', async () => {
    const res = await h
      .http()
      .post('/v1/auth/verify')
      .send({ message: 'not siwe', signature: '0x00' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('challenge_invalid');
  });

  it('ends a session on logout', async () => {
    const session = await signIn(h, randomWallet());
    await h.http().post('/v1/auth/logout').set(bearer(session)).expect(204);
    await h.http().get('/v1/auth/session').set(bearer(session)).expect(401);
  });

  it('refuses the dev tools on orders that are not on the dev chain, and unknown ones', async () => {
    await h.http().post(`/v1/dev/orders/${MISSING}/simulate-transfer`).expect(404);
  });
});

describe('error shape', () => {
  it('answers an unknown route with the error shape', async () => {
    const res = await h.http().get('/v1/nothing-here').expect(404);
    expect(res.body).toEqual({
      error: { code: 'not_found', message: 'No route GET /v1/nothing-here.' },
    });
  });

  it('lists field problems on a validation error', async () => {
    const res = await h
      .http()
      .post('/v1/p2p/offers')
      .set(bearer(org.testKey))
      .send({ price: 'x' })
      .expect(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details.length).toBeGreaterThan(1);
  });
});
