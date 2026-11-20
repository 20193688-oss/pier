import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Keypair, StrKey, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import supertest from 'supertest';
import { inject } from 'vitest';
import { createApp } from '@/app.factory';
import { RateLimiter } from '@/common/rate-limit';
import { loadConfig, type AppConfig } from '@/config/env';
import { PrismaService } from '@/prisma/prisma.service';
import { FakeChain } from '@test/e2e/fake-chain';

export const WEB_ORIGIN = 'http://localhost:3100';
export const HOME_DOMAIN = 'localhost:3100';

/** Keys of the e2e API (fresh per run; never funded anywhere). */
export const KEYS = {
  sep10: Keypair.random(),
  matcher: Keypair.random(),
  sponsor: Keypair.random(),
  admin: Keypair.random(),
};

/** A contract id nobody deployed: the fake chain never verifies it. */
export const FAKE_CONTRACT = StrKey.encodeContract(randomBytes(32));

export interface Harness {
  app: INestApplication;
  config: AppConfig;
  prisma: PrismaService;
  chain: FakeChain;
  http: () => ReturnType<typeof supertest>;
  close(): Promise<void>;
}

/** The API's environment for the wiring suites: testnet and mainnet configured, no network reached. */
export function e2eEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const infra = inject('infra');
  return {
    NODE_ENV: 'test',
    DATABASE_URL: infra.databaseUrl,
    DATA_ENCRYPTION_KEY: '11'.repeat(32),
    WEB_ORIGINS: WEB_ORIGIN,
    SEP10_HOME_DOMAIN: HOME_DOMAIN,
    SEP10_NETWORK: 'testnet',
    SEP10_SIGNING_SECRET: KEYS.sep10.secret(),
    P2P_MATCHER_SECRET: KEYS.matcher.secret(),
    P2P_SPONSOR_SECRET: KEYS.sponsor.secret(),
    ADMIN_ADDRESSES: KEYS.admin.publicKey(),
    STELLAR_TESTNET_RPC_URL: 'http://127.0.0.1:9/rpc',
    P2P_TESTNET_CONTRACT: FAKE_CONTRACT,
    STELLAR_MAINNET_RPC_URL: 'http://127.0.0.1:9/rpc',
    P2P_MAINNET_CONTRACT: FAKE_CONTRACT,
    APP_TIER: 'test',
    JOBS_ENABLED: 'false',
    DEV_TOOLS: 'true',
    COOKIE_SECURE: 'false',
    WEBHOOKS_ALLOW_INSECURE: 'true',
    ...overrides,
  };
}

/** Boots the HTTP app against the e2e Postgres with a fake chain; jobs are ticked by hand. */
export async function bootApp(overrides: Record<string, string> = {}): Promise<Harness> {
  const config = loadConfig(e2eEnv(overrides));
  const chain = new FakeChain();
  const app = await createApp(config, { logger: false, overrides: { chain } });
  await app.init();
  const server = app.getHttpServer();
  return {
    app,
    config,
    chain,
    prisma: app.get(PrismaService),
    http: () => supertest(server),
    close: () => app.close(),
  };
}

let counter = 0;

/** A fresh random account (for isolation between tests). */
export function randomWallet(): Keypair {
  return Keypair.random();
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Signs a challenge envelope with `signer`. */
export function sign(xdr: string, passphrase: string, ...signers: Keypair[]): string {
  const tx = TransactionBuilder.fromXDR(xdr, passphrase) as Transaction;
  tx.sign(...signers);
  return tx.toXDR();
}

/** Signs an account in through the API (SEP-10); answers its session token. */
export async function signIn(h: Harness, w: Keypair): Promise<string> {
  // Every test signs in from the same address: the per-IP sign-in limit is not under test here.
  h.app.get(RateLimiter).reset();
  const challenge = await h.http().get(`/v1/auth/challenge?account=${w.publicKey()}`).expect(200);
  const res = await h
    .http()
    .post('/v1/auth/verify')
    .send({ transaction: sign(challenge.body.transaction, challenge.body.network_passphrase, w) })
    .expect(200);
  return res.body.token as string;
}

/** An organization owned by a fresh account, with an API key per tier. */
export async function organization(
  h: Harness,
  owner: Keypair = randomWallet(),
): Promise<{ id: string; session: string; testKey: string; liveKey: string; owner: Keypair }> {
  const session = await signIn(h, owner);
  counter += 1;
  const org = await h
    .http()
    .post('/v1/organizations')
    .set(bearer(session))
    .send({ name: `Org ${counter}` })
    .expect(201);
  const key = async (tier: 'test' | 'live') =>
    (
      await h
        .http()
        .post(`/v1/organizations/${org.body.id}/api-keys`)
        .set(bearer(session))
        .send({ name: `${tier} key`, tier, scopes: ['p2p:read', 'p2p:write'] })
        .expect(201)
    ).body.key as string;
  return {
    id: org.body.id,
    session,
    testKey: await key('test'),
    liveKey: await key('live'),
    owner,
  };
}

/** Registers an account for an organization (SEP-10-shaped proof). */
export async function registerWallet(
  h: Harness,
  key: string,
  w: Keypair,
  displayName?: string,
): Promise<{ id: string; address: string }> {
  const challenge = await h
    .http()
    .post('/v1/p2p/accounts/challenge')
    .set(bearer(key))
    .send({ address: w.publicKey() })
    .expect(200);
  const res = await h
    .http()
    .post('/v1/p2p/accounts')
    .set(bearer(key))
    .send({
      transaction: sign(challenge.body.transaction, challenge.body.network_passphrase, w),
      ...(displayName ? { displayName } : {}),
    })
    .expect(201);
  return res.body;
}
