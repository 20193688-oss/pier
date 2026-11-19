import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { P2P_MARKET_ARTIFACT } from '@pedospe/contracts';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  type Abi,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeView, marketInitCode, p2pCalldata } from '@/chain/market-codec';
import { isNetworkId, isTier, NETWORKS, type Tier } from '@/chain/networks';
import { P2P_MAX_PROTOCOL_FEE_BPS } from '@/p2p/domain/constants';

/**
 * Deploys `P2PMarket` (the committed artifact) on ONE network and tier, or
 * verifies a deployment that exists, and prints the environment entries the
 * API reads.
 *
 *   npm run deploy:contract -w @pedospe/api -- --network base --tier test \
 *     --secrets-file C:/Users/<you>/.pedospe/deployer.json \
 *     --treasury 0x... --arbiter 0x... --fee-bps 50 [--owner 0x...] [--rpc <url>]
 *   ... --contract 0x...                    verify only
 *   ... --tier live --i-understand-mainnet  mainnet (also needs --owner and --rpc)
 *
 * The secrets file (outside every repository) is `{ "deployerPrivateKey":
 * "0x..." }`; the key is never printed. The node's `eth_chainId` must be the
 * network's on that tier before anything is signed.
 *
 *   - test: the deployer owns the contract while it allows the listed tokens
 *     (`setToken`), then hands ownership to `--owner` when given (that wallet
 *     then calls `acceptOwnership`).
 *   - live: `--owner` (a multisig) owns it from construction, and the script
 *     PRINTS the `setToken` calls for the owner to send. The deployer never
 *     owns a mainnet market.
 */

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

