import { Injectable, Logger } from '@nestjs/common';
import {
  BaseError,
  createPublicClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  numberToHex,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ApiError } from '@/common/api-error';
import type { Deployment } from '@/chain/deployments.service';
import { p2pRevertName } from '@/chain/market-codec';

/** A call the contract would revert: `contractError` names its custom error when known. */
export class ChainCallReverted extends Error {
  constructor(
    readonly contractError: string | null,
    readonly data: Hex | null,
  ) {
    super(`reverted${contractError ? ` (${contractError})` : ''}`);
    this.name = 'ChainCallReverted';
  }
}

/** A log as `eth_getLogs` answers it. */
export interface ChainLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  removed?: boolean;
}

export interface ChainReceipt {
  succeeded: boolean;
  blockNumber: bigint;
}

/** The revert data an RPC error carries, wherever viem nested it. */
export function revertDataOf(err: unknown): Hex | null {
  const pick = (value: unknown): Hex | null => {
    if (typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value) && value.length >= 10) {
      return value as Hex;
    }
    if (value && typeof value === 'object' && 'data' in value) {
      return pick((value as { data: unknown }).data);
    }
    return null;
  };
  let current: unknown = err;
  for (let depth = 0; current && depth < 8; depth++) {
    const found = pick((current as { data?: unknown }).data);
    if (found) return found;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Whether an RPC error is an execution revert (not a node or network failure). */
export function isRevert(err: unknown): boolean {
  if (revertDataOf(err)) return true;
  const text =
    err instanceof BaseError
      ? `${err.shortMessage} ${err.details ?? ''} ${err.message}`
      : String((err as Error)?.message ?? err);
  return /revert/i.test(text);
}

/**
 * Every RPC the market makes, through viem, one client per deployment. Before
 * a client is used its node must answer the deployment's chain id
 * (`eth_chainId`): a node on another chain is refused, never trusted.
 */
@Injectable()
export class ChainClient {
  private readonly logger = new Logger(ChainClient.name);
  private readonly clients = new Map<string, PublicClient>();
  private readonly checked = new Map<string, Promise<void>>();

  private key(d: Deployment): string {
    return `${d.tier}:${d.network}:${d.rpcUrl}`;
  }

  private raw(d: Deployment, timeoutMs = 10_000): PublicClient {
    const key = this.key(d);
    let client = this.clients.get(key);
    if (!client) {
      client = createPublicClient({
        chain: defineChain({
          id: d.chainId,
          name: d.name,
          nativeCurrency: { name: 'Native', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [d.rpcUrl] } },
        }),
        transport: http(d.rpcUrl, { timeout: timeoutMs, retryCount: 1 }),
      });
      this.clients.set(key, client);
    }
    return client;
  }

  /** The client of a deployment whose node answered the right chain id. */
  async client(d: Deployment): Promise<PublicClient> {
    const client = this.raw(d);
    const key = this.key(d);
    let check = this.checked.get(key);
    if (!check) {
      check = client.getChainId().then((id) => {
        if (id !== d.chainId) {
          throw ApiError.unavailable(
            `The market is not available on ${d.name} right now.`,
            `The node for ${d.network}/${d.tier} answered chain id ${id}, not ${d.chainId}.`,
          );
        }
      });
      // A failed check (node down, wrong chain) is tried again on the next call.
      check.catch(() => this.checked.delete(key));
      this.checked.set(key, check);
    }
    await check;
    return client;
  }

  private async request<T>(d: Deployment, method: string, params: unknown[]): Promise<T> {
    const client = await this.client(d);
    return (await client.request({ method, params } as never)) as T;
  }

  /** `eth_call`; a revert is a `ChainCallReverted`. `to` omitted runs init code. */
  async call(d: Deployment, tx: { to?: string; data: Hex; from?: string }): Promise<Hex> {
    try {
      return await this.request<Hex>(d, 'eth_call', [
        {
          ...(tx.to ? { to: getAddress(tx.to) } : {}),
          ...(tx.from ? { from: getAddress(tx.from) } : {}),
          data: tx.data,
        },
        'latest',
      ]);
    } catch (err) {
      throw this.reverted(err);
    }
  }

  async getCode(d: Deployment, address: string): Promise<Hex> {
    return this.request<Hex>(d, 'eth_getCode', [getAddress(address), 'latest']);
  }

  /** `eth_estimateGas`: a call the contract would revert is a `ChainCallReverted`, before anything is signed. */
  async estimateGas(d: Deployment, tx: { from: string; to: string; data: Hex }): Promise<bigint> {
    try {
      return BigInt(
        await this.request<Hex>(d, 'eth_estimateGas', [
          { from: getAddress(tx.from), to: getAddress(tx.to), data: tx.data },
        ]),
      );
    } catch (err) {
      throw this.reverted(err);
    }
  }

  private reverted(err: unknown): unknown {
    if (err instanceof ApiError) return err;
    if (!isRevert(err)) return err;
    const data = revertDataOf(err);
    return new ChainCallReverted(p2pRevertName(data), data);
  }

  async feeData(d: Deployment): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const client = await this.client(d);
    const fees = await client.estimateFeesPerGas();
    return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  }

  /** The next nonce counting the node's pending pool. */
  async pendingNonce(d: Deployment, address: string): Promise<bigint> {
    return BigInt(
      await this.request<Hex>(d, 'eth_getTransactionCount', [getAddress(address), 'pending']),
    );
  }

  /** Transactions of `address` already mined. */
  async minedNonce(d: Deployment, address: string): Promise<bigint> {
    return BigInt(
      await this.request<Hex>(d, 'eth_getTransactionCount', [getAddress(address), 'latest']),
    );
  }

  async sendRawTransaction(d: Deployment, raw: Hex): Promise<Hex> {
    try {
      return await this.request<Hex>(d, 'eth_sendRawTransaction', [raw]);
    } catch (err) {
      // A node that already has these exact bytes answers an error; that is a success.
      if (/already known|known transaction|nonce too low/i.test(String((err as Error).message))) {
        return keccak256(raw);
      }
      throw err;
    }
  }

  async receipt(d: Deployment, hash: Hex): Promise<ChainReceipt | null> {
    const r = await this.request<{ status: Hex; blockNumber: Hex } | null>(
      d,
      'eth_getTransactionReceipt',
      [hash],
    );
    if (!r) return null;
    return { succeeded: r.status === '0x1', blockNumber: BigInt(r.blockNumber) };
  }

  async blockNumber(d: Deployment): Promise<bigint> {
    return BigInt(await this.request<Hex>(d, 'eth_blockNumber', []));
  }

  async blockTimestamp(d: Deployment, block: bigint): Promise<number | null> {
    const b = await this.request<{ timestamp: Hex } | null>(d, 'eth_getBlockByNumber', [
      numberToHex(block),
      false,
    ]);
    return b ? Number(BigInt(b.timestamp)) : null;
  }

  /** The contract's logs with any of `topics` as topic0, in `[from, to]`. */
  async getLogs(d: Deployment, topics: Hex[], from: bigint, to: bigint): Promise<ChainLog[]> {
    return this.request<ChainLog[]>(d, 'eth_getLogs', [
      {
        address: getAddress(d.contract),
        topics: [topics],
        fromBlock: numberToHex(from),
        toBlock: numberToHex(to),
      },
    ]);
  }

  /** Signs an EIP-1559 transaction; answers its raw bytes and hash. Nothing is sent. */
  async sign(
    key: Hex,
    tx: {
      chainId: number;
      nonce: bigint;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      gas: bigint;
      to: string;
      data: Hex;
    },
  ): Promise<{ raw: Hex; hash: Hex }> {
    const account = privateKeyToAccount(key);
    const raw = await account.signTransaction({
      type: 'eip1559',
      chainId: tx.chainId,
      nonce: Number(tx.nonce),
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      gas: tx.gas,
      to: getAddress(tx.to),
      value: 0n,
      data: tx.data,
    });
    return { raw, hash: keccak256(raw) };
  }

  /** For logs: never prints a key. */
  describe(d: Deployment): string {
    return `${d.network}/${d.tier}`;
  }

  warn(message: string): void {
    this.logger.warn(message);
  }
}
