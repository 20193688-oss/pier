import { Inject, Injectable } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import { ApiError, ErrorCode } from '@/common/api-error';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import {
  NETWORK_IDS,
  NETWORKS,
  isNetworkId,
  type NetworkId,
  type Tier,
  type Token,
} from '@/chain/networks';

/** A Stellar network this service can reach (whether or not the market runs on it). */
export interface StellarNetwork {
  network: NetworkId;
  tier: Tier;
  name: string;
  passphrase: string;
  /** The node this service reads and submits through (may carry a key: never published). */
  rpcUrl: string;
  horizonUrl: string | null;
  /** The table's public endpoints, safe to publish. */
  publicRpcUrl: string | null;
  publicHorizonUrl: string | null;
  explorerUrl: string | null;
  friendbotUrl: string | null;
}

/** One configured market deployment: a network with its contract and tokens. */
export interface Deployment extends StellarNetwork {
  contract: string;
  tokens: readonly Token[];
  /** Where the indexer starts without a cursor; null: the RPC's oldest retained ledger. */
  startLedger: number | null;
}

/**
 * The one reader of the network configuration: which networks run the market,
 * at which contract and through which node, with which tokens, and the
 * server's three keys (matcher, sponsor, SEP-10). Whether a deployment is
 * VERIFIED on-chain is `MarketReader`'s job; this only says what was configured.
 */
@Injectable()
export class DeploymentsService {
  private readonly all: Deployment[];
  private readonly matcher: Keypair | null;
  private readonly sponsor: Keypair | null;
  private readonly sep10: Keypair | null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.all = NETWORK_IDS.flatMap((id) => {
      const net = this.network(id);
      const c = config.networks[id];
      return net && c.contract
        ? [{ ...net, contract: c.contract, tokens: c.tokens, startLedger: c.startLedger }]
        : [];
    });
    this.matcher = config.p2p.matcherSecret ? Keypair.fromSecret(config.p2p.matcherSecret) : null;
    this.sponsor = config.sponsor.secret ? Keypair.fromSecret(config.sponsor.secret) : null;
    this.sep10 = config.sep10.signingSecret ? Keypair.fromSecret(config.sep10.signingSecret) : null;
  }

  /** A network this service has a node for, or null. */
  network(id: NetworkId): StellarNetwork | null {
    const c = this.config.networks[id];
    const t = NETWORKS[id];
    if (!c.rpcUrl) return null;
    return {
      network: id,
      tier: t.tier,
      name: t.name,
      passphrase: t.passphrase,
      rpcUrl: c.rpcUrl,
      horizonUrl: c.horizonUrl,
      publicRpcUrl: t.devOnly ? c.rpcUrl : t.defaultRpcUrl,
      publicHorizonUrl: t.devOnly ? c.horizonUrl : t.defaultHorizonUrl,
      explorerUrl: t.explorerUrl,
      friendbotUrl: t.friendbotUrl,
    };
  }

  /** Whether any network has a market: the chain jobs run only then. */
  anyConfigured(): boolean {
    return this.all.length > 0;
  }

  deployments(tier: Tier): Deployment[] {
    return this.all.filter((d) => d.tier === tier);
  }

  /** Whether `contractId` is a market contract this service is configured with (any tier). */
  isMarket(contractId: string): boolean {
    return this.all.some((d) => d.contract === contractId);
  }

  find(tier: Tier, network: string): Deployment | null {
    if (!isNetworkId(network)) return null;
    return this.all.find((d) => d.tier === tier && d.network === network) ?? null;
  }

  /**
   * The deployment a request names, or `400 network_unsupported`, listing the
   * networks that ARE served on the tier (counted from configuration).
   */
  require(tier: Tier, network: string): Deployment {
    const found = this.find(tier, network);
    if (found) return found;
    const served = this.deployments(tier).map((d) => d.network);
    throw ApiError.badRequest(
      ErrorCode.NetworkUnsupported,
      served.length === 0
        ? `The market is not available on the ${tier} tier yet.`
        : `The market does not run on ${network} on the ${tier} tier. It runs on ${served.join(', ')} there.`,
    );
  }

  /** The tier's only deployment when `network` is omitted, or the one it names. */
  pick(tier: Tier, network: string | undefined): Deployment {
    if (network) return this.require(tier, network);
    const all = this.deployments(tier);
    if (all.length === 1) return all[0];
    throw ApiError.validation([
      all.length === 0
        ? `the market is not available on the ${tier} tier yet`
        : `name the network: ${all.map((d) => d.network).join(' or ')}`,
    ]);
  }

  /** A token of a deployment by contract, symbol or `CODE:ISSUER` (any case), or `400 asset_unsupported`. */
  token(deployment: Deployment, ref: string): Token {
    const found = this.findToken(deployment, ref);
    if (found) return found;
    throw ApiError.badRequest(
      ErrorCode.AssetUnsupported,
      `The market does not trade ${ref} on ${deployment.network}: it trades ${deployment.tokens.map((t) => t.symbol).join(', ') || 'no token yet'} there.`,
    );
  }

  findToken(deployment: { tokens: readonly Token[] }, ref: string): Token | null {
    const wanted = ref.trim();
    const upper = wanted.toUpperCase();
    return (
      deployment.tokens.find(
        (t) =>
          t.contract === wanted ||
          t.symbol.toUpperCase() === upper ||
          `${t.code}:${t.issuer}`.toUpperCase() === upper,
      ) ?? null
    );
  }

  /** The token a stored row names (its SAC contract), or the contract when it is no longer listed. */
  symbolOf(row: { tier: string; network: string; token: string }): string {
    const d = this.find(row.tier as Tier, row.network);
    return d?.tokens.find((t) => t.contract === row.token)?.symbol ?? row.token;
  }

  /** The matcher's account (G...); null when no key is configured. */
  matcherAddress(): string | null {
    return this.matcher?.publicKey() ?? null;
  }

  /** The matcher's key; only `MatcherService` signs with it. */
  matcherKey(): Keypair {
    if (!this.matcher) {
      throw ApiError.unavailable(
        'The market cannot open orders on this deployment right now.',
        'P2P_MATCHER_SECRET is not set.',
      );
    }
    return this.matcher;
  }

  /** The sponsor's account (G...); null when gasless is off. */
  sponsorAddress(): string | null {
    return this.sponsor?.publicKey() ?? null;
  }

  /** The sponsor's key; only the submission and activation paths sign with it. */
  sponsorKey(): Keypair | null {
    return this.sponsor;
  }

  /** The SEP-10 signing key; it never holds funds and never signs a transaction that is submitted. */
  sep10Key(): Keypair {
    if (!this.sep10) {
      throw ApiError.unavailable(
        'Sign-in is not available right now.',
        'SEP10_SIGNING_SECRET is not set.',
      );
    }
    return this.sep10;
  }

  sep10Address(): string | null {
    return this.sep10?.publicKey() ?? null;
  }

  timeoutMs(): number {
    return this.config.p2p.rpcTimeoutMs;
  }
}
