/* What the page asks of the person's own wallet, through viem over the wallet's EIP-1193 provider:
   connect, sign the sign-in message (EIP-4361), switch to the order's network, send a transaction
   the page has already checked, and wait for it. The page never holds a key; every signature and
   transaction is approved in the wallet. */
import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  numberToHex,
  type Hex,
} from 'viem';
import { createSiweMessage } from 'viem/siwe';
import type { Eip1193Provider } from '@/lib/wallet/eip6963';
import type { P2pTransaction } from '@/lib/p2p/types';

/** The wallet's error, by kind: the person said no, or something else went wrong. */
export class WalletError extends Error {
  readonly kind: 'rejected' | 'chain' | 'reverted' | 'failed';
  constructor(kind: WalletError['kind'], message: string = kind) {
    super(message);
    this.name = 'WalletError';
    this.kind = kind;
  }
}

const codeOf = (e: unknown): number | null => {
  const c =
    (e as { code?: unknown; cause?: { code?: unknown } })?.code ??
    (e as { cause?: { code?: unknown } })?.cause?.code;
  return typeof c === 'number' ? c : null;
};
const asWalletError = (e: unknown): WalletError => {
  if (e instanceof WalletError) return e;
  const code = codeOf(e);
  if (code === 4001 || /reject|denied|cancel/i.test(String((e as Error)?.message ?? '')))
    return new WalletError('rejected');
  return new WalletError('failed', String((e as Error)?.message ?? 'failed').slice(0, 200));
};

/** Ask the wallet for its accounts; the first is the one the person picked. */
export async function connectWallet(provider: Eip1193Provider): Promise<`0x${string}`> {
  try {
    const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
    if (!Array.isArray(accounts) || !accounts[0]) throw new WalletError('failed', 'no account');
    return getAddress(accounts[0]);
  } catch (e) {
    throw asWalletError(e);
  }
}

export async function currentChainId(provider: Eip1193Provider): Promise<number> {
  const hex = (await provider.request({ method: 'eth_chainId' })) as string;
  return Number.parseInt(hex, 16);
}

export interface SiweInput {
  address: `0x${string}`;
  nonce: string;
  statement: string;
  chainId: number;
  domain?: string;
  uri?: string;
  now?: Date;
}

/** The sign-in message (EIP-4361) for this site: its host, its origin, the server's nonce, ten
    minutes to use it. */
export function siweMessage(input: SiweInput): string {
  const now = input.now ?? new Date();
  return createSiweMessage({
    domain: input.domain ?? window.location.host,
    uri: input.uri ?? window.location.origin,
    address: getAddress(input.address),
    statement: input.statement,
    version: '1',
    chainId: input.chainId,
    nonce: input.nonce,
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 10 * 60_000),
  });
}

/** EIP-191 `personal_sign` of a text message by `address`. */
export async function signText(
  provider: Eip1193Provider,
  address: `0x${string}`,
  message: string,
): Promise<Hex> {
  try {
    const client = createWalletClient({ transport: custom(provider) });
    return await client.signMessage({ account: address, message });
  } catch (e) {
    throw asWalletError(e);
  }
}

export interface ChainParams {
  chainId: number;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
}

/** Switch the wallet to `chainId`, adding the network first when the wallet does not know it and
    the market says how. */
export async function ensureChain(
  provider: Eip1193Provider,
  chainId: number,
  add?: ChainParams,
): Promise<void> {
  if ((await currentChainId(provider)) === chainId) return;
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: numberToHex(chainId) }],
    });
  } catch (e) {
    if (codeOf(e) === 4902 && add) {
      try {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [{ ...add, chainId: numberToHex(chainId) }],
        });
      } catch (e2) {
        throw asWalletError(e2);
      }
    } else {
      const err = asWalletError(e);
      throw err.kind === 'rejected' ? err : new WalletError('chain');
    }
  }
  if ((await currentChainId(provider)) !== chainId) throw new WalletError('chain');
}

/** Send a transaction the page already checked (src/lib/p2p/tx-verify.ts), from `from`, on its
    chain; nothing is paid in the native coin. Returns the hash. */
export async function sendTransaction(
  provider: Eip1193Provider,
  from: `0x${string}`,
  tx: P2pTransaction,
): Promise<Hex> {
  try {
    const client = createWalletClient({ transport: custom(provider) });
    return await client.sendTransaction({
      account: from,
      chain: null,
      to: getAddress(tx.to),
      data: tx.data as Hex,
      value: 0n,
    });
  } catch (e) {
    throw asWalletError(e);
  }
}

/** Wait until the network includes `hash`; a reverted transaction is an error. */
export async function waitForTransaction(provider: Eip1193Provider, hash: Hex): Promise<void> {
  const client = createPublicClient({ transport: custom(provider) });
  const receipt = await client.waitForTransactionReceipt({
    hash,
    pollingInterval: 1500,
    timeout: 180_000,
  });
  if (receipt.status !== 'success') throw new WalletError('reverted');
}
