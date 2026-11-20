/* The sign-in challenge (SEP-10) is checked before any wallet signs it, against trusted values
   only: never against what the challenge says about itself. Otherwise an API answer could relay
   another service's challenge (an anchor's, say) and the person's signature would log the sender
   into that service as them.

   A challenge is signed only when:
   - it is for the market's network (a known passphrase);
   - it can never be submitted (sequence number 0) and holds only `manage_data` operations;
   - its source is this origin's SEP-10 signing key (SIGNING_KEY of this origin's
     /.well-known/stellar.toml) and it carries a valid signature by that key;
   - its first operation is the signing account's `<home domain> auth` with a 64-byte nonce, where
     the home domain is this app's configured one (VITE_SEP10_HOME_DOMAIN, else this page's host);
   - its `web_auth_domain` operation names this app's web auth domain;
   - it expires within minutes.
   Pure; tests/unit/challenge.test.ts. */
import {
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk/base';
import { isAccount } from '@/lib/stellar/network';

export type ChallengeProblem =
  | 'shape'
  | 'network'
  | 'sequence'
  | 'operations'
  | 'account'
  | 'nonce'
  | 'home-domain'
  | 'web-auth-domain'
  | 'signing-key'
  | 'server-signature'
  | 'time';

/** What a challenge must match: all from this app's own configuration, never from the answer. */
export interface ChallengeExpectation {
  account: string;
  networkPassphrase: string;
  allowedPassphrases: readonly string[];
  homeDomain: string;
  webAuthDomain: string;
  /* The SIGNING_KEY of this origin's stellar.toml. */
  signingKey: string;
}

/** Longest a challenge may stay valid, counted from now (SEP-10 servers use 5 to 15 minutes). */
export const MAX_CHALLENGE_SECONDS = 15 * 60;

type DataOp = { type: 'manageData'; name: string; value?: Uint8Array; source?: string };

function signedBy(tx: Transaction, address: string): boolean {
  const kp = Keypair.fromPublicKey(address);
  const h = tx.hash();
  return tx.signatures.some((s) => {
    try {
      return kp.verify(h, s.signature.value);
    } catch {
      return false;
    }
  });
}

/** Null when `account` may sign the challenge, else why not. */
export function checkChallenge(
  challengeXdr: string,
  e: ChallengeExpectation,
  nowSeconds = Math.floor(Date.now() / 1000),
): ChallengeProblem | null {
  if (!e.allowedPassphrases.includes(e.networkPassphrase)) return 'network';
  if (!isAccount(e.signingKey) || !e.homeDomain || !e.webAuthDomain) return 'signing-key';
  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(challengeXdr, e.networkPassphrase);
    if (parsed instanceof FeeBumpTransaction) return 'shape';
    tx = parsed;
  } catch {
    return 'shape';
  }
  if (tx.sequence !== '0') return 'sequence';
  if (tx.source !== e.signingKey) return 'signing-key';
  if (!signedBy(tx, e.signingKey)) return 'server-signature';
  const ops = tx.operations;
  if (!ops.length || ops.some((op) => op.type !== 'manageData')) return 'operations';
  const [first, ...rest] = ops as DataOp[];
  if (first.source !== e.account) return 'account';
  if (first.name !== `${e.homeDomain} auth`) return 'home-domain';
  if (!first.value || first.value.length !== 64) return 'nonce';
  // Every other operation is the server's (web_auth_domain and the like) or, for a wallet proof,
  // the entry binding the organization: manage_data only, in a transaction that cannot run.
  if (rest.some((op) => op.source !== tx.source && op.source !== e.account)) return 'operations';
  const web = rest.filter((op) => op.name === 'web_auth_domain');
  if (
    web.length !== 1 ||
    web[0].source !== tx.source ||
    !web[0].value ||
    new TextDecoder().decode(web[0].value) !== e.webAuthDomain
  )
    return 'web-auth-domain';
  const max = Number(tx.timeBounds?.maxTime ?? 0);
  const min = Number(tx.timeBounds?.minTime ?? 0);
  if (!max || max <= nowSeconds || max > nowSeconds + MAX_CHALLENGE_SECONDS || min > nowSeconds + 60)
    return 'time';
  return null;
}

/** The SIGNING_KEY of a stellar.toml (a top-level `SIGNING_KEY = "G..."`), or null. Only the
    top-level table counts: a key under `[[CURRENCIES]]` or any other table is not this one. */
export function signingKeyOf(toml: string): string | null {
  let topLevel = true;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) topLevel = false;
    if (!topLevel) continue;
    const m = /^SIGNING_KEY\s*=\s*"([A-Z2-7]{56})"\s*(#.*)?$/.exec(line);
    if (m) return isAccount(m[1]) ? m[1] : null;
  }
  return null;
}
