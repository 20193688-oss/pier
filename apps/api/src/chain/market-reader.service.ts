import { Injectable, Logger } from '@nestjs/common';
import { MARKET_WASM_HASH } from '@midpoint/contracts';
import {
  Account,
  BASE_FEE,
  TransactionBuilder,
  contract,
  rpc,
  type xdr,
} from '@stellar/stellar-sdk';
import { ApiError } from '@/common/api-error';
import { ChainCallReverted, ChainClient } from '@/chain/chain-client.service';
import {
  DeploymentsService,
  type Deployment,
  type StellarNetwork,
} from '@/chain/deployments.service';
import {
  decodeResult,
  p2pCall,
  refusalName,
  toChainOrder,
  toMarketConfig,
  toMatcherTerms,
  type P2pChainOrder,
  type P2pMarketConfig,
  type P2pMatcherTerms,
} from '@/chain/market-codec';
import type { Tier } from '@/chain/networks';

/** How long a verified deployment is trusted before it is checked again. */
const DEPLOYMENT_CHECK_TTL_MS = 10 * 60 * 1000;
/** A failed deployment check is retried after this long, not on every request. */
const DEPLOYMENT_RETRY_MS = 60 * 1000;
/** `config()` (fee, pause, arbiter) is read at most this often. */
const CONFIG_READ_TTL_MS = 60 * 1000;
/** A merchant's free balance and matcher terms, cached this long for quotes. */
const BALANCE_READ_TTL_MS = 15 * 1000;

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
 * Typed reads of a `P2PMarket` deployment (simulated view calls), and the
 * check that a configured contract really is one before anything is served
 * from it: the wasm the contract runs must hash to `MARKET_WASM_HASH` (the
 * committed release build), and each listed token must be `token_allowed`. A
 * wrong contract is a network never served (logged for the operator); a token
 * the owner has not allowed yet is left out until it is.
 */
