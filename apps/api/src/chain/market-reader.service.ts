import { Injectable, Logger } from '@nestjs/common';
import { ApiError } from '@/common/api-error';
import { ChainClient } from '@/chain/chain-client.service';
import { DeploymentsService, type Deployment } from '@/chain/deployments.service';
import {
  decodeChainOrder,
  decodeMatcherTerms,
  decodeView,
  marketInitCode,
  p2pCalldata,
  type P2pChainOrder,
  type P2pMatcherTerms,
} from '@/chain/market-codec';
import type { Tier } from '@/chain/networks';

/** How long a verified deployment is trusted before it is checked again. */
const DEPLOYMENT_CHECK_TTL_MS = 10 * 60 * 1000;
/** A failed deployment check is retried after this long, not on every request. */
const DEPLOYMENT_RETRY_MS = 60 * 1000;
/** `protocolFeeBps()` and `paused()` are read at most this often. */
const PROTOCOL_READ_TTL_MS = 60 * 1000;
/** A merchant's free balance and matcher terms, cached this long for quotes. */
const BALANCE_READ_TTL_MS = 15 * 1000;

/** Placeholder constructor arguments for the creation `eth_call`: any give the same runtime. */
const PROBE_ARGS = {
  owner: '0x0000000000000000000000000000000000000001',
  treasury: '0x0000000000000000000000000000000000000002',
  arbiter: '0x0000000000000000000000000000000000000003',
  feeBps: 0,
};

export interface ProtocolState {
  feeBps: number;
  paused: boolean;
}

interface Verification {
  at: number;
  /** The deployment with only the tokens the contract allows, or null when it is not ours. */
  live: Deployment | null;
}

/** A small read-through cache with a TTL and a size cap. */
class TtlCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>();
  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    if (this.entries.size >= this.max) this.entries.clear();
    const value = load();
    this.entries.set(key, { at: Date.now(), value });
    value.catch(() => this.entries.delete(key));
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Typed reads of a `P2PMarket` deployment, and the check that a configured
 * address really is one before anything is served from it: the code at the
 * address must equal, byte for byte, the runtime a creation `eth_call` of the
 * committed artifact answers (the contract has no immutables, so any
 * constructor arguments give the same runtime), and each listed token must be
 * `tokenAllowed`. A wrong address is a network never served (logged for the
 * operator); a token the owner has not allowed yet is left out until it is.
 */
@Injectable()
export class MarketReader {
  private readonly logger = new Logger(MarketReader.name);
  private readonly verified = new Map<string, Verification>();
  private readonly inFlight = new Map<string, Promise<Verification>>();
  private readonly protocol = new TtlCache<ProtocolState>(PROTOCOL_READ_TTL_MS, 64);
  private readonly balances = new TtlCache<bigint>(BALANCE_READ_TTL_MS, 2_000);
  private readonly terms = new TtlCache<P2pMatcherTerms>(BALANCE_READ_TTL_MS, 2_000);

  constructor(
    private readonly deployments: DeploymentsService,
    private readonly chain: ChainClient,
  ) {}

  /** The verified deployments of a tier; one that cannot be read right now is left out. */
  async liveDeployments(tier: Tier): Promise<Deployment[]> {
    const checks = await Promise.all(
      this.deployments.deployments(tier).map((d) =>
        this.verify(d).catch((err: unknown) => {
          this.logger.warn(
            `Deployment ${d.network}/${d.tier} could not be checked: ${String(err)}`,
          );
          return { at: 0, live: null };
        }),
      ),
    );
    return checks.flatMap((c) => (c.live ? [c.live] : []));
  }

  /**
   * The deployment a request names, verified: `400 network_unsupported` when
   * none is configured, `503` when the configured address is not this build's
   * P2PMarket (or allows none of the listed tokens).
   */
  async requireLive(tier: Tier, network: string): Promise<Deployment> {
    const configured = this.deployments.require(tier, network);
    const check = await this.verify(configured);
    if (!check.live) {
      throw ApiError.unavailable(
        `The market is not available on ${configured.name} right now.`,
        `${configured.contract} on ${network}/${tier} is not this build's P2PMarket or allows none of the listed tokens.`,
      );
    }
    return check.live;
  }

  /** Forgets every cached verification and read (tests, and after a redeploy). */
  reset(): void {
    this.verified.clear();
    this.protocol.clear();
    this.balances.clear();
    this.terms.clear();
  }

