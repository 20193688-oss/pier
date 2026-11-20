/* challenge.test.ts: a SEP-10 challenge is signed only when it matches this app's own trusted
   values (src/lib/stellar/challenge.ts): one case per way an API answer could relay another
   service's challenge or dress up a transaction, and the stellar.toml reader. Also the wallet-side
   checks of what a wallet hands back (src/lib/wallet/signed.ts). */
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  Account,
  Asset,
  Keypair,
  Operation,
  TransactionBuilder,
  hash,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk/base';
import {
  checkChallenge,
  signingKeyOf,
  type ChallengeExpectation,
} from '@/lib/stellar/challenge';
import { assertSameTransaction } from '@/lib/wallet/signed';
import { keypairWallet } from '@/lib/wallet/keypair';
import { WalletError } from '@/lib/wallet/types';
import { KNOWN_PASSPHRASES, PASSPHRASES } from '@/lib/stellar/network';

const kp = (seed: string) => Keypair.fromRawEd25519Seed(hash(new TextEncoder().encode(seed)));
const SERVER = kp('server');
const ANCHOR = kp('an anchor');
const USER = kp('user');
const OTHER = kp('other');
const PASS = PASSPHRASES.testnet;
const NOW = 1_800_000_000;
const HOME = 'app.example';
const EXPECT: ChallengeExpectation = {
  account: USER.publicKey(),
  networkPassphrase: PASS,
  allowedPassphrases: KNOWN_PASSPHRASES,
  homeDomain: HOME,
  webAuthDomain: HOME,
  signingKey: SERVER.publicKey(),
};
const NONCE = 'n'.repeat(64);

function challenge(
  over: Partial<{
    server: Keypair;
    signer: Keypair | null;
    sequence: string;
    home: string;
    web: string | null;
    webSource: string;
    account: string;
    nonce: string;
    maxTime: number;
    passphrase: string;
    extra: xdr.Operation[];
  }> = {},
): string {
  const server = over.server ?? SERVER;
  const b = new TransactionBuilder(new Account(server.publicKey(), over.sequence ?? '-1'), {
    fee: '100',
    networkPassphrase: over.passphrase ?? PASS,
    timebounds: { minTime: NOW, maxTime: over.maxTime ?? NOW + 300 },
  }).addOperation(
    Operation.manageData({
      name: `${over.home ?? HOME} auth`,
      value: over.nonce ?? NONCE,
      source: over.account ?? USER.publicKey(),
    }),
  );
  if (over.web !== null)
    b.addOperation(
      Operation.manageData({
        name: 'web_auth_domain',
        value: over.web ?? HOME,
        source: over.webSource ?? server.publicKey(),
      }),
    );
  for (const op of over.extra ?? []) b.addOperation(op);
  const tx = b.build();
  const signer = over.signer === undefined ? server : over.signer;
  if (signer) tx.sign(signer);
  return tx.toXDR();
}

const check = (x: string, e: Partial<ChallengeExpectation> = {}) =>
  checkChallenge(x, { ...EXPECT, ...e }, NOW + 10);

describe('a SEP-10 challenge is signed only against trusted values', () => {
  test('a real challenge from this origin passes', () => assert.equal(check(challenge()), null));
  test("refused: another service's challenge (its own key and home domain)", () =>
    assert.equal(check(challenge({ server: ANCHOR, home: 'anchor.example', web: 'anchor.example' })), 'signing-key'));
  test("refused: another service's home domain, even signed by our key", () =>
    assert.equal(check(challenge({ home: 'anchor.example' })), 'home-domain'));
  test('refused: another web_auth_domain, none, or one the account sources', () => {
    assert.equal(check(challenge({ web: 'anchor.example' })), 'web-auth-domain');
    assert.equal(check(challenge({ web: null })), 'web-auth-domain');
    assert.equal(check(challenge({ webSource: USER.publicKey() })), 'web-auth-domain');
  });
  test('refused: a source that is not the published signing key', () =>
    assert.equal(check(challenge({ server: OTHER })), 'signing-key'));
  test('refused: no server signature, or one by another key', () => {
    assert.equal(check(challenge({ signer: null })), 'server-signature');
    assert.equal(check(challenge({ signer: OTHER })), 'server-signature');
  });
  test('refused: a transaction that could be submitted', () =>
    assert.equal(check(challenge({ sequence: '41' })), 'sequence'));
  test('refused: anything but manage_data', () =>
    assert.equal(
      check(
        challenge({
          extra: [
            Operation.payment({
              destination: OTHER.publicKey(),
              asset: Asset.native(),
              amount: '1',
              source: USER.publicKey(),
            }),
          ],
        }),
      ),
      'operations',
    ));
  test('refused: an operation of a third account', () =>
    assert.equal(
      check(
        challenge({
          extra: [Operation.manageData({ name: 'x', value: 'y', source: OTHER.publicKey() })],
        }),
      ),
      'operations',
    ));
  test('refused: a challenge for another account', () =>
    assert.equal(check(challenge({ account: OTHER.publicKey() })), 'account'));
  test('refused: a nonce of the wrong size', () =>
    assert.equal(check(challenge({ nonce: 'short' })), 'nonce'));
  test('refused: expired, or valid for too long', () => {
    assert.equal(checkChallenge(challenge(), EXPECT, NOW + 301), 'time');
    assert.equal(check(challenge({ maxTime: NOW + 3600 })), 'time');
  });
  test('refused: an unknown network, or another passphrase than the answer named', () => {
    assert.equal(check(challenge(), { networkPassphrase: 'Some other network' }), 'network');
    assert.equal(
      check(challenge({ passphrase: PASSPHRASES.mainnet })),
      'server-signature',
      'signed for mainnet, checked for testnet: the signature does not verify',
    );
  });
  test('refused: not a transaction, or no trusted signing key', () => {
    assert.equal(check('AAAA'), 'shape');
    assert.equal(check(challenge(), { signingKey: '' }), 'signing-key');
    assert.equal(check(challenge(), { homeDomain: '' }), 'signing-key');
  });
  test('an organization binding by the server is allowed (wallet proofs)', () =>
    assert.equal(
      check(
        challenge({
          extra: [
            Operation.manageData({ name: 'organization', value: 'org_1', source: SERVER.publicKey() }),
          ],
        }),
      ),
      null,
    ));
});

