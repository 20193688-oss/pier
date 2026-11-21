import { NETWORKS } from '@/chain/networks';
import type { DevApi } from '@/dev/dev-api';
import { P2P_CURRENCY_CODES, type P2pCurrency } from '@/p2p/domain/constants';

/**
 * Live reference prices for the dev stack's merchants (testnet and local
 * only): what one US dollar (a USD stablecoin) is worth in each local currency
 * the market lists, and what one lumen is worth in dollars, read from public
 * MAINNET sources that need no key and get no personal data:
 *
 *   - stablecoin → local money: CriptoYa's USDT quotes per exchange
 *     (`https://criptoya.com/api/usdt/<currency>/1`), the median of the
 *     exchanges' mid prices; a currency CriptoYa does not answer falls back to
 *     an FX API (`https://open.er-api.com/v6/latest/USD`);
 *   - XLM → USD: the mid of the best bid and ask of the XLM/USDC order book on
 *     the Stellar mainnet public Horizon (Circle's USDC), read only.
 *
 * A source that fails keeps the last good price (and says so in the log); the
 * feed never throws. Merchants price their offers around these references with
 * their own spread ({@link offerPrice}).
 */

/** The currencies the market prices: every one it lists (`P2P_CURRENCIES`, Bolivia first). */
export const PRICE_CURRENCIES: readonly P2pCurrency[] = P2P_CURRENCY_CODES;
export type PriceCurrency = P2pCurrency;

/**
 * Rough local money per US dollar, used only while the feed has no price yet
 * (a new merchant's first offers); the price loop corrects them within a
 * minute.
 */
export const APPROX_USD: Readonly<Record<PriceCurrency, number>> = {
  BOB: 11.9,
  ARS: 1_700,
  BRL: 5.9,
  MXN: 19,
  COP: 3_400,
  PEN: 3.45,
  CLP: 1_010,
};
/** Rough US dollars per lumen, on the same terms. */
export const APPROX_XLM_USD = 0.13;

export const CRIPTOYA_URL = 'https://criptoya.com/api/usdt';
export const FX_URL = 'https://open.er-api.com/v6/latest/USD';
export const MAINNET_HORIZON_URL = 'https://horizon.stellar.org';
/** Circle's USDC issuer on mainnet: the dollar side of the XLM reference. */
export const MAINNET_USDC_ISSUER = NETWORKS.mainnet.usdcIssuer as string;

/** Token symbols worth one US dollar (the local network's dev dollar TUSD included). */
export const USD_TOKENS: ReadonlySet<string> = new Set(['USDC', 'TUSD', 'USDT']);
/** The lumen's symbol. */
export const LUMEN_SYMBOL = 'XLM';

/** A quote older than this (CriptoYa's `time`) is ignored. */
const MAX_QUOTE_AGE_SECONDS = 24 * 3600;
/** An exchange whose bid exceeds its ask by more than this is ignored (a broken book). */
const MAX_CROSSED = 1.005;
/** Order book levels smaller than this are dust and ignored. */
const MIN_BOOK_AMOUNT = 1;
/** The widest XLM/USDC spread accepted as a market, relative to the mid. */
const MAX_BOOK_SPREAD = 0.05;
/**
 * A currency CriptoYa stops answering keeps its last CriptoYa price this long
 * before the FX fallback replaces it (an FX rate can differ from the crypto
 * market's, e.g. in Argentina).
 */
const FX_FALLBACK_AFTER_MS = 30 * 60 * 1000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const finite = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Local money per USDT from a CriptoYa answer (`{ <exchange>: { ask, bid,
 * time, ... } }`): the median of every exchange's (ask + bid) / 2, leaving
 * out empty, crossed and stale quotes. Null when no exchange qualifies.
 */
export function criptoYaMid(body: unknown, nowSeconds = Date.now() / 1000): number | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const mids: number[] = [];
  for (const quote of Object.values(body as Record<string, unknown>)) {
    if (!quote || typeof quote !== 'object') continue;
    const q = quote as Record<string, unknown>;
    const ask = finite(q.ask);
    const bid = finite(q.bid);
    if (ask === null || bid === null || bid > ask * MAX_CROSSED) continue;
    const time = finite(q.time);
    if (time !== null && nowSeconds - time > MAX_QUOTE_AGE_SECONDS) continue;
    mids.push((ask + bid) / 2);
  }
  return median(mids);
}

/** Local money per US dollar from an open.er-api answer, or null. */
export function fxRate(body: unknown, currency: string): number | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { result?: unknown; base_code?: unknown; rates?: Record<string, unknown> };
  if (b.result !== 'success' || b.base_code !== 'USD' || !b.rates) return null;
  return finite(b.rates[currency]);
}

/**
 * The mid price of a Horizon order book (counter per base: USDC per XLM),
 * from its best bid and ask that are not dust. Null for an empty, crossed or
 * too wide book.
 */
