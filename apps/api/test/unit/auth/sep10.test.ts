import { Keypair, Networks, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { Sep10Service, manageDataValue } from '@/auth/sep10.service';
import type { AccountState } from '@/chain/chain-client.service';
import type { StellarNetwork } from '@/chain/deployments.service';
import type { AppConfig } from '@/config/env';

const SERVER = Keypair.random();
const NETWORK = {
  network: 'testnet',
  passphrase: Networks.TESTNET,
  name: 'Stellar Testnet',
} as StellarNetwork;

/** The challenge table, in memory (what the service reads and writes of it). */
class Challenges {
  rows: Record<string, unknown>[] = [];
  authChallenge = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      this.rows.push({ ...data, usedAt: null });
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const now = (where.expiresAt as { gt: Date }).gt;
      const row = this.rows.find(
        (r) =>
          r.nonce === where.nonce &&
          r.purpose === where.purpose &&
          r.account === where.account &&
          r.network === where.network &&
          r.organizationId === where.organizationId &&
          r.tier === where.tier &&
          r.usedAt === null &&
          (r.expiresAt as Date) > now,
      );
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  };
}

const accounts = new Map<string, AccountState>();
const chain = { account: async (_n: unknown, a: string) => accounts.get(a) ?? null };
const config = {
  sep10: { homeDomain: 'pay.example', webAuthDomain: 'pay.example', network: 'testnet' },
} as unknown as AppConfig;
const deployments = {
  sep10Key: () => SERVER,
  network: () => NETWORK,
};

let db: Challenges;
let sep10: Sep10Service;

const sign = (xdr: string, ...signers: Keypair[]) => {
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
  tx.sign(...signers);
  return tx.toXDR();
};

beforeEach(() => {
  db = new Challenges();
  accounts.clear();
  sep10 = new Sep10Service(config, deployments as never, chain as never, db as never);
});

describe('SEP-10', () => {
  it('builds a standard challenge: sequence 0, the server as source, nonce, web_auth_domain, 5 minutes', async () => {
    const user = Keypair.random();
    const c = await sep10.challenge(user.publicKey(), 'session', NETWORK);
    expect(c.network_passphrase).toBe(Networks.TESTNET);
    const tx = TransactionBuilder.fromXDR(c.transaction, Networks.TESTNET) as Transaction;
    expect(tx.source).toBe(SERVER.publicKey());
    expect(tx.sequence).toBe('0');
    expect(tx.operations[0]).toMatchObject({
      type: 'manageData',
      name: 'pay.example auth',
      source: user.publicKey(),
    });
    expect(Buffer.from(manageDataValue(tx, 'pay.example auth') ?? '', 'base64')).toHaveLength(48);
    expect(manageDataValue(tx, 'web_auth_domain')).toBe('pay.example');
    expect(Number(tx.timeBounds?.maxTime) - Number(tx.timeBounds?.minTime)).toBe(300);
    expect(tx.signatures).toHaveLength(1);
  });

  it('verifies the master key of an account not created yet, once', async () => {
    const user = Keypair.random();
    const c = await sep10.challenge(user.publicKey(), 'session', NETWORK);
    const signed = sign(c.transaction, user);
    await expect(sep10.verify(signed, 'session', NETWORK)).resolves.toBe(user.publicKey());
    await expect(sep10.verify(signed, 'session', NETWORK)).rejects.toMatchObject({
      code: 'challenge_invalid',
    });
  });

  it('refuses another signer, without spending the nonce', async () => {
    const user = Keypair.random();
    const c = await sep10.challenge(user.publicKey(), 'session', NETWORK);
    await expect(
      sep10.verify(sign(c.transaction, Keypair.random()), 'session', NETWORK),
    ).rejects.toMatchObject({
      code: 'signature_invalid',
    });
    await expect(sep10.verify(sign(c.transaction, user), 'session', NETWORK)).resolves.toBe(
      user.publicKey(),
    );
  });

  it('needs the medium threshold of an existing account’s signers', async () => {
    const user = Keypair.random();
    const cosigner = Keypair.random();
    accounts.set(user.publicKey(), {
      address: user.publicKey(),
      sequence: 1n,
      balance: 0n,
      thresholds: { master: 1, low: 1, medium: 2, high: 2 },
      signers: [{ key: cosigner.publicKey(), weight: 1 }],
      subentries: 1,
    });
    const once = await sep10.challenge(user.publicKey(), 'session', NETWORK);
    await expect(
      sep10.verify(sign(once.transaction, user), 'session', NETWORK),
    ).rejects.toMatchObject({
      code: 'signature_invalid',
    });
    await expect(
      sep10.verify(sign(once.transaction, user, cosigner), 'session', NETWORK),
    ).resolves.toBe(user.publicKey());
  });

  it('binds a registration challenge to its organization and tier, and keeps it apart from sign-in', async () => {
    const user = Keypair.random();
    const binding = { organizationId: 'org_1', tier: 'test' as const };
    const c = await sep10.challenge(user.publicKey(), 'account', NETWORK, binding);
    const tx = TransactionBuilder.fromXDR(c.transaction, Networks.TESTNET) as Transaction;
    expect(manageDataValue(tx, 'organization')).toBe('org_1:test');
    const signed = sign(c.transaction, user);
    await expect(sep10.verify(signed, 'session', NETWORK)).rejects.toMatchObject({
      code: 'challenge_invalid',
    });
    await expect(
      sep10.verify(signed, 'account', NETWORK, { organizationId: 'org_2', tier: 'test' }),
    ).rejects.toMatchObject({ code: 'challenge_invalid' });
    await expect(sep10.verify(signed, 'account', NETWORK, binding)).resolves.toBe(user.publicKey());

    const signIn = await sep10.challenge(user.publicKey(), 'session', NETWORK);
    await expect(
      sep10.verify(sign(signIn.transaction, user), 'account', NETWORK, binding),
    ).rejects.toMatchObject({
      code: 'challenge_invalid',
    });
  });

  it('refuses a challenge signed for another network, or by another server', async () => {
    const user = Keypair.random();
    const c = await sep10.challenge(user.publicKey(), 'session', NETWORK);
    const mainnet = { ...NETWORK, passphrase: Networks.PUBLIC };
    await expect(sep10.verify(sign(c.transaction, user), 'session', mainnet)).rejects.toBeTruthy();
    const other = new Sep10Service(
      config,
      { ...deployments, sep10Key: () => Keypair.random() } as never,
      chain as never,
      db as never,
    );
    await expect(other.verify(sign(c.transaction, user), 'session', NETWORK)).rejects.toMatchObject(
      {
        code: 'challenge_invalid',
      },
    );
  });
});
