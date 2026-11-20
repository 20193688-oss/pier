/* wallet.test.ts: SEP-10 sign-in end to end against a fake API (src/lib/session.tsx sep10SignIn):
   the challenge is checked against this app's domains and this origin's stellar.toml signing key
   before the wallet signs, a relayed challenge is refused unsigned, and the API receives exactly
   the signed challenge. The key-backed wallets sign only what they are handed. */
import { EMAIL_CODE_LENGTH, emailCode } from '@/lib/wallet/email-code';
import { pollarNetworkFor } from '@/lib/wallet/pollar-store';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { Account, Keypair, Operation, TransactionBuilder, hash } from '@stellar/stellar-sdk/base';
import { fetchTransport, setTransport, type ApiRequest } from '@/lib/api/client';
import { sep10SignIn } from '@/lib/session';
import { forgetSigningKey } from '@/lib/stellar/sep10';
import { keypairWallet } from '@/lib/wallet/keypair';
import { WalletError, type StellarWallet } from '@/lib/wallet/types';
import { PASSPHRASES } from '@/lib/stellar/network';

const kp = (seed: string) => Keypair.fromRawEd25519Seed(hash(new TextEncoder().encode(seed)));
const SERVER = kp('sep10 server');
const ANCHOR = kp('an anchor');
const USER = kp('user');
const HOME = 'app.example';
const PASS = PASSPHRASES.testnet;

function challenge(server: Keypair, home: string, nonce = 'x'.repeat(64)) {
  const t = Math.floor(Date.now() / 1000);
  const tx = new TransactionBuilder(new Account(server.publicKey(), '-1'), {
    fee: '100',
    networkPassphrase: PASS,
    timebounds: { minTime: t, maxTime: t + 300 },
  })
    .addOperation(
      Operation.manageData({ name: `${home} auth`, value: nonce, source: USER.publicKey() }),
    )
    .addOperation(
      Operation.manageData({ name: 'web_auth_domain', value: home, source: server.publicKey() }),
    )
    .build();
  tx.sign(server);
  return tx.toXDR();
}

function fakeApi(served: { toml: string; challenge: string }) {
  const seen: ApiRequest[] = [];
  setTransport(async (req) => {
    seen.push(req);
    if (req.path === '/.well-known/stellar.toml') return { status: 200, json: served.toml };
    if (req.path === '/v1/auth/challenge')
      return { status: 200, json: { transaction: served.challenge, network_passphrase: PASS } };
    if (req.path === '/v1/auth/verify') return { status: 200, json: { token: 't', session: {} } };
    if (req.path === '/v1/auth/session')
      return { status: 200, json: { address: USER.publicKey(), organizations: [] } };
    return { status: 404, json: null };
  });
  return seen;
}

beforeEach(() => {
  vi.stubEnv('VITE_SEP10_HOME_DOMAIN', HOME);
  forgetSigningKey();
});
afterEach(() => {
  vi.unstubAllEnvs();
  setTransport(fetchTransport);
});

const counting = (w: StellarWallet) => {
  let calls = 0;
  return {
    wallet: {
      ...w,
      signAuthChallenge: async (...a: Parameters<StellarWallet['signAuthChallenge']>) => {
        calls++;
        assert.deepEqual(a[2], { homeDomain: HOME, webAuthDomain: HOME }, 'the configured domains');
        return w.signAuthChallenge(...a);
      },
    },
    calls: () => calls,
  };
};

describe('SEP-10 sign-in', () => {
  test('a challenge from this origin is signed and sent back as is', async () => {
    const seen = fakeApi({
      toml: `SIGNING_KEY = "${SERVER.publicKey()}"\n`,
      challenge: challenge(SERVER, HOME),
    });
    const { wallet, calls } = counting(keypairWallet(USER, 'dev-key', 'k'));
    const steps: string[] = [];
    const s = await sep10SignIn(wallet, (st) => steps.push(st));
    assert.equal(s.address, USER.publicKey());
    assert.equal(calls(), 1);
    assert.deepEqual(steps, ['challenge', 'signing', 'checking']);
    const verify = seen.find((r) => r.path === '/v1/auth/verify')!;
    const signed = TransactionBuilder.fromXDR(
      (verify.body as { transaction: string }).transaction,
      PASS,
    );
    assert.equal(signed.signatures.length, 2, "the server's and the wallet's");
    assert.equal(seen.find((r) => r.path === '/.well-known/stellar.toml')?.sameOrigin, true);
  });

  test("an anchor's challenge relayed by the API is refused before any signature", async () => {
    fakeApi({
      toml: `SIGNING_KEY = "${SERVER.publicKey()}"\n`,
      challenge: challenge(ANCHOR, 'anchor.example'),
    });
    const { wallet, calls } = counting(keypairWallet(USER, 'dev-key', 'k'));
    await assert.rejects(sep10SignIn(wallet), (e: unknown) => {
      assert.ok(e instanceof WalletError);
      assert.match(e.message, /^challenge:/);
      return true;
    });
    assert.equal(calls(), 0, 'the wallet was never asked');
  });

  test('refused: our own key but another home domain, or no signing key published', async () => {
    fakeApi({
      toml: `SIGNING_KEY = "${SERVER.publicKey()}"\n`,
      challenge: challenge(SERVER, 'x.example'),
    });
    await assert.rejects(sep10SignIn(keypairWallet(USER, 'dev-key', 'k')), /challenge:home-domain/);
    forgetSigningKey();
    fakeApi({ toml: 'WEB_AUTH_ENDPOINT = "x"\n', challenge: challenge(SERVER, HOME) });
    await assert.rejects(sep10SignIn(keypairWallet(USER, 'dev-key', 'k')), /challenge:signing-key/);
  });

  test('a wallet that hands back another transaction is refused before it reaches the API', async () => {
    const seen = fakeApi({
      toml: `SIGNING_KEY = "${SERVER.publicKey()}"\n`,
      challenge: challenge(SERVER, HOME),
    });
    const evil: StellarWallet = {
      ...keypairWallet(USER, 'dev-key', 'k'),
      signAuthChallenge: async () => {
        const other = TransactionBuilder.fromXDR(challenge(SERVER, HOME, 'y'.repeat(64)), PASS);
        other.sign(USER);
        return other.toXDR();
      },
    };
    await assert.rejects(sep10SignIn(evil), WalletError);
    assert.equal(
      seen.some((r) => r.path === '/v1/auth/verify'),
      false,
    );
  });
});

describe('Pollar email codes', () => {
  test('keeps only the six letters and digits a pasted code carries', () => {
    assert.equal(emailCode('649814'), '649814');
    assert.equal(emailCode(' 649 814 '), '649814');
    assert.equal(emailCode('649-814'), '649814');
    assert.equal(emailCode('649​814 '), '649814');
    assert.equal(emailCode('６４９８１４'), '649814');
    assert.notEqual(emailCode('64981').length, EMAIL_CODE_LENGTH);
  });
});

describe('Pollar network', () => {
  test('follows the key’s environment, and the tier only for an unprefixed key', () => {
    assert.equal(pollarNetworkFor('pub_testnet_e4af75b8', 'live'), 'testnet');
    assert.equal(pollarNetworkFor('pub_mainnet_e4af75b8', 'test'), 'mainnet');
    assert.equal(pollarNetworkFor('pk_other', 'live'), 'mainnet');
    assert.equal(pollarNetworkFor('pk_other', 'test'), 'testnet');
  });
});