describe('stellar.toml: the top-level SIGNING_KEY only', () => {
  const key = SERVER.publicKey();
  test('read', () => {
    assert.equal(signingKeyOf(`NETWORK_PASSPHRASE="x"\nSIGNING_KEY = "${key}"\n`), key);
    assert.equal(signingKeyOf(`SIGNING_KEY="${key}" # ours\r\n`), key);
  });
  test('not under another table, not a bad key, not absent', () => {
    assert.equal(signingKeyOf(`[[CURRENCIES]]\nSIGNING_KEY = "${key}"\n`), null);
    assert.equal(signingKeyOf(`SIGNING_KEY = "${key.slice(0, -1)}A"\n`), null);
    assert.equal(signingKeyOf('WEB_AUTH_ENDPOINT = "https://x"\n'), null);
  });
});

describe('what a wallet hands back', () => {
  const unsigned = () => {
    const tx = new TransactionBuilder(new Account(USER.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: PASS,
      timebounds: { minTime: 0, maxTime: NOW },
    })
      .addOperation(Operation.payment({ destination: OTHER.publicKey(), asset: Asset.native(), amount: '1' }))
      .build();
    return tx;
  };
  test('the same transaction with a signature passes', async () => {
    const tx = unsigned();
    const signed = await keypairWallet(USER, 'dev-key', 'k').signTransaction(tx.toXDR(), PASS);
    assert.doesNotThrow(() => assertSameTransaction(tx.toXDR(), signed, PASS));
  });
  test('refused: another transaction, or no signature added', () => {
    const tx = unsigned();
    const other = new TransactionBuilder(new Account(USER.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: PASS,
      timebounds: { minTime: 0, maxTime: NOW },
    })
      .addOperation(Operation.payment({ destination: ANCHOR.publicKey(), asset: Asset.native(), amount: '1' }))
      .build();
    other.sign(USER);
    assert.throws(() => assertSameTransaction(tx.toXDR(), other.toXDR(), PASS), WalletError);
    assert.throws(() => assertSameTransaction(tx.toXDR(), tx.toXDR(), PASS), WalletError);
    assert.throws(() => assertSameTransaction(tx.toXDR(), 'garbage', PASS), WalletError);
  });
  test('the key-backed wallet signs exactly the given envelope', async () => {
    const tx = unsigned();
    const signed = TransactionBuilder.fromXDR(
      await keypairWallet(USER, 'demo', 'd').signTransaction(tx.toXDR(), PASS),
      PASS,
    ) as Transaction;
    assert.equal(signed.signatures.length, 1);
    assert.ok(USER.verify(signed.hash(), signed.signatures[0].signature.value));
  });
});

describe("the contract's refusals, by name", () => {
  test('a submission error names the contract error', async () => {
    const { contractError } = await import('@/lib/wallet/sign');
    assert.equal(contractError('HostError: Error(Contract, #17)'), 'WrongStatus');
    assert.equal(contractError('Error(Contract, #999)'), null);
    assert.equal(contractError('tx_bad_auth'), null);
    assert.equal(contractError(null), null);
  });
});