export function orderBookMid(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { bids?: unknown; asks?: unknown };
  const best = (levels: unknown): number | null => {
    if (!Array.isArray(levels)) return null;
    for (const level of levels) {
      const l = level as { price?: unknown; amount?: unknown };
      const price = finite(l?.price);
      const amount = finite(l?.amount);
      if (price !== null && amount !== null && amount >= MIN_BOOK_AMOUNT) return price;
    }
    return null;
  };
  const bid = best(b.bids);
  const ask = best(b.asks);
  if (bid === null || ask === null || bid > ask) return null;
  const mid = (bid + ask) / 2;
  return (ask - bid) / mid > MAX_BOOK_SPREAD ? null : mid;
}

/** The mainnet Horizon order book of XLM against Circle's USDC. */
export function xlmUsdcBookUrl(horizon = MAINNET_HORIZON_URL): string {
  const q = new URLSearchParams({
    selling_asset_type: 'native',
    buying_asset_type: 'credit_alphanum4',
    buying_asset_code: 'USDC',
    buying_asset_issuer: MAINNET_USDC_ISSUER,
    limit: '10',
  });
  return `${horizon}/order_book?${q.toString()}`;
}

/**
 * A merchant's price for one side of a reference: it sells tokens above the
 * reference and buys them below it, by `spreadBps` each way. At most six
 * decimals (what an offer's price takes), trailing zeros dropped.
 */
export function offerPrice(
  reference: number,
  side: 'SELL_TOKEN' | 'BUY_TOKEN',
  spreadBps: number,
): string {
  const factor = side === 'SELL_TOKEN' ? 1 + spreadBps / 10_000 : 1 - spreadBps / 10_000;
  const price = reference * factor;
  const text = price.toFixed(6).replace(/\.?0+$/, '');
  return text === '0' || text === '' ? '0.000001' : text;
}

/** One reference with where and when it came from. */
export interface Reference {
  value: number;
  source: string;
  at: Date;
}

/** What the feed knows now. */
export interface PriceSnapshot {
  /** Local money per US dollar, by currency. */
  usd: Partial<Record<PriceCurrency, Reference>>;
  /** US dollars per lumen. */
  xlmUsd: Reference | null;
}

export interface PriceFeedOptions {
  fetch?: FetchLike;
  log?: (message: string) => void;
  /** Each request's timeout, ms (default 10 s). */
  timeoutMs?: number;
  currencies?: readonly PriceCurrency[];
  criptoYaUrl?: string;
  fxUrl?: string;
  horizonUrl?: string;
  now?: () => Date;
}

/**
 * The dev stack's reference prices: `refresh()` reads every source and keeps
 * the last good value of each when one fails; `reference()` prices one token
 * in one currency from what it holds. Never throws.
 */
export class PriceFeed {
  private readonly fetchFn: FetchLike;
  private readonly log: (message: string) => void;
  private readonly timeoutMs: number;
  private readonly currencies: readonly PriceCurrency[];
  private readonly now: () => Date;
  private readonly urls: { criptoYa: string; fx: string; horizon: string };
  private readonly state: PriceSnapshot = { usd: {}, xlmUsd: null };

  constructor(options: PriceFeedOptions = {}) {
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.log = options.log ?? (() => undefined);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.currencies = options.currencies ?? PRICE_CURRENCIES;
    this.now = options.now ?? (() => new Date());
    this.urls = {
      criptoYa: (options.criptoYaUrl ?? CRIPTOYA_URL).replace(/\/+$/, ''),
      fx: options.fxUrl ?? FX_URL,
      horizon: (options.horizonUrl ?? MAINNET_HORIZON_URL).replace(/\/+$/, ''),
    };
  }

  /** A copy of what the feed holds. */
  snapshot(): PriceSnapshot {
    return { usd: { ...this.state.usd }, xlmUsd: this.state.xlmUsd };
  }

