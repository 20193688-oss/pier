import { Inject, Injectable } from '@nestjs/common';
import { getAddress, type Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { ApiError, ErrorCode } from '@/common/api-error';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import {
  isNetworkId,
  NETWORK_IDS,
  NETWORKS,
  TIERS,
  type NetworkId,
  type Tier,
  type Token,
} from '@/chain/networks';

/** One configured deployment: a network on a tier, with its contract and node. */
export interface Deployment {
  tier: Tier;
  network: NetworkId;
  name: string;
  chainId: number;
  contract: string;
  deployBlock: bigint;
  rpcUrl: string;
  tokens: readonly Token[];
  confirmations: number;
  logBlockRange: number;
  explorerTxUrl: string | null;
}

/**
 * The one reader of the deployment configuration: which networks run the
 * market on each tier, at which contract and through which node, with which
 * tokens, and the matcher's address. Whether a deployment is VERIFIED
 * on-chain is `MarketReader`'s job; this only says what was configured.
 */
@Injectable()
export class DeploymentsService {
  private readonly byTier: Record<Tier, Deployment[]>;
  private readonly matcher: string | null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.byTier = {
      live: this.build('live'),
      test: this.build('test'),
    };
    const key = config.p2p.matcherPrivateKey;
    this.matcher = key ? privateKeyToAddress(key) : null;
  }

  private build(tier: Tier): Deployment[] {
    const set = this.config.p2p.tiers[tier];
    return NETWORK_IDS.flatMap((id) => {
      const contract = set.contracts[id];
      const entry = NETWORKS[id].tiers[tier];
      if (!contract || !entry) return [];
      return [
        {
          tier,
          network: id,
          name: NETWORKS[id].name,
          chainId: entry.chainId,
          contract: getAddress(contract),
          deployBlock: BigInt(set.deployBlocks[id] ?? 0),
          rpcUrl: set.rpcUrls[id] ?? entry.defaultRpcUrl ?? '',
          tokens: id === 'local' ? this.config.p2p.localTokens : entry.tokens,
          confirmations: entry.confirmations,
          logBlockRange: entry.logBlockRange,
          explorerTxUrl: entry.explorerTxUrl,
        },
      ];
    });
  }

  /** Whether any tier has a deployment: the chain jobs run only then. */
  anyConfigured(): boolean {
    return TIERS.some((t) => this.byTier[t].length > 0);
  }

  deployments(tier: Tier): Deployment[] {
    return this.byTier[tier];
  }

  find(tier: Tier, network: string): Deployment | null {
    if (!isNetworkId(network)) return null;
    return this.byTier[tier].find((d) => d.network === network) ?? null;
  }

  /** The chain id a stored row's network has on its tier, from the table (no RPC). */
  chainIdOf(row: { tier: string; network: string }): number {
    if (!isNetworkId(row.network) || (row.tier !== 'live' && row.tier !== 'test')) return 0;
    return NETWORKS[row.network].tiers[row.tier]?.chainId ?? 0;
  }

  /**
   * The deployment a request names, or `400 network_unsupported`, listing the
   * networks that ARE served on the tier (counted from configuration).
   */
  require(tier: Tier, network: string): Deployment {
    const found = this.find(tier, network);
    if (found) return found;
    const served = this.byTier[tier].map((d) => d.network);
    throw ApiError.badRequest(
      ErrorCode.NetworkUnsupported,
      served.length === 0
        ? `The market is not available on the ${tier} tier yet.`
        : `The market does not run on ${network} on the ${tier} tier. It runs on ${served.length} network${served.length === 1 ? '' : 's'} there: ${served.join(', ')}.`,
    );
  }

  /** A token of a deployment by address or symbol (any case), or `400 asset_unsupported`. */
  token(deployment: Deployment, ref: string): Token {
    const wanted = ref.trim().toLowerCase();
    const found = deployment.tokens.find(
      (t) => t.address.toLowerCase() === wanted || t.symbol.toLowerCase() === wanted,
    );
    if (found) return found;
    throw ApiError.badRequest(
      ErrorCode.AssetUnsupported,
      `The market does not trade ${ref} on ${deployment.network}: it trades ${deployment.tokens.map((t) => t.symbol).join(', ') || 'no token yet'} there.`,
    );
  }

  /** The token a stored row names, or its address when it is no longer listed. */
  symbolOf(row: { tier: string; network: string; token: string }): string {
    const d = this.find(row.tier as Tier, row.network);
    return (
      d?.tokens.find((t) => t.address.toLowerCase() === row.token.toLowerCase())?.symbol ??
      row.token
    );
  }

  /** The matcher's address, EIP-55; null when no key is configured. */
  matcherAddress(): string | null {
    return this.matcher;
  }

  /** The matcher's key; only `MatcherService` signs with it. */
  matcherKey(): Hex {
    const key = this.config.p2p.matcherPrivateKey;
    if (!key) {
      throw ApiError.unavailable(
        'The market cannot open orders on this deployment right now.',
        'P2P_MATCHER_PRIVATE_KEY is not set.',
      );
    }
    return key;
  }

  timeoutMs(): number {
    return this.config.p2p.rpcTimeoutMs;
  }
}
