/* The sign-in challenge (SEP-10) is checked before any wallet signs it: a server that wanted a
   payment signed could dress it as a challenge. A real challenge can never be submitted
   (sequence number 0), holds only `manage_data` operations, names the signing account in its
   first operation (`<home domain> auth`, a random nonce), and expires within minutes. Anything
   else is refused. Pure; tests/unit/wallet.test.ts. */
import { FeeBumpTransaction, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk/base';

export type ChallengeProblem =
  | 'shape'
  | 'network'
  | 'sequence'
  | 'operations'
  | 'account'
  | 'nonce'
  | 'time';

export interface ChallengeInfo {
  /* The home domain the first operation names (`<domain> auth`). */
  homeDomain: string;
  /* The `web_auth_domain` operation's value, when the challenge has one. */
  webAuthDomain: string | null;
  /* The server's signing account: the challenge's source. */
  serverAccount: string;
}

/** Longest a challenge may stay valid, counted from now (SEP-10 servers use 5 to 15 minutes). */
export const MAX_CHALLENGE_SECONDS = 15 * 60;

/** The challenge's details when `account` may sign it on `networkPassphrase`, else why not. */
export function checkChallenge(
  challengeXdr: string,
  input: { account: string; networkPassphrase: string; allowedPassphrases: readonly string[] },
  nowSeconds = Math.floor(Date.now() / 1000),
): { ok: true; info: ChallengeInfo } | { ok: false; problem: ChallengeProblem } {
  if (!input.allowedPassphrases.includes(input.networkPassphrase))
    return { ok: false, problem: 'network' };
  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(challengeXdr, input.networkPassphrase);
    if (parsed instanceof FeeBumpTransaction) return { ok: false, problem: 'shape' };
    tx = parsed;
  } catch {
    return { ok: false, problem: 'shape' };
  }
  if (tx.sequence !== '0') return { ok: false, problem: 'sequence' };
  if (tx.source === input.account) return { ok: false, problem: 'account' };
  const ops = tx.operations;
  if (!ops.length || ops.some((op) => op.type !== 'manageData'))
    return { ok: false, problem: 'operations' };
  const [first, ...rest] = ops as { type: 'manageData'; name: string; value?: Uint8Array; source?: string }[];
  if (first.source !== input.account) return { ok: false, problem: 'account' };
  const match = /^(.+) auth$/.exec(first.name);
  if (!match || !first.value || first.value.length !== 64) return { ok: false, problem: 'nonce' };
  // Every other operation is the server's (web_auth_domain and the like) or, for a wallet proof,
  // the entry binding the organization; manage_data only, in a transaction that cannot run.
  if (rest.some((op) => op.source !== tx.source && op.source !== input.account))
    return { ok: false, problem: 'operations' };
  const max = Number(tx.timeBounds?.maxTime ?? 0);
  const min = Number(tx.timeBounds?.minTime ?? 0);
  if (!max || max <= nowSeconds || max > nowSeconds + MAX_CHALLENGE_SECONDS || min > nowSeconds + 60)
    return { ok: false, problem: 'time' };
  const web = rest.find((op) => op.name === 'web_auth_domain');
  return {
    ok: true,
    info: {
      homeDomain: match[1],
      webAuthDomain: web?.value ? new TextDecoder().decode(web.value) : null,
      serverAccount: tx.source,
    },
  };
}
