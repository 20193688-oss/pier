import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MARKET_WASM_HASH } from '@pier/contracts';
import {
  Account,
  BASE_FEE,
  Keypair,
  TransactionBuilder,
  contract as sdkContract,
  rpc,
} from '@stellar/stellar-sdk';
import { deployMarket, rpcFor, setTokens, submitOps } from '@/chain/market-deploy';
import { decodeResult, p2pCall, toMarketConfig } from '@/chain/market-codec';
import {
  NETWORKS,
  isNetworkId,
  nativeTokenOf,
  tableTokens,
  tokenOf,
  type Token,
} from '@/chain/networks';
import { isAccountAddress, isContractAddress, isSecretSeed } from '@/common/stellar';
import { extraTokenEntry } from '@/config/env';
import { P2P_MAX_PROTOCOL_FEE_BPS } from '@/p2p/domain/constants';

/**
 * Deploys `P2PMarket` (the committed wasm) on ONE Stellar network, or verifies
 * a deployment that exists, and prints the environment entries the API reads.
 *
 *   npm run deploy:contract -w @pier/api -- --network testnet \
 *     --secrets-file C:/Users/<you>/.pier/deployer.json \
 *     --treasury G... --arbiter G... --fee-bps 50 [--owner G...] [--token CODE:ISSUER | --token native] [--rpc <url>]
 *   ... --contract C...                       verify only
 *   ... --network mainnet --i-understand-mainnet --owner G... --rpc <url>
 *
 * The secrets file (outside every repository) is `{ "deployerSecret": "S..." }`;
 * the key is never printed. The node must answer the network's passphrase
 * before anything is signed.
 *
 *   - testnet: the deployer owns the contract while it allows the tokens
 *     (`set_token`: USDC and every `--token`), then hands ownership to
 *     `--owner` when given (that account then calls `accept_ownership`).
 *   - mainnet: `--owner` (a multisig) owns it from construction, and the script
 *     PRINTS the unsigned `set_token` transactions for the owner to sign. The
 *     deployer never owns a mainnet market.
 *
 * The local network is deployed by `npm run dev:stack`.
 */

