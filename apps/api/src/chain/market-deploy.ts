import { randomBytes } from 'node:crypto';
import { MARKET_WASM_BASE64, MARKET_WASM_HASH } from '@pedospe/contracts';
import {
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
  type xdr,
} from '@stellar/stellar-sdk';
import { MARKET, p2pCall } from '@/chain/market-codec';

/**
 * Deploying and administering a market with keys held by the caller (the
 * deploy CLI's deployer, the dev stack's dev accounts). The API itself never
 * runs these: it holds no owner key.
 */

export interface SubmitResult {
  hash: string;
  ledger: number;
  returnValue: xdr.ScVal | undefined;
}

/** A client of an RPC node that checks the network's passphrase first. */
export async function rpcFor(url: string, passphrase: string): Promise<rpc.Server> {
  const server = new rpc.Server(url, { allowHttp: url.startsWith('http://'), timeout: 30_000 });
  const network = await server.getNetwork();
  if (network.passphrase !== passphrase) {
    throw new Error(`${url} is on "${network.passphrase}", not "${passphrase}"`);
  }
  return server;
}

/**
 * Builds, prepares (simulation, resources, footprint), signs and submits one
 * transaction of `ops` from `source`, signed by `signers` (the source's key
 * first), and waits for it. Throws unless it succeeded.
 */
export async function submitOps(
  server: rpc.Server,
  passphrase: string,
  source: Keypair,
  ops: xdr.Operation[],
  signers: Keypair[] = [],
): Promise<SubmitResult> {
  const account = await server.getAccount(source.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: (Number(BASE_FEE) * Math.max(1, ops.length) * 10).toString(),
    networkPassphrase: passphrase,
  }).setTimeout(120);
  for (const op of ops) builder.addOperation(op);
  let tx = builder.build();
  const soroban = ops.some((op) => {
    const type = (op as unknown as { body: { type: string } }).body?.type;
    return (
      type === 'invokeHostFunction' || type === 'restoreFootprint' || type === 'extendFootprintTtl'
    );
  });
  if (soroban) tx = await server.prepareTransaction(tx);
  tx.sign(source, ...signers);
  const sent = await server.sendTransaction(tx);
  if (sent.status === 'ERROR') {
    throw new Error(`transaction refused: ${JSON.stringify(sent.errorResult?.toJSON?.())}`);
  }
  const got = await server.pollTransaction(sent.hash, {
    attempts: 60,
    sleepStrategy: () => 1_000,
  });
  if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${sent.hash} ${got.status}`);
  }
  return { hash: sent.hash, ledger: got.ledger, returnValue: got.returnValue };
}

export interface DeployedMarket {
  contract: string;
  /** The ledger the contract was created in: where its indexer starts. */
  ledger: number;
  wasmHash: string;
}

/**
 * Uploads the committed wasm and creates a market with its constructor
 * arguments (owner, treasury, arbiter, protocol fee). The created contract
 * runs exactly `MARKET_WASM_HASH`.
 */
export async function deployMarket(
  server: rpc.Server,
  passphrase: string,
  deployer: Keypair,
  args: { owner: string; treasury: string; arbiter: string; feeBps: number },
): Promise<DeployedMarket> {
  const wasm = Buffer.from(MARKET_WASM_BASE64, 'base64');
  const upload = await submitOps(server, passphrase, deployer, [
    Operation.uploadContractWasm({ wasm }),
  ]);
  const uploadedHash = upload.returnValue
    ? Buffer.from(scValToNative(upload.returnValue) as Uint8Array).toString('hex')
    : MARKET_WASM_HASH;
  if (uploadedHash !== MARKET_WASM_HASH) {
    throw new Error(`uploaded wasm hashes to ${uploadedHash}, not ${MARKET_WASM_HASH}`);
  }
  const created = await submitOps(server, passphrase, deployer, [
    Operation.createCustomContract({
      address: new Address(deployer.publicKey()),
      wasmHash: Buffer.from(MARKET_WASM_HASH, 'hex'),
      salt: randomBytes(32),
      constructorArgs: MARKET.funcArgsToScVals('__constructor', {
        owner: args.owner,
        treasury: args.treasury,
        arbiter: args.arbiter,
        protocol_fee_bps: args.feeBps,
      }),
    }),
  ]);
  if (!created.returnValue) throw new Error('the contract creation returned no address');
  return {
    contract: Address.fromScVal(created.returnValue).toString(),
    ledger: created.ledger,
    wasmHash: MARKET_WASM_HASH,
  };
}

/** The owner allows (or refuses) tokens on a market, one transaction each. */
export async function setTokens(
  server: rpc.Server,
  passphrase: string,
  owner: Keypair,
  contract: string,
  tokens: readonly string[],
  allowed = true,
): Promise<string[]> {
  const hashes: string[] = [];
  for (const token of tokens) {
    const sent = await submitOps(server, passphrase, owner, [
      p2pCall.setToken(contract, token, allowed),
    ]);
    hashes.push(sent.hash);
  }
  return hashes;
}

/**
 * Deploys a classic asset's Stellar Asset Contract (no-op when it exists);
 * answers its contract id.
 */
export async function deployAssetContract(
  server: rpc.Server,
  passphrase: string,
  payer: Keypair,
  asset: Asset,
): Promise<string> {
  const contract = asset.contractId(passphrase);
  try {
    await server.getContractInstance(contract);
    return contract;
  } catch {
    await submitOps(server, passphrase, payer, [Operation.createStellarAssetContract({ asset })]);
    return contract;
  }
}