  private verify(d: Deployment): Promise<Verification> {
    const key = `${d.tier}:${d.network}:${d.contract}`;
    const cached = this.verified.get(key);
    const ttl = cached?.live ? DEPLOYMENT_CHECK_TTL_MS : DEPLOYMENT_RETRY_MS;
    if (cached && Date.now() - cached.at < ttl) return Promise.resolve(cached);
    const running = this.inFlight.get(key);
    if (running) return running;
    const check = this.check(d)
      .then((result) => {
        this.verified.set(key, result);
        return result;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, check);
    return check;
  }

  private async check(d: Deployment): Promise<Verification> {
    const [code, expected] = await Promise.all([
      this.chain.getCode(d, d.contract),
      this.chain.call(d, { data: marketInitCode(PROBE_ARGS) }),
    ]);
    if (code === '0x' || code.toLowerCase() !== expected.toLowerCase()) {
      this.logger.error(
        `Deployment ${d.network}/${d.tier} at ${d.contract} is not this build's P2PMarket ` +
          '(its code differs from the artifact runtime): the network is not served.',
      );
      return { at: Date.now(), live: null };
    }
    const allowed = await Promise.all(
      d.tokens.map(async (t) =>
        decodeView<boolean>(
          'tokenAllowed',
          await this.chain.call(d, { to: d.contract, data: p2pCalldata.tokenAllowed(t.address) }),
        ),
      ),
    );
    const tokens = d.tokens.filter((_, i) => allowed[i]);
    const refused = d.tokens.filter((_, i) => !allowed[i]);
    if (refused.length > 0) {
      this.logger.warn(
        `Deployment ${d.network}/${d.tier}: ${refused.map((t) => t.symbol).join(', ')} not allowed by the contract (setToken): not served there.`,
      );
    }
    return { at: Date.now(), live: tokens.length > 0 ? { ...d, tokens } : null };
  }

  /** `protocolFeeBps()` and `paused()`, read at most once a minute per deployment. */
  protocolState(d: Deployment): Promise<ProtocolState> {
    return this.protocol.get(`${d.tier}:${d.network}`, async () => {
      const [fee, paused] = await Promise.all([
        this.chain.call(d, { to: d.contract, data: p2pCalldata.protocolFeeBps() }),
        this.chain.call(d, { to: d.contract, data: p2pCalldata.paused() }),
      ]);
      return {
        feeBps: Number(decodeView<number>('protocolFeeBps', fee)),
        paused: decodeView<boolean>('paused', paused),
      };
    });
  }

  /** An account's free balance of `token` in the contract (cached briefly unless `fresh`). */
  balanceOf(d: Deployment, account: string, token: string, fresh = false): Promise<bigint> {
    const load = async () =>
      decodeView<bigint>(
        'balanceOf',
        await this.chain.call(d, { to: d.contract, data: p2pCalldata.balanceOf(account, token) }),
      );
    if (fresh) return load();
    return this.balances.get(
      `${d.tier}:${d.network}:${account.toLowerCase()}:${token.toLowerCase()}`,
      load,
    );
  }

  /** What `seller` allows the matcher (cached briefly unless `fresh`). */
  matcherTerms(
    d: Deployment,
    seller: string,
    matcher: string,
    fresh = false,
  ): Promise<P2pMatcherTerms> {
    const load = async () =>
      decodeMatcherTerms(
        await this.chain.call(d, {
          to: d.contract,
          data: p2pCalldata.matcherTermsOf(seller, matcher),
        }),
      );
    if (fresh) return load();
    return this.terms.get(
      `${d.tier}:${d.network}:${seller.toLowerCase()}:${matcher.toLowerCase()}`,
      load,
    );
  }

  /** An order as the contract stores it (`status` None when there is none). */
  async getOrder(d: Deployment, id: bigint): Promise<P2pChainOrder> {
    return decodeChainOrder(
      await this.chain.call(d, { to: d.contract, data: p2pCalldata.getOrder(id) }),
    );
  }

  /** The arbiter the contract names now. */
  async arbiter(d: Deployment): Promise<string> {
    return decodeView<string>(
      'arbiter',
      await this.chain.call(d, { to: d.contract, data: p2pCalldata.arbiter() }),
    );
  }
}
