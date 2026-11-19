/**
 * The EVM networks the market can run on: one `P2PMarket` deployment per
 * network and tier. A network is OFFERED on a tier only when the operator
 * configured a contract there (`P2P_CONTRACTS_LIVE` / `P2P_CONTRACTS_TEST`)
 * and the deployment checks out on-chain (`MarketReader`); this table only
 * says what the network IS.
 *
 * Token addresses are never guessed: the mainnet ones are the issuers'
 * published addresses, checked with `symbol()` / `decimals()` on each chain on
 * 2026-11-19; the test ones are Circle's published test USDC. `local` is the
 * dev chain (`npm run dev:stack`), whose token is deployed by the dev setup
 * and named in `P2P_LOCAL_TOKENS`.
 */

export const TIERS = ['live', 'test'] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: unknown): value is Tier {
  return value === 'live' || value === 'test';
}

export const NETWORK_IDS = [
  'eth',
  'base',
  'arb',
  'op',
  'pol',
  'bsc',
  'avax',
  'monad',
  'local',
] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];

export function isNetworkId(value: unknown): value is NetworkId {
  return typeof value === 'string' && (NETWORK_IDS as readonly string[]).includes(value);
}

/** The dev chain's id: the only chain the dev-only tools ever act on. */
export const DEV_CHAIN_ID = 31337;

/** A stablecoin the market trades on one network and tier. */
export interface Token {
  symbol: string;
  /** EIP-55. */
  address: string;
  decimals: number;
}

/** One network on one tier. */
export interface TierNetwork {
  /** EIP-155 id; the chain client refuses a node that answers another. */
  chainId: number;
  /** The tokens listed here, by address (`local`: from configuration). */
  tokens: readonly Token[];
  /** A public node for a test network; null where the operator must name one. */
  defaultRpcUrl: string | null;
  /** Blocks a log must be under before the indexer acts on it. */
  confirmations: number;
  /** Blocks one `eth_getLogs` may span on the tightest public node seen. */
  logBlockRange: number;
  /** Prefix of a transaction's page on the network's explorer, or null. */
  explorerTxUrl: string | null;
}

export interface Network {
  id: NetworkId;
  /** The network's own name, for pickers. */
  name: string;
  tiers: Record<Tier, TierNetwork | null>;
}

function token(symbol: string, address: string, decimals: number): Token {
  return { symbol, address, decimals };
}
const usdc = (address: string) => token('USDC', address, 6);

function live(
  chainId: number,
  tokens: readonly Token[],
  confirmations: number,
  explorerTxUrl: string,
  logBlockRange = 500,
): TierNetwork {
  return { chainId, tokens, defaultRpcUrl: null, confirmations, logBlockRange, explorerTxUrl };
}

function test(
  chainId: number,
  usdcAddress: string,
  defaultRpcUrl: string,
  explorerTxUrl: string,
  logBlockRange = 500,
): TierNetwork {
  return {
    chainId,
    tokens: [usdc(usdcAddress)],
    defaultRpcUrl,
    confirmations: 2,
    logBlockRange,
    explorerTxUrl,
  };
}

/**
 * Every network, by id. A `Record`, so a new id does not compile until it
 * says what it is on each tier.
 */
export const NETWORKS: Record<NetworkId, Network> = {
  eth: {
    id: 'eth',
    name: 'Ethereum',
    tiers: {
      live: live(
        1,
        [
          usdc('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
          token('USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
        ],
        12,
        'https://etherscan.io/tx/',
      ),
      test: test(
        11155111,
        '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        'https://ethereum-sepolia-rpc.publicnode.com',
        'https://sepolia.etherscan.io/tx/',
      ),
    },
  },
  base: {
    id: 'base',
    name: 'Base',
    tiers: {
      live: live(
        8453,
        [
          usdc('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
          token('USDT', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 6),
        ],
        10,
        'https://basescan.org/tx/',
      ),
      test: test(
        84532,
        '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        'https://sepolia.base.org',
        'https://sepolia.basescan.org/tx/',
      ),
    },
  },
  arb: {
    id: 'arb',
    name: 'Arbitrum',
    tiers: {
      live: live(
        42161,
        [
          usdc('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
          token('USDT0', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6),
        ],
        20,
        'https://arbiscan.io/tx/',
      ),
      test: test(
        421614,
        '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
        'https://sepolia-rollup.arbitrum.io/rpc',
        'https://sepolia.arbiscan.io/tx/',
      ),
    },
  },
  op: {
    id: 'op',
    name: 'Optimism',
    tiers: {
      live: live(
        10,
        [
          usdc('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'),
          token('USDT0', '0x01bFF41798a0BcF287b996046Ca68b395DbC1071', 6),
        ],
        10,
        'https://optimistic.etherscan.io/tx/',
      ),
      test: test(
        11155420,
        '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
        'https://sepolia.optimism.io',
        'https://sepolia-optimism.etherscan.io/tx/',
      ),
    },
  },
  pol: {
    id: 'pol',
    name: 'Polygon',
    tiers: {
      live: live(
        137,
        [
          usdc('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'),
          token('USDT0', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6),
        ],
        32,
        'https://polygonscan.com/tx/',
      ),
      test: test(
        80002,
        '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
        'https://polygon-amoy-bor-rpc.publicnode.com',
        'https://amoy.polygonscan.com/tx/',
      ),
    },
  },
  bsc: {
    id: 'bsc',
    name: 'BNB Chain',
    tiers: {
      // USDC and USDT on BNB Chain have 18 decimals.
      live: live(
        56,
        [
          token('USDC', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18),
          token('USDT', '0x55d398326f99059fF775485246999027B3197955', 18),
        ],
        15,
        'https://bscscan.com/tx/',
      ),
      // No official test USDC is published for BNB Chain's test network.
      test: null,
    },
  },
  avax: {
    id: 'avax',
    name: 'Avalanche',
    tiers: {
      live: live(
        43114,
        [
          usdc('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'),
          token('USDT', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 6),
        ],
        2,
        'https://snowtrace.io/tx/',
      ),
      test: test(
        43113,
        '0x5425890298aed601595a70AB815c96711a31Bc65',
        'https://api.avax-test.network/ext/bc/C/rpc',
        'https://testnet.snowtrace.io/tx/',
      ),
    },
  },
  monad: {
    id: 'monad',
    name: 'Monad',
    tiers: {
      live: live(
        143,
        [
          usdc('0x754704Bc059F8C67012fEd69BC8A327a5aafb603'),
          token('USDT0', '0xe7cd86e13AC4309349F30B3435a9d337750fC82D', 6),
        ],
        3,
        'https://monadscan.com/tx/',
        100,
      ),
      // Monad's public test node caps `eth_getLogs` at 100 blocks.
      test: test(
        10143,
        '0x534b2f3A21130d7a60830c2Df862319e593943A3',
        'https://testnet-rpc.monad.xyz',
        'https://testnet.monadexplorer.com/tx/',
        100,
      ),
    },
  },
  local: {
    id: 'local',
    name: 'Local dev chain',
    tiers: {
      live: null,
      test: {
        chainId: DEV_CHAIN_ID,
        tokens: [],
        defaultRpcUrl: 'http://127.0.0.1:8545',
        // The dev node mines every transaction at once; nothing reorgs.
        confirmations: 0,
        logBlockRange: 5_000,
        explorerTxUrl: null,
      },
    },
  },
};
