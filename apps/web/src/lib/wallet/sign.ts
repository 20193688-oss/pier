/* One transaction from the API to the network: check it against what the screen promised
   (src/lib/p2p/tx-verify.ts), have the wallet sign it, check the wallet signed that same
   transaction, hand the signed envelope to the API (which fee-bumps it from its sponsor and
   submits it), and follow it until the network settles it. A transaction that fails a check is
   never signed. */
import { MARKET_ERRORS } from '@pier/contracts';
import { verifyTransaction, type TxExpectation, type VerifyProblem } from '@/lib/p2p/tx-verify';
import { assertSameTransaction } from '@/lib/wallet/signed';
import type { StellarWallet } from '@/lib/wallet/types';
import type { P2pNetwork, P2pTransaction } from '@/lib/p2p/types';
import type { SubmitResult } from '@/lib/app/types';

/** The transaction failed a check: nothing was signed. */
export class Refused extends Error {
  readonly problem: VerifyProblem;
  constructor(problem: VerifyProblem) {
    super(`refused: ${problem}`);
    this.name = 'Refused';
    this.problem = problem;
  }
}

/** The market contract's refusal in a submission error (`Error(Contract, #17)`), by name. */
export function contractError(error: string | null): string | null {
  const m = /Error\(Contract, #(\d+)\)/.exec(error ?? '');
  return m ? (MARKET_ERRORS[Number(m[1])] ?? null) : null;
}

/** The network refused the transaction after it was submitted. */
export class SubmitFailed extends Error {
  readonly hash: string;
  /* The contract's error name (WrongStatus, Expired...), when the contract refused it. */
  readonly contractError: string | null;
  constructor(hash: string, error: string | null) {
    super(error ?? 'failed');
    this.name = 'SubmitFailed';
    this.hash = hash;
    this.contractError = contractError(error);
  }
}

export type SignStep = 'checking' | 'signing' | 'submitting' | 'waiting';

export interface Submitter {
  submit: (xdr: string) => Promise<SubmitResult>;
  poll: (hash: string) => Promise<SubmitResult>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Check, sign, submit and follow `tx`. Resolves with the settled (or still pending, after about
    a minute) submission; throws Refused, a WalletError, SubmitFailed or an ApiError. */
export async function signAndSubmit(input: {
  wallet: StellarWallet;
  network: Pick<P2pNetwork, 'id' | 'networkPassphrase' | 'contract' | 'tokens'>;
  tx: P2pTransaction;
  expect: TxExpectation | null;
  via: Submitter;
  onStep?: (step: SignStep) => void;
  pollMs?: number;
  maxWaitMs?: number;
}): Promise<SubmitResult> {
  const { wallet, network, tx, via } = input;
  input.onStep?.('checking');
  const problem = verifyTransaction(tx, { network, wallet: wallet.address }, input.expect);
  if (problem) throw new Refused(problem);
  input.onStep?.('signing');
  const signed = await wallet.signTransaction(tx.xdr, network.networkPassphrase);
  assertSameTransaction(tx.xdr, signed, network.networkPassphrase);
  input.onStep?.('submitting');
  let r = await via.submit(signed);
  input.onStep?.('waiting');
  const until = Date.now() + (input.maxWaitMs ?? 60_000);
  while (r.status === 'PENDING' && Date.now() < until) {
    await sleep(input.pollMs ?? 1500);
    r = await via.poll(r.hash);
  }
  if (r.status === 'FAILED') throw new SubmitFailed(r.hash, r.error);
  return r;
}
