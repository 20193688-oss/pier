import type { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { inject } from 'vitest';
import { createApp } from '@/app.factory';
import { loadConfig, type AppConfig } from '@/config/env';
import {
  devSend,
  devWallet,
  fundDevWallet,
  localApiEnv,
  type DevRole,
  type DevWallet,
} from '@/dev/index';
import { PrismaService } from '@/prisma/prisma.service';

export const WEB_ORIGIN = 'http://localhost:3000';
export const SIWE_DOMAIN = 'localhost:3000';

export interface Harness {
  app: INestApplication;
  config: AppConfig;
  prisma: PrismaService;
  http: () => ReturnType<typeof supertest>;
  close(): Promise<void>;
}

/** Boots the HTTP app against the e2e Postgres and dev chain; jobs are ticked by hand. */
export async function bootApp(overrides: Record<string, string> = {}): Promise<Harness> {
  const infra = inject('infra');
  const env = {
    ...localApiEnv({
      port: 4999,
      databaseUrl: infra.databaseUrl,
      rpcUrl: infra.rpcUrl,
      deployment: infra.deployment,
      dataEncryptionKey: '11'.repeat(32),
      webOrigin: WEB_ORIGIN,
      jobsEnabled: false,
    }),
    ...overrides,
  };
  const config = loadConfig(env);
  const app = await createApp(config, { logger: false });
  await app.init();
  const server = app.getHttpServer();
  return {
    app,
    config,
    prisma: app.get(PrismaService),
    http: () => supertest(server),
    close: () => app.close(),
  };
}

let counter = 0;

/** A fresh random wallet (for isolation between tests). */
export function randomWallet(): DevWallet {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const privateKey = `0x${Buffer.from(bytes).toString('hex')}` as Hex;
  return { role: 'user', address: privateKeyToAccount(privateKey).address, privateKey };
}

export function wallet(role: DevRole): DevWallet {
  return devWallet(role);
}

/** Signs a wallet in through the API; answers its session token. */
export async function signIn(h: Harness, w: DevWallet): Promise<string> {
  const nonce = await h.http().post('/v1/auth/nonce').expect(200);
  const message = createSiweMessage({
    domain: SIWE_DOMAIN,
    address: w.address,
    statement: 'Sign in to pedospe.',
    uri: `http://${SIWE_DOMAIN}`,
    version: '1',
    chainId: 31337,
    nonce: nonce.body.nonce,
    issuedAt: new Date(),
  });
  const signature = await privateKeyToAccount(w.privateKey).signMessage({ message });
  const res = await h.http().post('/v1/auth/verify').send({ message, signature }).expect(200);
  return res.body.token as string;
}

/** An organization owned by a fresh wallet, with an API key per tier. */
export async function organization(
  h: Harness,
  owner: DevWallet = randomWallet(),
): Promise<{ id: string; session: string; testKey: string; liveKey: string; owner: DevWallet }> {
  const session = await signIn(h, owner);
  counter += 1;
  const org = await h
    .http()
    .post('/v1/organizations')
    .set('authorization', `Bearer ${session}`)
    .send({ name: `Org ${counter}` })
    .expect(201);
  const key = async (tier: 'test' | 'live') =>
    (
      await h
        .http()
        .post(`/v1/organizations/${org.body.id}/api-keys`)
        .set('authorization', `Bearer ${session}`)
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

/** Registers a wallet for an organization (challenge + signature). */
export async function registerWallet(
  h: Harness,
  key: string,
  w: DevWallet,
  displayName?: string,
): Promise<{ id: string; address: string }> {
  const challenge = await h
    .http()
    .post('/v1/p2p/accounts/challenge')
    .set('authorization', `Bearer ${key}`)
    .send({ address: w.address })
    .expect(200);
  const signature = await privateKeyToAccount(w.privateKey).signMessage({
    message: challenge.body.message,
  });
  const res = await h
    .http()
    .post('/v1/p2p/accounts')
    .set('authorization', `Bearer ${key}`)
    .send({ address: w.address, signature, ...(displayName ? { displayName } : {}) })
    .expect(201);
  return res.body;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export interface Merchant {
  org: Awaited<ReturnType<typeof organization>>;
  wallet: DevWallet;
  accountId: string;
}

/**
 * A funded merchant with an ARS payment method, ARS offers on both sides,
 * 100 000 tUSD deposited and the matcher authorised up to 5 000 per order,
 * all through the API's routes and transaction builder.
 */
export async function setupMerchant(
  h: Harness,
  name: string,
  prices: { sell: string; buy: string } = { sell: '1250', buy: '1180' },
): Promise<Merchant> {
  const infra = inject('infra');
  const U = 1_000_000n;
  const w = randomWallet();
  await fundDevWallet(infra.rpcUrl, infra.deployment.token, w.address, 200_000n * U);
  const org = await organization(h, w);
  const account = await registerWallet(h, org.testKey, w, name);
  await h
    .http()
    .post('/v1/p2p/payment-methods')
    .set(bearer(org.testKey))
    .send({
      accountId: account.id,
      currency: 'ARS',
      rail: 'ar_bank_transfer',
      holderName: `${name} SRL`,
      details: { alias: 'merchant.alias', cuit: '20123456786' },
    })
    .expect(201);
  for (const offer of [
    { side: 'SELL_TOKEN', price: prices.sell },
    { side: 'BUY_TOKEN', price: prices.buy },
  ]) {
    await h
      .http()
      .post('/v1/p2p/offers')
      .set(bearer(org.testKey))
      .send({
        accountId: account.id,
        network: 'local',
        token: 'tUSD',
        currency: 'ARS',
        rails: ['ar_bank_transfer'],
        minFiat: '1000',
        maxFiat: '5000000',
        priceTtlSeconds: 3600,
        ...offer,
      })
      .expect(201);
  }
  for (const [action, args] of [
    ['approve', { token: 'tUSD', amount: (100_000n * U).toString() }],
    ['deposit', { token: 'tUSD', amount: (100_000n * U).toString() }],
    ['setMatcher', { maxPerOrder: (5_000n * U).toString(), autoSettle: false }],
  ] as const) {
    const tx = await h
      .http()
      .post('/v1/p2p/transactions')
      .set(bearer(org.testKey))
      .send({ network: 'local', from: account.id, action, args })
      .expect(200);
    await devSend(infra.rpcUrl, w.privateKey, tx.body);
  }
  return { org, wallet: w, accountId: account.id };
}

/** Moves every matcher transaction and indexed event forward once. */
export async function tickChain(h: Harness): Promise<void> {
  const { IndexerJob } = await import('@/p2p/indexer.job');
  const { MatcherFollowerJob } = await import('@/p2p/matcher-follower.job');
  await h.app.get(MatcherFollowerJob).tick();
  await h.app.get(IndexerJob).tick();
}

/** Test files share one database: each behaviour file starts with no other merchant's offers. */
export async function quietMarket(h: Harness): Promise<void> {
  await h.prisma.p2pOffer.updateMany({ data: { active: false } });
}
