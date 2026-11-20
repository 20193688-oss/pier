import { Asset, Keypair, Operation, type rpc } from '@stellar/stellar-sdk';
import {
  deployAssetContract,
  deployMarket,
  rpcFor,
  setTokens,
  submitOps,
} from '@/chain/market-deploy';
import { NETWORKS, type NetworkId } from '@/chain/networks';

/**
 * The dev stack's Stellar side, on the local quickstart network or testnet
 * (never mainnet): its accounts, each with a role, funded by friendbot; the
 * dev dollar `TUSD` from its own issuer (so it can mint without a faucet);
 * and the market deployed with the committed wasm. These keys are generated
 * per stack and kept in `.dev-stack/`; they are test keys, printed on
 * purpose, and never used on mainnet.
 */

export const DEV_ROLES = [
  'owner',
  'arbiter',
  'treasury',
  'matcher',
  'sponsor',
  'sep10',
  'merchant',
  'business',
  'user',
  'issuer',
] as const;
export type DevRole = (typeof DEV_ROLES)[number];

export interface DevAccount {
  role: DevRole;
  publicKey: string;
  secret: string;
}

export type DevAccounts = Record<DevRole, DevAccount>;

/** Roles that never get lumens: the SEP-10 key is never funded, and the user is activated through the API (sponsored). */
export const UNFUNDED_ROLES: readonly DevRole[] = ['sep10', 'user'];

export const DEV_TOKEN_CODE = 'TUSD';

export type DevNetwork = Exclude<NetworkId, 'mainnet'>;

export function refuseMainnet(network: string): asserts network is DevNetwork {
  if (network !== 'local' && network !== 'testnet') {
    throw new Error(`the dev tools act only on local and testnet, not ${network}`);
  }
}

/** Fresh random keys for every role. */
export function newDevAccounts(): DevAccounts {
  return Object.fromEntries(
    DEV_ROLES.map((role) => {
      const kp = Keypair.random();
      return [role, { role, publicKey: kp.publicKey(), secret: kp.secret() }];
    }),
  ) as DevAccounts;
}

export function keypair(a: DevAccount): Keypair {
  return Keypair.fromSecret(a.secret);
}

/** Funds an account with test lumens (friendbot); an account that exists already is fine. */
export async function fund(friendbotUrl: string, address: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${friendbotUrl}?addr=${encodeURIComponent(address)}`);
    if (res.ok) return;
    const text = await res.text();
    if (/already exists|createAccountAlreadyExist|op_already_exists/i.test(text)) return;
    await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
  }
  throw new Error(`friendbot did not fund ${address}`);
}

export interface DevChain {
  network: DevNetwork;
  passphrase: string;
  rpcUrl: string;
  horizonUrl: string | null;
  friendbotUrl: string;
}

export function devChain(network: DevNetwork, overrides: Partial<DevChain> = {}): DevChain {
  const table = NETWORKS[network];
  return {
    network,
    passphrase: table.passphrase,
    rpcUrl: overrides.rpcUrl ?? (table.defaultRpcUrl as string),
    horizonUrl: overrides.horizonUrl ?? table.defaultHorizonUrl,
    friendbotUrl: overrides.friendbotUrl ?? (table.friendbotUrl as string),
  };
}

export interface DevMarket {
  contract: string;
  startLedger: number;
  tusd: { code: string; issuer: string; contract: string };
  feeBps: number;
}

/** Opens `holder`'s trustline to the dev dollar (the holder pays its own reserve). */
export async function trustTusd(
  server: rpc.Server,
  chain: DevChain,
  holder: DevAccount,
  issuer: string,
): Promise<void> {
  await submitOps(server, chain.passphrase, keypair(holder), [
    Operation.changeTrust({ asset: new Asset(DEV_TOKEN_CODE, issuer) }),
  ]);
}

/** Mints dev dollars to `to` (a payment from the issuer); `to` must trust TUSD. */
export async function mintTusd(
  server: rpc.Server,
  chain: DevChain,
  issuer: DevAccount,
  to: string,
  units: bigint,
): Promise<void> {
  const whole = units / 10_000_000n;
  const frac = (units % 10_000_000n).toString().padStart(7, '0');
  await submitOps(server, chain.passphrase, keypair(issuer), [
    Operation.payment({
      destination: to,
      asset: new Asset(DEV_TOKEN_CODE, issuer.publicKey),
      amount: `${whole}.${frac}`,
    }),
  ]);
}

/**
 * Funds every role but the SEP-10 key and the user, issues TUSD (its asset
 * contract deployed), gives the merchant and the business TUSD, deploys the
 * market (owner, arbiter and treasury are dev accounts) and allows TUSD (and
 * the network's USDC, where Circle issues it).
 */
export async function setUpDevMarket(
  chain: DevChain,
  accounts: DevAccounts,
  options: { feeBps?: number; mintPerHolder?: bigint; log?: (m: string) => void } = {},
): Promise<DevMarket> {
  const log = options.log ?? (() => undefined);
  refuseMainnet(chain.network);
  const server = await rpcFor(chain.rpcUrl, chain.passphrase);
  for (const a of Object.values(accounts)) {
    if (UNFUNDED_ROLES.includes(a.role)) continue;
    await fund(chain.friendbotUrl, a.publicKey);
  }
  log('accounts funded');
  const owner = keypair(accounts.owner);
  const tusd = new Asset(DEV_TOKEN_CODE, accounts.issuer.publicKey);
  const tusdContract = await deployAssetContract(server, chain.passphrase, owner, tusd);
  const mint = options.mintPerHolder ?? 1_000_000n * 10_000_000n;
  for (const holder of [accounts.merchant, accounts.business]) {
    await trustTusd(server, chain, holder, accounts.issuer.publicKey);
    await mintTusd(server, chain, accounts.issuer, holder.publicKey, mint);
  }
  log(`TUSD issued (${tusdContract}) and minted`);
  const feeBps = options.feeBps ?? 50;
  const deployed = await deployMarket(server, chain.passphrase, owner, {
    owner: accounts.owner.publicKey,
    treasury: accounts.treasury.publicKey,
    arbiter: accounts.arbiter.publicKey,
    feeBps,
  });
  const usdcIssuer = NETWORKS[chain.network].usdcIssuer;
  const allowed = [
    tusdContract,
    ...(usdcIssuer ? [new Asset('USDC', usdcIssuer).contractId(chain.passphrase)] : []),
  ];
  await setTokens(server, chain.passphrase, owner, deployed.contract, allowed);
  log(`market ${deployed.contract} deployed`);
  return {
    contract: deployed.contract,
    startLedger: deployed.ledger,
    tusd: { code: DEV_TOKEN_CODE, issuer: accounts.issuer.publicKey, contract: tusdContract },
    feeBps,
  };
}