function fail(message: string): never {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

function account(name: string, value: string | undefined): string {
  if (!isAccountAddress(value)) fail(`--${name} must be a Stellar account address (G...)`);
  return value;
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

function deployerKey(path: string): Keypair {
  const full = resolve(path);
  if (!existsSync(full)) fail(`no secrets file at ${full}`);
  const real = realpathSync(full);
  const repo = repositoryRoot();
  if (repo && (real === repo || real.startsWith(`${repo}${sep}`))) {
    fail(`the secrets file must live outside the repository (${repo})`);
  }
  const parsed = JSON.parse(readFileSync(real, 'utf8')) as { deployerSecret?: unknown };
  if (!isSecretSeed(parsed.deployerSecret)) {
    fail('the secrets file has no valid deployerSecret (S...)');
  }
  return Keypair.fromSecret(parsed.deployerSecret);
}

async function view<T>(
  server: rpc.Server,
  passphrase: string,
  fn: string,
  op: ReturnType<typeof p2pCall.config>,
): Promise<T> {
  const tx = new TransactionBuilder(new Account(sdkContract.NULL_ACCOUNT, '0'), {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result) throw new Error(`${fn} failed`);
  return decodeResult<T>(fn, sim.result.retval);
}

async function verify(
  server: rpc.Server,
  passphrase: string,
  contract: string,
  tokens: readonly Token[],
): Promise<boolean> {
  let hash: string | null;
  try {
    const instance = await server.getContractInstance(contract);
    const exec = instance.executable;
    hash =
      exec.type === 'contractExecutableWasm'
        ? Buffer.from(exec.wasmHash.value).toString('hex')
        : null;
  } catch {
    hash = null;
  }
  const matches = hash === MARKET_WASM_HASH;
  console.log(
    `  wasm:          ${matches ? 'matches the artifact' : `DOES NOT match the artifact (${hash ?? 'none'})`}`,
  );
  if (!matches) return false;
  const config = toMarketConfig(await view(server, passphrase, 'config', p2pCall.config(contract)));
  console.log(
    `  owner:         ${config.owner}${config.pendingOwner ? ` (pending ${config.pendingOwner})` : ''}`,
  );
  console.log(`  arbiter:       ${config.arbiter}`);
  console.log(`  treasury:      ${config.treasury}`);
  console.log(`  protocol fee:  ${config.protocolFeeBps} bps${config.paused ? ' (PAUSED)' : ''}`);
  let all = true;
  for (const t of tokens) {
    const allowed = await view<boolean>(
      server,
      passphrase,
      'token_allowed',
      p2pCall.tokenAllowed(contract, t.contract),
    );
    all &&= allowed;
    console.log(
      `  ${t.symbol.padEnd(14)} ${allowed ? 'allowed' : 'NOT allowed (owner must set_token)'}`,
    );
  }
  return all;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      network: { type: 'string' },
      'secrets-file': { type: 'string' },
      owner: { type: 'string' },
      treasury: { type: 'string' },
      arbiter: { type: 'string' },
      'fee-bps': { type: 'string' },
      token: { type: 'string', multiple: true },
      rpc: { type: 'string' },
      contract: { type: 'string' },
      'i-understand-mainnet': { type: 'boolean', default: false },
    },
  });
  const network = values.network;
  if (!isNetworkId(network) || network === 'local') {
    fail(
      '--network must be testnet or mainnet; the local network is deployed by npm run dev:stack',
    );
  }
  const table = NETWORKS[network];
  const live = network === 'mainnet';
  if (live && !values['i-understand-mainnet']) {
    fail('mainnet needs --i-understand-mainnet: this deploys a contract that will hold real money');
  }
  const rpcUrl = values.rpc ?? table.defaultRpcUrl;
  if (!rpcUrl) fail(`--rpc is required for ${network}`);
  const server = await rpcFor(rpcUrl, table.passphrase).catch((err: unknown) =>
    fail(`the node does not answer ${network}'s passphrase: ${String(err)}`),
  );
  console.log(`${table.name} (${table.tier})`);
  if (live && values.token?.length) fail('--token is refused on mainnet: only the table’s USDC');
  const tokens: Token[] = [
    ...tableTokens(network),
    ...(values.token ?? []).map((t) => {
      if (t.toLowerCase() === 'native') return nativeTokenOf(network);
      const [code, issuer] = t.split(':');
      if (!code || !isAccountAddress(issuer)) fail(`--token ${t} must be CODE:ISSUER or native`);
      return tokenOf(network, code, issuer);
    }),
  ];

  if (values.contract) {
    if (!isContractAddress(values.contract)) fail('--contract must be a contract address (C...)');
    console.log(`Verifying ${values.contract}`);
    process.exit((await verify(server, table.passphrase, values.contract, tokens)) ? 0 : 1);
  }

  const deployer = deployerKey(values['secrets-file'] ?? fail('--secrets-file is required'));
  const treasury = account('treasury', values.treasury);
  const arbiter = account('arbiter', values.arbiter);
  const feeBps = Number(values['fee-bps'] ?? fail('--fee-bps is required'));
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > P2P_MAX_PROTOCOL_FEE_BPS) {
    fail(`--fee-bps must be 0..${P2P_MAX_PROTOCOL_FEE_BPS}`);
  }
  const finalOwner = values.owner ? account('owner', values.owner) : null;
  if (live && !finalOwner) fail('mainnet needs --owner (a multisig): the deployer never owns it');
  const constructionOwner = live ? (finalOwner as string) : deployer.publicKey();

  console.log(`Deployer ${deployer.publicKey()}; owner at construction ${constructionOwner}`);
  const deployed = await deployMarket(server, table.passphrase, deployer, {
    owner: constructionOwner,
    treasury,
    arbiter,
    feeBps,
  });
  console.log(`P2PMarket at ${deployed.contract} (ledger ${deployed.ledger})`);

  if (live) {
    console.log('\nThe owner must now allow the tokens. Unsigned transactions for the owner:');
    const ownerAccount = await server.getAccount(constructionOwner);
    for (const t of tokens) {
      const tx = await server.prepareTransaction(
        new TransactionBuilder(ownerAccount, { fee: BASE_FEE, networkPassphrase: table.passphrase })
          .addOperation(p2pCall.setToken(deployed.contract, t.contract, true))
          .setTimeout(3600)
          .build(),
      );
      console.log(`  ${t.symbol}: ${tx.toXDR()}`);
    }
  } else {
    await setTokens(
      server,
      table.passphrase,
      deployer,
      deployed.contract,
      tokens.map((t) => t.contract),
    );
    console.log(`set_token: ${tokens.map((t) => t.symbol).join(', ')}`);
    if (finalOwner && finalOwner !== deployer.publicKey()) {
      const sent = await submitOps(server, table.passphrase, deployer, [
        p2pCall.transferOwnership(deployed.contract, finalOwner),
      ]);
      console.log(
        `transfer_ownership to ${finalOwner}: ${sent.hash} (it must call accept_ownership)`,
      );
    }
  }
  console.log('\nVerification:');
  await verify(server, table.passphrase, deployed.contract, tokens);
  const net = network.toUpperCase();
  console.log('\nAdd to the API environment:');
  console.log(`P2P_${net}_CONTRACT=${deployed.contract}`);
  console.log(`P2P_${net}_START_LEDGER=${deployed.ledger}`);
  if (values.token?.length) {
    console.log(
      `P2P_${net}_TOKENS=${JSON.stringify(tokens.slice(tableTokens(network).length).map(extraTokenEntry))}`,
    );
  }
  if (values.rpc) console.log(`STELLAR_${net}_RPC_URL=<your node URL>`);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
