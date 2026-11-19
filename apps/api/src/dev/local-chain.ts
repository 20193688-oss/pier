import { P2P_MARKET_ARTIFACT } from '@pedospe/contracts';
import { compileContract } from '@pedospe/contracts/testing';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  toHex,
  type Abi,
  type Hex,
  type PublicClient,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { DEV_CHAIN_ID } from '@/chain/networks';

/**
 * The local dev chain: the standard development mnemonic's wallets, each with
 * a role, and the deployment of `P2PMarket` plus a mintable test dollar. Every
 * function here refuses a node that is not chain 31337: these keys are public
 * and must never touch a real network.
 */

export const DEV_MNEMONIC = 'test test test test test test test test test test test junk';

/** Which dev wallet plays which part. */
export const DEV_ROLES = {
  owner: 0,
  matcher: 1,
  merchant: 2,
  business: 3,
  user: 4,
  arbiter: 5,
  treasury: 6,
} as const;
export type DevRole = keyof typeof DEV_ROLES;

export interface DevWallet {
  role: DevRole;
  address: Hex;
  privateKey: Hex;
}

export function devWallet(role: DevRole): DevWallet {
  const hd = mnemonicToAccount(DEV_MNEMONIC, { addressIndex: DEV_ROLES[role] });
  const key = hd.getHdKey().privateKey;
  if (!key) throw new Error('dev key not derived');
  return { role, address: hd.address, privateKey: toHex(key) };
}

export function devWallets(): DevWallet[] {
  return (Object.keys(DEV_ROLES) as DevRole[]).map(devWallet);
}

const devChain = (rpcUrl: string) =>
  defineChain({
    id: DEV_CHAIN_ID,
    name: 'Local dev chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

/** A public client of the dev node, after checking it is chain 31337. */
export async function devPublicClient(rpcUrl: string): Promise<PublicClient> {
  const client = createPublicClient({ chain: devChain(rpcUrl), transport: http(rpcUrl) });
  const id = await client.getChainId();
  if (id !== DEV_CHAIN_ID) {
    throw new Error(`Refusing ${rpcUrl}: it is chain ${id}, not the dev chain ${DEV_CHAIN_ID}`);
  }
  return client;
}

/** Sends one transaction from a dev wallet and waits for it to be mined (reverts throw). */
export async function devSend(rpcUrl: string, key: Hex, tx: { to: Hex; data: Hex }): Promise<Hex> {
  const client = await devPublicClient(rpcUrl);
  const account: PrivateKeyAccount = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: devChain(rpcUrl), transport: http(rpcUrl) });
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: 0n });
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 50 });
  if (receipt.status !== 'success') throw new Error(`dev transaction ${hash} reverted`);
  return hash;
}

const TEST_TOKEN_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

/** Gives a wallet gas money and test dollars on the dev chain (from the owner, who may mint). */
export async function fundDevWallet(
  rpcUrl: string,
  token: Hex,
  address: Hex,
  tokens: bigint,
): Promise<void> {
  const client = await devPublicClient(rpcUrl);
  const owner = devWallet('owner');
  const wallet = createWalletClient({
    account: privateKeyToAccount(owner.privateKey),
    chain: devChain(rpcUrl),
    transport: http(rpcUrl),
  });
  const hash = await wallet.sendTransaction({ to: address, value: 10n ** 18n });
  await client.waitForTransactionReceipt({ hash, pollingInterval: 50 });
  if (tokens > 0n) {
    const { encodeFunctionData } = await import('viem');
    await devSend(rpcUrl, owner.privateKey, {
      to: token,
      data: encodeFunctionData({
        abi: TEST_TOKEN_ABI,
        functionName: 'mint',
        args: [address, tokens],
      }),
    });
  }
}

export interface LocalDeployment {
  market: Hex;
  token: Hex;
  tokenSymbol: string;
  tokenDecimals: number;
  deployBlock: number;
  feeBps: number;
}

/**
 * Deploys `P2PMarket` (owner, arbiter and treasury are dev wallets) and the
 * test dollar (`P2PTestToken`, 6 decimals, anyone may mint), allows the token,
 * and mints `mintPerWallet` to the merchant, the business and the user.
 */
export async function deployLocalMarket(
  rpcUrl: string,
  options: { feeBps?: number; mintPerWallet?: bigint } = {},
): Promise<LocalDeployment> {
  const client = await devPublicClient(rpcUrl);
  const owner = devWallet('owner');
  const wallet = createWalletClient({
    account: privateKeyToAccount(owner.privateKey),
    chain: devChain(rpcUrl),
    transport: http(rpcUrl),
  });
  const feeBps = options.feeBps ?? 50;
  const deployBlock = Number(await client.getBlockNumber());

  const marketHash = await wallet.deployContract({
    abi: P2P_MARKET_ARTIFACT.abi as unknown as Abi,
    bytecode: P2P_MARKET_ARTIFACT.bytecode as Hex,
    args: [owner.address, devWallet('treasury').address, devWallet('arbiter').address, feeBps],
  });
  const market = (await client.waitForTransactionReceipt({ hash: marketHash, pollingInterval: 50 }))
    .contractAddress as Hex;

  const tokenSource = compileContract('test/P2PTestToken.sol', 'P2PTestToken');
  const tokenHash = await wallet.deployContract({
    abi: tokenSource.abi,
    bytecode: tokenSource.bytecode,
  });
  const token = (await client.waitForTransactionReceipt({ hash: tokenHash, pollingInterval: 50 }))
    .contractAddress as Hex;

  const { p2pCalldata } = await import('@/chain/market-codec');
  await devSend(rpcUrl, owner.privateKey, { to: market, data: p2pCalldata.setToken(token, true) });

  const mint = options.mintPerWallet ?? 1_000_000n * 1_000_000n;
  const { encodeFunctionData } = await import('viem');
  for (const role of ['merchant', 'business', 'user'] as const) {
    await devSend(rpcUrl, owner.privateKey, {
      to: token,
      data: encodeFunctionData({
        abi: TEST_TOKEN_ABI,
        functionName: 'mint',
        args: [devWallet(role).address, mint],
      }),
    });
  }
  return { market, token, tokenSymbol: 'tUSD', tokenDecimals: 6, deployBlock, feeBps };
}