  private async json(url: string): Promise<unknown> {
    const res = await this.fetchFn(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  private keep(what: string, why: unknown, last: Reference | null | undefined): void {
    const reason = why instanceof Error ? why.message : String(why);
    this.log(
      last
        ? `${what}: ${reason}; keeping ${last.value} (${last.source}, ${last.at.toISOString()})`
        : `${what}: ${reason}; no price yet`,
    );
  }

  /** Reads every source once; a failed one keeps its last good value. */
  async refresh(): Promise<PriceSnapshot> {
    const at = this.now();
    const missing: PriceCurrency[] = [];
    await Promise.all([
      ...this.currencies.map(async (currency) => {
        try {
          const mid = criptoYaMid(
            await this.json(`${this.urls.criptoYa}/${currency.toLowerCase()}/1`),
            at.getTime() / 1000,
          );
          if (mid === null) throw new Error('no usable quote');
          this.state.usd[currency] = { value: mid, source: 'criptoya', at };
        } catch (err) {
          const last = this.state.usd[currency];
          if (
            last?.source === 'criptoya' &&
            at.getTime() - last.at.getTime() < FX_FALLBACK_AFTER_MS
          ) {
            this.keep(`USD/${currency} (criptoya)`, err, last);
          } else {
            missing.push(currency);
            this.log(
              `USD/${currency} (criptoya): ${err instanceof Error ? err.message : String(err)}; trying the fx fallback`,
            );
          }
        }
      }),
      (async () => {
        try {
          const mid = orderBookMid(await this.json(xlmUsdcBookUrl(this.urls.horizon)));
          if (mid === null) throw new Error('the XLM/USDC book has no usable bid and ask');
          this.state.xlmUsd = { value: mid, source: 'horizon mainnet XLM/USDC', at };
        } catch (err) {
          this.keep('XLM/USD', err, this.state.xlmUsd);
        }
      })(),
    ]);
    if (missing.length > 0) {
      let fx: unknown = null;
      try {
        fx = await this.json(this.urls.fx);
      } catch (err) {
        for (const currency of missing) {
          this.keep(`USD/${currency} (fx fallback)`, err, this.state.usd[currency]);
        }
      }
      if (fx !== null) {
        for (const currency of missing) {
          const rate = fxRate(fx, currency);
          if (rate === null) {
            this.keep(`USD/${currency} (fx fallback)`, 'no rate', this.state.usd[currency]);
          } else {
            this.state.usd[currency] = { value: rate, source: 'open.er-api', at };
          }
        }
      }
    }
    return this.snapshot();
  }

  /**
   * Local money per ONE token: a USD token at the dollar's rate, the lumen at
   * its dollar price times that rate. Null when the feed has no price for it
   * (or does not know the token).
   */
  reference(symbol: string, currency: string): number | null {
    const usd = this.state.usd[currency as PriceCurrency]?.value ?? null;
    if (usd === null) return null;
    if (USD_TOKENS.has(symbol.toUpperCase())) return usd;
    if (symbol.toUpperCase() === LUMEN_SYMBOL) {
      return this.state.xlmUsd ? this.state.xlmUsd.value * usd : null;
    }
    return null;
  }

  /** A one-line summary for the log. */
  describe(): string {
    const usd = PRICE_CURRENCIES.map((c) => {
      const r = this.state.usd[c];
      return r ? `${c} ${round(r.value)}${r.source === 'criptoya' ? '' : '*'}` : `${c} ?`;
    }).join(' ');
    const xlm = this.state.xlmUsd ? round(this.state.xlmUsd.value, 5) : '?';
    return `USD→ ${usd} | XLM→USD ${xlm}`;
  }
}

function round(value: number, digits = 2): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: digits, useGrouping: false });
}

/** An offer as `GET /v1/p2p/offers` lists it (the fields the price loop reads). */
interface ListedOffer {
  id: string;
  side: 'SELL_TOKEN' | 'BUY_TOKEN';
  tokenSymbol: string;
  currency: string;
  price: string;
  active: boolean;
}

/** What one refresh of a merchant's offers did. */
export interface OfferRefresh {
  /** Offers repriced from the feed. */
  priced: number;
  /** Offers the feed cannot price: kept at their price, their lifetime renewed. */
  kept: number;
  failed: number;
}

/**
 * Reprices every active offer of a merchant (its API key) from the feed with
 * its spread, through the public API (`PATCH /v1/p2p/offers/{id}`, which also
 * renews the price's lifetime). An offer the feed cannot price keeps its price
 * (still renewed), so a failing source never takes a merchant off the market.
 * A deactivated offer (e.g. in a token the merchant no longer trades) is left
 * alone.
 */
export async function refreshOfferPrices(
  api: DevApi,
  apiKey: string,
  feed: Pick<PriceFeed, 'reference'>,
  spreadBps: number,
): Promise<OfferRefresh> {
  const offers: ListedOffer[] = [];
  for (let skip = 0; ; skip += 100) {
    const page = await api.call<{ data: ListedOffer[]; total: number }>(
      'GET',
      `/v1/p2p/offers?take=100&skip=${skip}`,
      apiKey,
    );
    offers.push(...page.data);
    if (page.data.length < 100 || offers.length >= page.total) break;
  }
  const result: OfferRefresh = { priced: 0, kept: 0, failed: 0 };
  for (const offer of offers) {
    if (offer.active === false) continue;
    const reference = feed.reference(offer.tokenSymbol, offer.currency);
    const price = reference === null ? offer.price : offerPrice(reference, offer.side, spreadBps);
    try {
      await api.call('PATCH', `/v1/p2p/offers/${offer.id}`, apiKey, { price });
      if (reference === null) result.kept += 1;
      else result.priced += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
