import { Asset } from '@stellar/stellar-sdk';

/**
 * The Stellar networks the market can run on: one `P2PMarket` contract per
 * network. Each network belongs to ONE tier: `testnet` (and the dev-only
 * `local` quickstart network) to `test`, `mainnet` to `live`. A network is
 * OFFERED only when the operator configured a contract there
 * (`P2P_<NET>_CONTRACT`) and the deployment checks out on-chain
 * (`MarketReader`); this table only says what the network IS.
 *
 * Token issuers are never guessed: USDC is Circle's published issuer on each
 * network. Every other token (the dev stack's `TUSD`) comes from the
 * environment (`P2P_<NET>_TOKENS`), and never on mainnet.
 */

export const TIERS = ['live', 'test'] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: unknown): value is Tier {
  return value === 'live' || value === 'test';
}

export const NETWORK_IDS = ['local', 'testnet', 'mainnet'] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];

export function isNetworkId(value: unknown): value is NetworkId {
  return typeof value === 'string' && (NETWORK_IDS as readonly string[]).includes(value);
}

/** Every Stellar asset has 7 decimals: amounts are integers of 10^-7 (stroops for XLM). */
export const STELLAR_DECIMALS = 7;

/** A classic asset the market trades, used on-chain through its Stellar Asset Contract. */
export interface Token {
  symbol: string;
  /** The asset code (`USDC`). */
  code: string;
  /** The issuing account (G...). */
  issuer: string;
  /** The asset's Stellar Asset Contract (C...) on this network. */
  contract: string;
  decimals: number;
}

export interface Network {
  id: NetworkId;
  /** The network's name, for pickers. */
  name: string;
  tier: Tier;
  passphrase: string;
  /** A public Soroban RPC; null where the operator must name one. */
  defaultRpcUrl: string | null;
  /** A public Horizon; null where none is listed. */
  defaultHorizonUrl: string | null;
  /** A stellar.expert-style explorer: append `/tx/<hash>`, `/account/<G>` or `/contract/<C>`. */
  explorerUrl: string | null;
  /** Where new accounts get test lumens; null on mainnet. */
  friendbotUrl: string | null;
  /** Circle's USDC issuer here, or null. */
  usdcIssuer: string | null;
  /** Refused in production. */
  devOnly: boolean;
}

export const NETWORKS: Record<NetworkId, Network> = {
  local: {
    id: 'local',
    name: 'Local Stellar network',
    tier: 'test',
    passphrase: 'Standalone Network ; February 2017',
    defaultRpcUrl: 'http://localhost:8000/rpc',
    defaultHorizonUrl: 'http://localhost:8000',
    explorerUrl: null,
    friendbotUrl: 'http://localhost:8000/friendbot',
    usdcIssuer: null,
    devOnly: true,
  },
  testnet: {
    id: 'testnet',
    name: 'Stellar Testnet',
    tier: 'test',
    passphrase: 'Test SDF Network ; September 2015',
    defaultRpcUrl: 'https://soroban-testnet.stellar.org',
    defaultHorizonUrl: 'https://horizon-testnet.stellar.org',
    explorerUrl: 'https://stellar.expert/explorer/testnet',
    friendbotUrl: 'https://friendbot.stellar.org',
    usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    devOnly: false,
  },
  mainnet: {
    id: 'mainnet',
    name: 'Stellar',
    tier: 'live',
    passphrase: 'Public Global Stellar Network ; September 2015',
    defaultRpcUrl: null,
    defaultHorizonUrl: 'https://horizon.stellar.org',
    explorerUrl: 'https://stellar.expert/explorer/public',
    friendbotUrl: null,
    usdcIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    devOnly: false,
  },
};

/** The networks of a tier, in table order. */
export function networksOf(tier: Tier): NetworkId[] {
  return NETWORK_IDS.filter((id) => NETWORKS[id].tier === tier);
}

/** A classic asset on a network, with its Stellar Asset Contract id. */
export function tokenOf(network: NetworkId, code: string, issuer: string, symbol = code): Token {
  return {
    symbol,
    code,
    issuer,
    contract: new Asset(code, issuer).contractId(NETWORKS[network].passphrase),
    decimals: STELLAR_DECIMALS,
  };
}

/** The tokens the table lists for a network (USDC where Circle issues it). */
export function tableTokens(network: NetworkId): Token[] {
  const issuer = NETWORKS[network].usdcIssuer;
  return issuer ? [tokenOf(network, 'USDC', issuer)] : [];
}
