import {
  Address,
  FeeBumpTransaction,
  Keypair,
  Networks,
  TransactionBuilder,
  scValToNative,
  xdr,
  type Transaction as StellarTransaction,
} from '@stellar/stellar-sdk';
import { unwrap, type PierClient } from '@/client';
import type { MerchantOrder, Transaction, TransferMatch } from '@/types';

/**
 * The networks the bot signs for, with their passphrases pinned HERE (never
 * taken from an API answer), and the tier each belongs to.
 */
export const BOT_NETWORKS: Readonly<Record<string, { passphrase: string; tier: 'live' | 'test' }>> =
  {
    mainnet: { passphrase: Networks.PUBLIC, tier: 'live' },
    testnet: { passphrase: Networks.TESTNET, tier: 'test' },
    local: { passphrase: Networks.STANDALONE, tier: 'test' },
  };

/** A release must expire within this many seconds (the API builds them 5 minutes ahead). */
export const MAX_RELEASE_TTL_SECONDS = 360;
/** The default cap on a release's total fee (resource fee included), stroops: 0.1 XLM. */
export const DEFAULT_MAX_FEE_STROOPS = 1_000_000;

export interface ReleaseCheck {
  /** The bot's own account: the merchant's, or an operator it granted PERM_RELEASE. */
  signer: string;
  /** The network id the order names. */
  network: string;
  /** The bot's tier, from its API key's prefix. */
  tier: 'live' | 'test';
  /** The market contract per network id, from the bot's OWN configuration. */
  marketContracts: Readonly<Record<string, string>>;
  /** The largest fee the bot signs, stroops. */
  maxFeeStroops: number;
  /** Unix seconds now. */
  now?: number;
}

/**
 * The market calls a merchant's bot signs on one order, each `fn(caller, id)`
 * by the order's merchant: `accept` a sale or a QR payment (locks its bond
 * from its balance), `mark_paid` once it paid the local money, `release` a
 * purchase once the local money arrived.
 */
export const MERCHANT_ORDER_ACTIONS = ['accept', 'mark_paid', 'release'] as const;
export type MerchantOrderAction = (typeof MERCHANT_ORDER_ACTIONS)[number];

/** The one call the bot signs: `fn(signer, id)` on `contract`, as an auth function. */
function expectedAuthFunction(
  contract: string,
  fn: MerchantOrderAction,
  signer: string,
  id: bigint,
): string {
  return xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contract).toScAddress(),
      functionName: fn,
      args: [new Address(signer).toScVal(), xdr.ScVal.scvU64(id)],
    }),
  ).toXdr('base64');
}

/**
 * Why the bot must not sign a match's transaction, or null when it is exactly
 * what it expects. Every API answer is untrusted: the network, contract and
 * passphrase come from the bot's own configuration, and the envelope must be
 * exactly ONE `release(<the bot's account>, <the order's on-chain id>)` on
 * that contract, from the bot's account, with no memo, no preconditions but a
 * near upper time bound, a fee under the cap, and either no auth entries or
 * one source-account entry for that same call with no sub-invocations (a
 * sub-invocation could move the bot's tokens).
 */
export function releaseProblem(match: TransferMatch, check: ReleaseCheck): string | null {
  return orderActionProblem(match, 'release', check);
}

/**
 * {@link releaseProblem} for any of the merchant's order calls
 * ({@link MERCHANT_ORDER_ACTIONS}): the transaction must be exactly ONE
 * `fn(<the bot's account>, <the order's on-chain id>)` on the bot's own market
 * contract, under the same rules (source, memo, bounds, fee, auth with no
 * sub-invocations).
 */