@Injectable()
export class MarketReader {
  private readonly logger = new Logger(MarketReader.name);
  private readonly verified = new Map<string, Verification>();
  private readonly inFlight = new Map<string, Promise<Verification>>();
  private readonly configs = new TtlCache<P2pMarketConfig>(CONFIG_READ_TTL_MS, 64);
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
          this.logger.warn(`Deployment ${d.network} could not be checked: ${String(err)}`);
          return { at: 0, live: null };
        }),
      ),
    );
    return checks.flatMap((c) => (c.live ? [c.live] : []));
  }

  /**
   * The deployment a request names, verified: `400 network_unsupported` when
   * none is configured, `503` when the configured contract is not this build's
   * P2PMarket (or allows none of the listed tokens).
   */
  async requireLive(tier: Tier, network: string): Promise<Deployment> {
    const configured = this.deployments.require(tier, network);
    const check = await this.verify(configured);
    if (!check.live) {
      throw ApiError.unavailable(
        `The market is not available on ${configured.name} right now.`,
        `${configured.contract} on ${network} is not this build's P2PMarket or allows none of the listed tokens.`,
      );
    }
    return check.live;
  }

  /** Forgets every cached verification and read (tests, and after a redeploy). */
  reset(): void {
    this.verified.clear();
    this.configs.clear();
    this.balances.clear();
    this.terms.clear();
  }

  private verify(d: Deployment): Promise<Verification> {
    const key = `${d.network}:${d.contract}`;
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
    const hash = await this.chain.contractWasmHash(d, d.contract);
    if (hash !== MARKET_WASM_HASH.toLowerCase()) {
      this.logger.error(
        `Deployment ${d.network} at ${d.contract} is not this build's P2PMarket ` +
          `(wasm ${hash ?? 'none'}, expected ${MARKET_WASM_HASH}): the network is not served.`,
      );
      return { at: Date.now(), live: null };
    }
    const allowed = await Promise.all(
      d.tokens.map((t) =>
        this.view<boolean>(d, 'token_allowed', p2pCall.tokenAllowed(d.contract, t.contract)),
      ),
    );
    const tokens = d.tokens.filter((_, i) => allowed[i]);
    const refused = d.tokens.filter((_, i) => !allowed[i]);
    if (refused.length > 0) {
      this.logger.warn(
        `Deployment ${d.network}: ${refused.map((t) => t.symbol).join(', ')} not allowed by the contract (set_token): not served there.`,
      );
    }
    return { at: Date.now(), live: tokens.length > 0 ? { ...d, tokens } : null };
  }

  /**
   * A view call, simulated from a placeholder source (nothing is signed or
   * sent). A contract error is a `ChainCallReverted` naming it.
   */
  async view<T>(n: StellarNetwork, fn: string, op: xdr.Operation): Promise<T> {
    const tx = new TransactionBuilder(new Account(contract.NULL_ACCOUNT, '0'), {
      fee: BASE_FEE,
      networkPassphrase: n.passphrase,
    })
      .addOperation(op)
      .setTimeout(60)
      .build();
    const sim = await this.chain.simulate(n, tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new ChainCallReverted(
        refusalName(sim, (id) => this.deployments.isMarket(id)),
        sim.error,
      );
    }
    if (!sim.result) throw new Error(`${fn}: the simulation answered no result`);
    return decodeResult<T>(fn, sim.result.retval);
  }

  /** `config()`, read at most once a minute per deployment unless `fresh`. */
  config(d: Deployment, fresh = false): Promise<P2pMarketConfig> {
    const load = async () =>
      toMarketConfig(
        await this.view<Record<string, unknown>>(d, 'config', p2pCall.config(d.contract)),
      );
    if (fresh) return load();
    return this.configs.get(`${d.network}:${d.contract}`, load);
  }

  /** The protocol fee and pause state, from `config()`. */
  async protocolState(d: Deployment): Promise<ProtocolState> {
    const c = await this.config(d);
    return { feeBps: c.protocolFeeBps, paused: c.paused };
  }

  /** An account's free balance of `token` (its SAC) in the contract (cached briefly unless `fresh`). */
  balanceOf(d: Deployment, account: string, token: string, fresh = false): Promise<bigint> {
    const load = async () =>
      BigInt(
        await this.view<bigint>(d, 'balance_of', p2pCall.balanceOf(d.contract, account, token)),
      );
    if (fresh) return load();
    return this.balances.get(`${d.network}:${account}:${token}`, load);
  }

  /** What `seller` allows the matcher (cached briefly unless `fresh`). */
  matcherTerms(
    d: Deployment,
    seller: string,
    matcher: string,
    fresh = false,
  ): Promise<P2pMatcherTerms> {
    const load = async () =>
      toMatcherTerms(
        await this.view<Record<string, unknown>>(
          d,
          'matcher_terms_of',
          p2pCall.matcherTermsOf(d.contract, seller, matcher),
        ),
      );
    if (fresh) return load();
    return this.terms.get(`${d.network}:${seller}:${matcher}`, load);
  }

  /** An order as the contract stores it, or null when there is none. */
  async getOrder(d: Deployment, id: bigint): Promise<P2pChainOrder | null> {
    try {
      return toChainOrder(
        await this.view<Record<string, unknown>>(d, 'get_order', p2pCall.getOrder(d.contract, id)),
      );
    } catch (err) {
      if (err instanceof ChainCallReverted && err.contractError === 'UnknownOrder') return null;
      throw err;
    }
  }

  /** The id of the order `opener` opened with `refId`, or 0n. */
  async orderIdOf(d: Deployment, opener: string, refId: string): Promise<bigint> {
    return BigInt(
      await this.view<bigint>(d, 'order_id_of', p2pCall.orderIdOf(d.contract, opener, refId)),
    );
  }

  /** The arbiter the contract names now. */
  async arbiter(d: Deployment): Promise<string> {
    return (await this.config(d, true)).arbiter;
  }
}