function fail(message: string): never {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

function address(name: string, value: string | undefined): Hex {
  if (!value || !isAddress(value, { strict: false })) fail(`--${name} must be an EVM address`);
  return getAddress(value);
}

/** The repository that holds this script: a secrets file must live outside it. */
function repositoryRoot(): string | null {
  let dir = realpathSync(dirname(fileURLToPath(import.meta.url)));
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function deployerKey(path: string): Hex {
  const full = resolve(path);
  if (!existsSync(full)) fail(`no secrets file at ${full}`);
  const real = realpathSync(full);
  const repo = repositoryRoot();
  if (repo && (real === repo || real.startsWith(`${repo}${sep}`))) {
    fail(`the secrets file must live outside the repository (${repo})`);
  }
  const parsed = JSON.parse(readFileSync(real, 'utf8')) as { deployerPrivateKey?: unknown };
  if (typeof parsed.deployerPrivateKey !== 'string' || !KEY_RE.test(parsed.deployerPrivateKey)) {
    fail('the secrets file has no valid deployerPrivateKey (0x + 64 hex)');
  }
  return parsed.deployerPrivateKey as Hex;
}

async function verify(
  client: PublicClient,
  contract: Hex,
  tokens: readonly { symbol: string; address: string }[],
): Promise<boolean> {
  const code = await client.getCode({ address: contract });
  const expected = await client.call({
    data: marketInitCode({
      owner: '0x0000000000000000000000000000000000000001',
      treasury: '0x0000000000000000000000000000000000000002',
      arbiter: '0x0000000000000000000000000000000000000003',
      feeBps: 0,
    }),
  });
  const matches = !!code && code.toLowerCase() === (expected.data ?? '').toLowerCase();
  console.log(
    `  bytecode:      ${matches ? 'matches the artifact' : 'DOES NOT match the artifact'}`,
  );
  if (!matches) return false;
  const read = async <T>(name: string, data: Hex) =>
    decodeView<T>(name, (await client.call({ to: contract, data })).data ?? '0x');
  console.log(`  owner:         ${await read<string>('owner', p2pCalldata.owner())}`);
  console.log(`  arbiter:       ${await read<string>('arbiter', p2pCalldata.arbiter())}`);
  console.log(`  treasury:      ${await read<string>('treasury', p2pCalldata.treasury())}`);
  console.log(
    `  protocol fee:  ${await read<number>('protocolFeeBps', p2pCalldata.protocolFeeBps())} bps`,
  );
  let all = true;
  for (const t of tokens) {
    const allowed = await read<boolean>('tokenAllowed', p2pCalldata.tokenAllowed(t.address));
    all &&= allowed;
    console.log(
      `  ${t.symbol.padEnd(14)} ${allowed ? 'allowed' : 'NOT allowed (owner must setToken)'}`,
    );
  }
  return all;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      network: { type: 'string' },
      tier: { type: 'string' },
      'secrets-file': { type: 'string' },
      owner: { type: 'string' },
      treasury: { type: 'string' },
      arbiter: { type: 'string' },
      'fee-bps': { type: 'string' },
      rpc: { type: 'string' },
      contract: { type: 'string' },
      'i-understand-mainnet': { type: 'boolean', default: false },
    },
  });
  const network = values.network;
  const tier = values.tier;
  if (!isNetworkId(network) || network === 'local') {
    fail(
      '--network must be a network id (eth, base, arb, op, pol, bsc, avax, monad); the local chain is deployed by npm run dev:stack',
    );
  }
  if (!isTier(tier)) fail('--tier must be test or live');
  const entry = NETWORKS[network].tiers[tier as Tier];
  if (!entry) fail(`${network} has no ${tier} network`);
  const live = tier === 'live';
  if (live && !values['i-understand-mainnet']) {
    fail('mainnet needs --i-understand-mainnet: this deploys a contract that will hold real money');
  }
  const rpcUrl = values.rpc ?? entry.defaultRpcUrl;
  if (!rpcUrl) fail(`--rpc is required for ${network} on ${tier}`);

  const chain = defineChain({
    id: entry.chainId,
    name: NETWORKS[network].name,
    nativeCurrency: { name: 'Native', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== entry.chainId)
    fail(`the node answers chain ${chainId}, not ${network}'s ${entry.chainId}`);
  console.log(`${NETWORKS[network].name} (${tier}), chain ${chainId}`);

  if (values.contract) {
    const contract = address('contract', values.contract);
    console.log(`Verifying ${contract}`);
    const ok = await verify(client, contract, entry.tokens);
    process.exit(ok ? 0 : 1);
  }

  const key = deployerKey(values['secrets-file'] ?? fail('--secrets-file is required'));
  const deployer = privateKeyToAccount(key);
  const treasury = address('treasury', values.treasury);
  const arbiter = address('arbiter', values.arbiter);
  const feeBps = Number(values['fee-bps'] ?? fail('--fee-bps is required'));
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > P2P_MAX_PROTOCOL_FEE_BPS) {
    fail(`--fee-bps must be 0..${P2P_MAX_PROTOCOL_FEE_BPS}`);
  }
  const finalOwner = values.owner ? address('owner', values.owner) : null;
  if (live && !finalOwner) fail('mainnet needs --owner (a multisig): the deployer never owns it');
  const constructionOwner = live ? (finalOwner as Hex) : deployer.address;

  const wallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
  console.log(`Deployer ${deployer.address}; owner at construction ${constructionOwner}`);
  const hash = await wallet.deployContract({
    abi: P2P_MARKET_ARTIFACT.abi as unknown as Abi,
    bytecode: P2P_MARKET_ARTIFACT.bytecode as Hex,
    args: [constructionOwner, treasury, arbiter, feeBps],
  });
  console.log(`Deploy tx ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) fail('the deployment reverted');
  const contract = getAddress(receipt.contractAddress);
  console.log(`P2PMarket at ${contract} (block ${receipt.blockNumber})`);

  if (live) {
    console.log('\nThe owner must now allow the tokens. Send from the owner:');
    for (const t of entry.tokens) {
      console.log(`  ${t.symbol}: to ${contract} data ${p2pCalldata.setToken(t.address, true)}`);
    }
  } else {
    for (const t of entry.tokens) {
      const tx = await wallet.sendTransaction({
        to: contract,
        data: p2pCalldata.setToken(t.address, true),
      });
      await client.waitForTransactionReceipt({ hash: tx });
      console.log(`setToken ${t.symbol}: ${tx}`);
    }
    if (finalOwner && finalOwner !== deployer.address) {
      const tx = await wallet.sendTransaction({
        to: contract,
        data: p2pCalldata.transferOwnership(finalOwner),
      });
      await client.waitForTransactionReceipt({ hash: tx });
      console.log(`transferOwnership to ${finalOwner}: ${tx} (it must call acceptOwnership)`);
    }
  }
  console.log('\nVerification:');
  await verify(client, contract, entry.tokens);
  const suffix = tier.toUpperCase();
  console.log('\nAdd to the API environment (merge with existing entries):');
  console.log(`P2P_CONTRACTS_${suffix}={"${network}":"${contract}"}`);
  console.log(`P2P_DEPLOY_BLOCKS_${suffix}={"${network}":${receipt.blockNumber}}`);
  if (values.rpc) console.log(`P2P_RPC_URLS_${suffix}={"${network}":"<your node URL>"}`);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