export function orderActionProblem(
  subject: {
    order: Pick<MerchantOrder, 'network' | 'onchainId'>;
    transaction: Transaction;
  },
  fn: MerchantOrderAction,
  check: ReleaseCheck,
): string | null {
  const { order, transaction } = subject;
  const network = BOT_NETWORKS[check.network];
  if (!network) return `the bot does not sign for the network ${check.network}`;
  if (network.tier !== check.tier) {
    return `a ${check.tier} API key never signs on ${check.network}`;
  }
  if (transaction.network !== check.network || order.network !== check.network) {
    return `the transaction or the order is not on ${check.network}`;
  }
  const contract = check.marketContracts[check.network];
  if (!contract) return `MARKET_CONTRACT names no contract for ${check.network}`;
  if (order.onchainId === null || !/^[0-9]+$/.test(order.onchainId)) {
    return 'the order has no on-chain id yet';
  }
  const id = BigInt(order.onchainId);

  let parsed: StellarTransaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(transaction.xdr, network.passphrase);
  } catch {
    return 'the transaction is not an envelope';
  }
  if (parsed instanceof FeeBumpTransaction) return 'the transaction is a fee-bump';
  const tx = parsed;
  if (tx.source !== check.signer) {
    return `the transaction's source is ${tx.source}, not the bot's account ${check.signer}`;
  }
  if (tx.memo.type !== 'none') return 'the transaction carries a memo';
  const now = check.now ?? Math.floor(Date.now() / 1000);
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (!maxTime || maxTime > now + MAX_RELEASE_TTL_SECONDS) {
    return `the transaction must expire within ${MAX_RELEASE_TTL_SECONDS} seconds`;
  }
  if (
    tx.ledgerBounds ||
    (tx.minAccountSequence !== undefined && tx.minAccountSequence !== null) ||
    Number(tx.minAccountSequenceAge ?? 0) !== 0 ||
    Number(tx.minAccountSequenceLedgerGap ?? 0) !== 0 ||
    (tx.extraSigners ?? []).length > 0
  ) {
    return 'the transaction carries preconditions other than its time bounds';
  }
  if (Number(tx.fee) > check.maxFeeStroops) {
    return `the transaction's fee (${tx.fee} stroops) is above the cap (${check.maxFeeStroops})`;
  }
  if (tx.operations.length !== 1) return 'the transaction must have exactly one operation';
  const op = tx.operations[0];
  if (op.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract') {
    return 'the operation is not a contract call';
  }
  if (op.source && op.source !== check.signer) return 'the operation acts for another account';
  const call = op.func.invokeContract;
  const target = Address.fromScAddress(call.contractAddress).toString();
  if (target !== contract) {
    return `the transaction calls ${target}, not MARKET_CONTRACT ${contract}`;
  }
  const args = call.args.map((a) => scValToNative(a) as unknown);
  if (
    String(call.functionName) !== fn ||
    args.length !== 2 ||
    args[0] !== check.signer ||
    args[1] !== id
  ) {
    return `the call is not ${fn}(${check.signer}, ${order.onchainId})`;
  }
  const auth = op.auth ?? [];
  if (auth.length > 1) return 'the call carries more than one authorization';
  if (auth.length === 1) {
    const [entry] = auth;
    if (entry.credentials.type !== 'sorobanCredentialsSourceAccount') {
      return 'the call carries authorization other than the source account’s';
    }
    const root = entry.rootInvocation;
    if (root.subInvocations.length > 0) {
      return 'the authorization covers sub-invocations';
    }
    if (root.function.toXdr('base64') !== expectedAuthFunction(contract, fn, check.signer, id)) {
      return 'the authorization is for another call';
    }
  }
  return null;
}

/** Signs release transactions with the bot's own key and submits them through the API. */
export interface ReleaseSender {
  /** The bot's account: the merchant's, or an operator it granted PERM_RELEASE. */
  readonly address: string;
  /** Signs for `passphrase` (the bot's own), submits (`POST /v1/p2p/submit`) and waits. */
  send(
    transaction: Transaction,
    passphrase: string,
  ): Promise<{ hash: string; status: 'success' | 'reverted'; error?: string | null }>;
}

/**
 * A sender for the bot's Stellar secret: it signs the envelope as checked and
 * submits it through `/v1/p2p/submit` (the API's sponsor pays the fee when
 * gasless is on), then polls `/v1/p2p/submissions/{hash}`. The secret never
 * leaves the process.
 */
export function createReleaseSender(options: {
  secret: string;
  client: PierClient;
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
