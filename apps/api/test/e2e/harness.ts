import type { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { inject } from 'vitest';
import { createApp } from '@/app.factory';
import { loadConfig, type AppConfig } from '@/config/env';
import { devWallet, localApiEnv, type DevRole, type DevWallet } from '@/dev/index';
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
