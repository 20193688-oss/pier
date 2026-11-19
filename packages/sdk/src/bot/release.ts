import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  isAddress,
  isAddressEqual,
  type Address,
  type Hex,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Transaction, TransferMatch } from '@/types';

/** `P2PMarket.release(uint256 id)`: the only call this bot signs. */
const RELEASE_ABI = [
  {
    type: 'function',
    name: 'release',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [],
  },
] as const;

const DIGITS = /^[0-9]+$/;

/**
 * Why the bot must not sign a match's transaction, or null when it is exactly
 * `release(<the order's on-chain id>)` on the order's contract and chain,
 * with no value. The bot checks what it signs instead of trusting the
 * response: a key that can release can be made to sign anything else.
 */
export function releaseProblem(
  match: TransferMatch,
  options: { marketContract?: Address | null } = {},
): string | null {
  const { order, transaction: tx } = match;
  if (tx.chainId !== order.chainId) {
    return `the transaction is for chain ${tx.chainId}, the order is on chain ${order.chainId}`;
  }
  if (!isAddress(tx.to, { strict: false }) || !isAddress(order.contract, { strict: false })) {
    return 'the transaction or the order names an invalid contract address';
  }
  if (!isAddressEqual(tx.to, order.contract)) {
    return `the transaction calls ${tx.to}, not the order's contract ${order.contract}`;
  }
  if (options.marketContract && !isAddressEqual(tx.to, options.marketContract)) {
    return `the transaction calls ${tx.to}, not MARKET_CONTRACT ${options.marketContract}`;
  }
  if (!DIGITS.test(tx.value) || BigInt(tx.value) !== 0n) {
    return `the transaction sends value ${tx.value}; a release sends none`;
  }
  if (order.onchainId === null || !DIGITS.test(order.onchainId)) {
    return 'the order has no on-chain id yet';
  }
  const expected = encodeFunctionData({
    abi: RELEASE_ABI,
    functionName: 'release',
    args: [BigInt(order.onchainId)],
  });
  if (tx.data.toLowerCase() !== expected) {
    return `the calldata is not release(${order.onchainId})`;
  }
  return null;
}

/** The node behind RPC_URL is on another chain than the transaction names. */
export class ChainMismatchError extends Error {
  override readonly name = 'ChainMismatchError';

  constructor(
    readonly expectedChainId: number,
    readonly nodeChainId: number,
  ) {
    super(
      `RPC_URL serves chain ${nodeChainId}, the transaction is for chain ${expectedChainId}: refusing to send.`,
    );
  }
}

/** Signs and sends release transactions with the bot's own key. */
export interface ReleaseSender {
  /** The bot's address (the merchant's wallet, or an operator it gave PERM_RELEASE). */
  readonly address: Address;
  /** Sends the transaction and waits for its receipt. */
  send(transaction: Transaction): Promise<{ hash: Hex; status: 'success' | 'reverted' }>;
}

/**
 * A sender for `privateKey` through the node at `rpcUrl`. Each send builds the
 * chain from the transaction's `chainId` and refuses (`ChainMismatchError`)
 * when the node's `eth_chainId` is another one. `transport` replaces the HTTP
 * transport (tests).
 */
export function createReleaseSender(options: {
  privateKey: Hex;
  rpcUrl: string;
  transport?: Transport;
}): ReleaseSender {
  const account = privateKeyToAccount(options.privateKey);
  const transport = options.transport ?? http(options.rpcUrl);
  return {
    address: account.address,
    async send(transaction) {
      const chain = defineChain({
        id: transaction.chainId,
        name: `Chain ${transaction.chainId}`,
        nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
        rpcUrls: { default: { http: [options.rpcUrl] } },
      });
      const publicClient = createPublicClient({ chain, transport });
      const nodeChainId = await publicClient.getChainId();
      if (nodeChainId !== transaction.chainId) {
        throw new ChainMismatchError(transaction.chainId, nodeChainId);
      }
      const wallet = createWalletClient({ account, chain, transport });
      const hash = await wallet.sendTransaction({
        to: transaction.to as Address,
        data: transaction.data as Hex,
        value: BigInt(transaction.value),
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return { hash, status: receipt.status };
    },
  };
}
