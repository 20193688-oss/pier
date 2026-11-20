import {
  Address,
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
  scValToNative,
  type Transaction as StellarTransaction,
} from '@stellar/stellar-sdk';
import { unwrap, type PedospeClient } from '@/client';
import type { Transaction, TransferMatch } from '@/types';

/**
 * Why the bot must not sign a match's transaction, or null when it is exactly
 * `release(<the bot's account>, <the order's on-chain id>)` on the order's
 * contract (and `MARKET_CONTRACT` when set), for the order's network, from the
 * bot's account, with only source-account authorization and time bounds. The
 * bot decodes what it signs instead of trusting the response: a key that can
 * release can be made to sign anything else.
 */
export function releaseProblem(
  match: TransferMatch,
  options: { signer: string; passphrase: string; marketContract?: string | null },
): string | null {
  const { order, transaction } = match;
  if (transaction.network !== order.network) {
    return `the transaction is for ${transaction.network}, the order is on ${order.network}`;
  }
  let parsed: StellarTransaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(transaction.xdr, options.passphrase);
  } catch {
    return 'the transaction is not an envelope for this network';
  }
  if (parsed instanceof FeeBumpTransaction) return 'the transaction is a fee-bump';
  const tx = parsed;
  if (tx.source !== options.signer) {
    return `the transaction's source is ${tx.source}, not the bot's account ${options.signer}`;
  }
  if (!tx.timeBounds || Number(tx.timeBounds.maxTime) === 0) {
    return 'the transaction has no upper time bound';
  }
  if (tx.operations.length !== 1) return 'the transaction must have exactly one operation';
  const op = tx.operations[0];
  if (op.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract') {
    return 'the operation is not a contract call';
  }
  if (op.source && op.source !== options.signer) return 'the operation acts for another account';
  if ((op.auth ?? []).some((a) => a.credentials.type !== 'sorobanCredentialsSourceAccount')) {
    return 'the call carries authorization other than the source account’s';
  }
  const call = op.func.invokeContract;
  const contract = Address.fromScAddress(call.contractAddress).toString();
  if (contract !== order.contract) {
    return `the transaction calls ${contract}, not the order's contract ${order.contract}`;
  }
  if (options.marketContract && contract !== options.marketContract) {
    return `the transaction calls ${contract}, not MARKET_CONTRACT ${options.marketContract}`;
  }
  if (order.onchainId === null || !/^[0-9]+$/.test(order.onchainId)) {
    return 'the order has no on-chain id yet';
  }
  const fn = String(call.functionName);
  const args = call.args.map((a) => scValToNative(a) as unknown);
  if (
    fn !== 'release' ||
    args.length !== 2 ||
    args[0] !== options.signer ||
    args[1] !== BigInt(order.onchainId)
  ) {
    return `the call is not release(${options.signer}, ${order.onchainId})`;
  }
  return null;
}

/** Signs release transactions with the bot's own key and submits them through the API. */
export interface ReleaseSender {
  /** The bot's account: the merchant's (the API builds releases for the merchant). */
  readonly address: string;
  /** Signs, submits (`POST /v1/p2p/submit`) and waits for the result. */
  send(
    transaction: Transaction,
    passphrase: string,
  ): Promise<{ hash: string; status: 'success' | 'reverted'; error?: string | null }>;
}

/**
 * A sender for the merchant's Stellar secret: it signs the envelope as built
 * and submits it through `/v1/p2p/submit` (the API's sponsor pays the fee when
 * gasless is on), then polls `/v1/p2p/submissions/{hash}`. The secret never
 * leaves the process.
 */
export function createReleaseSender(options: {
  secret: string;
  client: PedospeClient;
  pollMs?: number;
  timeoutMs?: number;
}): ReleaseSender {
  const key = Keypair.fromSecret(options.secret);
  const pollMs = options.pollMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 90_000;
  return {
    address: key.publicKey(),
    async send(transaction, passphrase) {
      const tx = TransactionBuilder.fromXDR(transaction.xdr, passphrase) as StellarTransaction;
      tx.sign(key);
      let sub = await unwrap(
        options.client.POST('/v1/p2p/submit', {
          body: { xdr: tx.toXDR(), network: transaction.network },
        }),
      );
      const until = Date.now() + timeoutMs;
      while (sub.status === 'PENDING' && Date.now() < until) {
        await new Promise((r) => setTimeout(r, pollMs));
        sub = await unwrap(
          options.client.GET('/v1/p2p/submissions/{hash}', {
            params: { path: { hash: sub.hash } },
          }),
        );
      }
      if (sub.status === 'PENDING') {
        throw new Error(`submission ${sub.hash} still pending after ${timeoutMs} ms`);
      }
      return {
        hash: sub.hash,
        status: sub.status === 'SUCCESS' ? 'success' : 'reverted',
        error: sub.error,
      };
    },
  };
}
