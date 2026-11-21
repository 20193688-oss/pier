import { createHash } from 'node:crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import {
  NETWORK_IDS,
  NETWORKS,
  TIERS,
  isNetworkId,
  nativeTokenOf,
  tableTokens,
  tokenOf,
  type NetworkId,
  type Tier,
  type Token,
} from '@/chain/networks';
import { isAccountAddress, isContractAddress, isSecretSeed } from '@/common/stellar';

/**
 * The service's whole configuration, read ONCE from the environment and
 * validated here: a bad value stops the boot with every problem listed, never
 * a request later. Everything else reads `AppConfig`, never `process.env`.
 */

/** One Stellar network as configured: where to reach it, and the market there (if any). */
export interface NetworkConfig {
  id: NetworkId;
  tier: Tier;
  /** `STELLAR_<NET>_RPC_URL`, or the table's public one; null when neither. */
  rpcUrl: string | null;
  /** `STELLAR_<NET>_HORIZON_URL`, or the table's; optional. */
  horizonUrl: string | null;
  /** `P2P_<NET>_CONTRACT`: the market contract (C...), or null. */
  contract: string | null;
  /** `P2P_<NET>_START_LEDGER`: where the indexer starts when it has no cursor. */
  startLedger: number | null;
  /** The table's tokens plus `P2P_<NET>_TOKENS` (never on mainnet), the native lumen included when listed. */
  tokens: Token[];
}

/** The gasless sponsor's limits. */
export interface SponsorLimits {
  /** The most an inner transaction's fee may be, stroops. */
  maxFeeStroops: number;
  /** Fees plus reserves the sponsor commits per UTC day, stroops. */
  dailyBudgetStroops: bigint;
  /** Sponsored submissions one address may make per hour. */
  perAddressPerHour: number;
  /** Sponsored submissions one client (IP) may make per hour. */
  perIpPerHour: number;
  /** Sponsored activations one client (IP) may ask for per day. */
  activationsPerIpPerDay: number;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databaseUrl: string;
  /** The product's name, in one place (`BRAND_NAME`). */
  brandName: string;
  /** Where this API is reachable, for links it hands out. */
  publicApiUrl: string;
  /** Browser origins allowed to call with credentials (CORS) and to send cookie-authenticated writes. */
  webOrigins: string[];
  /** `trust proxy` hops (0: the socket's address is the client's). */
  trustProxy: number;
  sep10: {
    /** `SEP10_HOME_DOMAIN`: the web host (`<home domain> auth` in every challenge). */
    homeDomain: string;
    /** `SEP10_WEB_AUTH_DOMAIN`: the host serving the auth endpoint (default: the home domain). */
    webAuthDomain: string;
    /** The network challenges are signed for (`SEP10_NETWORK`). */
    network: NetworkId;
    /** `SEP10_SIGNING_SECRET`; never funded. Null: sign-in is unavailable. */
    signingSecret: string | null;
    sessionTtlSeconds: number;
  };
  cookieSecure: boolean;
  /** Accounts (G...) that may use `/v1/admin/*`. */
  adminAddresses: string[];
  /** AES-256-GCM key for personal data and webhook secrets at rest. */
  dataEncryptionKey: Buffer;
  networks: Record<NetworkId, NetworkConfig>;
  p2p: {
    /** The matcher's secret: opens orders within sellers' caps and acts for buyers, paying its own fees. */
    matcherSecret: string | null;
    merchantMaxOpenOrders: number;
    rpcTimeoutMs: number;
    /** Base URL of the hosted charge page; a charge's link is `<url>/<chargeId>`. */
    checkoutUrl: string;
  };
  sponsor: {
    /** `P2P_SPONSOR_SECRET`: fee-bumps and reserves; holds only XLM. Null: gasless is off. */
    secret: string | null;
    limits: SponsorLimits;
  };
  /** The public app (`/v1/app/*`): its tier and optional integrator fee. */
  app: {
    tier: Tier;
    integratorAddress: string | null;
    integratorFeeBps: number;
    /** Live orders one wallet may hold at once through the app. */
    maxLiveOrdersPerWallet: number;
  };
  jobs: {
    enabled: boolean;
    intervalMs: number;
    webhookIntervalMs: number;
  };
  webhooks: {
    /** Development only: allow http:// and private/loopback destinations. */
    allowInsecure: boolean;
    timeoutMs: number;
  };
  dev: {
    /** Enables `/v1/dev/*` (simulate a bank transfer); refused in production. */
    tools: boolean;
    /** Secrets of the dev accounts the dev tools may sign with (local and testnet only). */
    walletSecrets: string[];
  };
}

function bool(defaultValue: boolean) {
  return z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v === 'true' || v === '1'));
}

function int(defaultValue: number, min: number, max: number) {
  return z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return defaultValue;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer from ${min} to ${max}` });
        return z.NEVER;
      }
      return n;
    });
}

function optionalInt(min: number, max: number) {
  return z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer from ${min} to ${max}` });
        return z.NEVER;
      }
      return n;
    });
}

function list() {
  return z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
}

function json<T>(schema: z.ZodType<T>, fallback: T) {
  return z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be JSON' });
        return z.NEVER;
      }
      const result = schema.safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({ code: 'custom', message: z.prettifyError(result.error) });
        return z.NEVER;
      }
      return result.data;
    });
}

const optionalText = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : null));
const optionalUrl = z
  .string()
  .optional()
  .refine((v) => !v || URL.canParse(v), 'must be a URL')
  .transform((v) => (v ? v.replace(/\/+$/, '') : null));
const secret = z
  .string()
  .optional()
  .refine((v) => !v || isSecretSeed(v), 'must be a Stellar secret seed (S...)')
  .transform((v) => v || null);
const contract = z
  .string()
  .optional()
  .refine((v) => !v || isContractAddress(v), 'must be a contract address (C...)')
  .transform((v) => v || null);
/**
 * `P2P_<NET>_TOKENS`: extra tokens of a test network, as JSON, listed after
 * the table's (Circle's USDC where it exists). A classic asset is
 * `{"code":"TUSD","issuer":"G..."}` (the dev stack lists its own TUSD only on
 * the local network, which has no Circle); the native lumen is
 * `{"native":true}` (listed as `XLM`, through its Stellar Asset Contract, with
 * no trustline). The dev stack's testnet market lists `[{"native":true}]`:
 * USDC and XLM.
 */
export const extraTokenSchema = z.union([
  z.strictObject({
    native: z.literal(true),
    symbol: z.string().min(1).max(12).optional(),
  }),
  z.object({
    code: z.string().regex(/^[A-Za-z0-9]{1,12}$/, 'an asset code of 1 to 12 letters or digits'),
    issuer: z.string().refine((v) => isAccountAddress(v), 'must be an account address (G...)'),
    symbol: z.string().min(1).max(12).optional(),
  }),
]);
export type ExtraToken = z.infer<typeof extraTokenSchema>;
const extraTokens = json(z.array(extraTokenSchema), []);

/** A `P2P_<NET>_TOKENS` entry as the token it lists on `network`. */
export function extraTokenOf(network: NetworkId, entry: ExtraToken): Token {
  return 'native' in entry
    ? nativeTokenOf(network, entry.symbol)
    : tokenOf(network, entry.code, entry.issuer, entry.symbol ?? entry.code);
}

/** A token as its `P2P_<NET>_TOKENS` entry (what the deploy CLI prints). */
export function extraTokenEntry(token: Token): ExtraToken {
  return token.issuer === null
    ? { native: true, symbol: token.symbol }
    : { code: token.code, issuer: token.issuer, symbol: token.symbol };
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000, 1, 65535),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'is required'),
  BRAND_NAME: z.string().min(1).max(40).default('Pier'),
  PUBLIC_API_URL: z.string().url().optional(),
  WEB_ORIGINS: list(),
  TRUST_PROXY: int(0, 0, 10),
  SEP10_HOME_DOMAIN: z
    .string()
    .regex(/^[a-z0-9.-]+(:\d{1,5})?$/i, 'must be a host (and optional port)')
    .default('localhost:3000'),
  SEP10_WEB_AUTH_DOMAIN: z
    .string()
    .regex(/^[a-z0-9.-]+(:\d{1,5})?$/i, 'must be a host (and optional port)')
    .optional(),
  SEP10_NETWORK: z.enum(NETWORK_IDS).optional(),
  SEP10_SIGNING_SECRET: secret,
  SESSION_TTL_SECONDS: int(7 * 24 * 3600, 300, 90 * 24 * 3600),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  ADMIN_ADDRESSES: list(),
  DATA_ENCRYPTION_KEY: z.string().min(1, 'is required (32 bytes, hex or base64)'),
  STELLAR_LOCAL_RPC_URL: optionalUrl,
  STELLAR_LOCAL_HORIZON_URL: optionalUrl,
  STELLAR_TESTNET_RPC_URL: optionalUrl,
  STELLAR_TESTNET_HORIZON_URL: optionalUrl,
  STELLAR_MAINNET_RPC_URL: optionalUrl,
  STELLAR_MAINNET_HORIZON_URL: optionalUrl,
  P2P_LOCAL_CONTRACT: contract,
  P2P_TESTNET_CONTRACT: contract,
  P2P_MAINNET_CONTRACT: contract,
  P2P_LOCAL_START_LEDGER: optionalInt(1, 2 ** 32 - 1),
  P2P_TESTNET_START_LEDGER: optionalInt(1, 2 ** 32 - 1),
  P2P_MAINNET_START_LEDGER: optionalInt(1, 2 ** 32 - 1),
  P2P_LOCAL_TOKENS: extraTokens,
  P2P_TESTNET_TOKENS: extraTokens,
  P2P_MATCHER_SECRET: secret,
  P2P_SPONSOR_SECRET: secret,
  P2P_MERCHANT_MAX_OPEN_ORDERS: int(5, 1, 1000),
  P2P_RPC_TIMEOUT_MS: int(15_000, 1000, 120_000),
  CHECKOUT_URL: z.string().url().optional(),
  SPONSOR_MAX_FEE_STROOPS: int(2_000_000, 100, 100_000_000),
  SPONSOR_DAILY_BUDGET_XLM: int(200, 1, 10_000_000),
  SPONSOR_ADDRESS_LIMIT_PER_HOUR: int(60, 1, 100_000),
  SPONSOR_IP_LIMIT_PER_HOUR: int(240, 1, 1_000_000),
  SPONSOR_ACTIVATIONS_PER_IP_PER_DAY: int(5, 1, 100_000),
  APP_TIER: z.enum(TIERS).default('live'),
  APP_INTEGRATOR_ADDRESS: optionalText,
  APP_INTEGRATOR_FEE_BPS: int(0, 0, 500),
  APP_MAX_LIVE_ORDERS_PER_WALLET: int(3, 1, 100),
  JOBS_ENABLED: bool(true),
  JOB_INTERVAL_MS: int(5_000, 200, 3_600_000),
  WEBHOOK_INTERVAL_MS: int(2_000, 200, 3_600_000),
  WEBHOOK_TIMEOUT_MS: int(10_000, 1000, 60_000),
  WEBHOOKS_ALLOW_INSECURE: bool(false),
  DEV_TOOLS: bool(false),
  DEV_WALLET_SECRETS: list(),
});

/** A 32-byte key from hex (64 chars, optional 0x) or base64. */
export function parseKey(raw: string): Buffer | null {
  const text = raw.trim();
  const hex = text.startsWith('0x') ? text.slice(2) : text;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) {
    const bytes = Buffer.from(text, 'base64');
    if (bytes.length === 32) return bytes;
  }
  return null;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

const NET = (id: NetworkId) => id.toUpperCase() as 'LOCAL' | 'TESTNET' | 'MAINNET';

/** The account (G...) a secret seed controls. */
export function publicKeyOf(secretSeed: string): string {
  return Keypair.fromSecret(secretSeed).publicKey();
}

/** Reads and validates the environment; throws `ConfigError` listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const problems: string[] = [];
  const production = e.NODE_ENV === 'production';

  const dataEncryptionKey = parseKey(e.DATA_ENCRYPTION_KEY);
  if (!dataEncryptionKey) {
    problems.push('DATA_ENCRYPTION_KEY: must be 32 bytes, as 64 hex characters or base64');
  }

  const networks = {} as Record<NetworkId, NetworkConfig>;
  for (const id of NETWORK_IDS) {
    const n = NET(id);
    const table = NETWORKS[id];
    const extra = id === 'mainnet' ? [] : e[`P2P_${n as 'LOCAL' | 'TESTNET'}_TOKENS`];
    const tokens = [...tableTokens(id)];
    for (const t of extra) {
      const token = extraTokenOf(id, t);
      if (tokens.some((x) => x.symbol === token.symbol || x.contract === token.contract)) {
        problems.push(`P2P_${n}_TOKENS: ${token.symbol} is listed twice`);
        continue;
      }
      tokens.push(token);
    }
    const config: NetworkConfig = {
      id,
      tier: table.tier,
      rpcUrl: e[`STELLAR_${n}_RPC_URL`] ?? table.defaultRpcUrl,
      horizonUrl: e[`STELLAR_${n}_HORIZON_URL`] ?? table.defaultHorizonUrl,
      contract: e[`P2P_${n}_CONTRACT`],
      startLedger: e[`P2P_${n}_START_LEDGER`],
      tokens,
    };
    if (config.contract) {
      if (!config.rpcUrl) problems.push(`STELLAR_${n}_RPC_URL: required with P2P_${n}_CONTRACT`);
      if (config.tokens.length === 0) {
        problems.push(`P2P_${n}_TOKENS: the ${id} network lists no token for its market`);
      }
      if (production && table.devOnly) {
        problems.push(`P2P_${n}_CONTRACT: the ${id} network is refused in production`);
      }
    }
    networks[id] = config;
  }

  // The three server keys play distinct roles and must be distinct keys.
  const keys = {
    P2P_MATCHER_SECRET: e.P2P_MATCHER_SECRET,
    P2P_SPONSOR_SECRET: e.P2P_SPONSOR_SECRET,
    SEP10_SIGNING_SECRET: e.SEP10_SIGNING_SECRET,
  };
  const set = Object.entries(keys).filter(([, v]) => v !== null) as [string, string][];
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      if (set[i][1] === set[j][1]) problems.push(`${set[j][0]}: must not equal ${set[i][0]}`);
    }
  }
  if (production) {
    for (const [name, value] of Object.entries(keys)) {
      if (!value) problems.push(`${name}: required in production (three distinct keys)`);
    }
  }
  for (const [name, value] of set) {
    if (
      dataEncryptionKey &&
      Buffer.from(StrKey.decodeEd25519SecretSeed(value)).equals(dataEncryptionKey)
    ) {
      problems.push(`${name}: must not equal DATA_ENCRYPTION_KEY`);
    }
  }
  const anyContract = NETWORK_IDS.some((id) => networks[id].contract);
  if (anyContract && !e.P2P_MATCHER_SECRET) {
    problems.push('P2P_MATCHER_SECRET: required once a market contract is configured');
  }

  const appTier = e.APP_TIER;
  const sep10Network = e.SEP10_NETWORK ?? (appTier === 'live' ? 'mainnet' : 'testnet');
  if (production && NETWORKS[sep10Network].devOnly) {
    problems.push('SEP10_NETWORK: the local network is refused in production');
  }

  const appFee = e.APP_INTEGRATOR_FEE_BPS;
  if (e.APP_INTEGRATOR_ADDRESS && !isAccountAddress(e.APP_INTEGRATOR_ADDRESS)) {
    problems.push('APP_INTEGRATOR_ADDRESS: must be an account address (G...)');
  }
  if (appFee > 0 && !e.APP_INTEGRATOR_ADDRESS) {
    problems.push('APP_INTEGRATOR_ADDRESS: required when APP_INTEGRATOR_FEE_BPS > 0');
  }

  if (production && e.DEV_TOOLS) problems.push('DEV_TOOLS: refused in production');
  if (production && e.WEBHOOKS_ALLOW_INSECURE) {
    problems.push('WEBHOOKS_ALLOW_INSECURE: refused in production');
  }
  const walletSecrets = e.DEV_WALLET_SECRETS.filter((k) => {
    if (isSecretSeed(k)) return true;
    problems.push('DEV_WALLET_SECRETS: every entry must be a secret seed (S...)');
    return false;
  });
  if (walletSecrets.length > 0 && !e.DEV_TOOLS) {
    problems.push('DEV_WALLET_SECRETS: only read with DEV_TOOLS=true');
  }
  if (set.some(([, v]) => walletSecrets.includes(v))) {
    problems.push('DEV_WALLET_SECRETS: must not include a server key');
  }

  const admins: string[] = [];
  for (const a of e.ADMIN_ADDRESSES) {
    if (isAccountAddress(a)) admins.push(a);
    else problems.push(`ADMIN_ADDRESSES: ${a} is not an account address (G...)`);
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const port = e.PORT;
  const publicApiUrl = (e.PUBLIC_API_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
  const webOrigins = e.WEB_ORIGINS.length > 0 ? e.WEB_ORIGINS : ['http://localhost:3000'];
  return {
    nodeEnv: e.NODE_ENV,
    port,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    brandName: e.BRAND_NAME,
    publicApiUrl,
    webOrigins,
    trustProxy: e.TRUST_PROXY,
    sep10: {
      homeDomain: e.SEP10_HOME_DOMAIN,
      webAuthDomain: e.SEP10_WEB_AUTH_DOMAIN ?? e.SEP10_HOME_DOMAIN,
      network: sep10Network,
      signingSecret: e.SEP10_SIGNING_SECRET,
      sessionTtlSeconds: e.SESSION_TTL_SECONDS,
    },
    cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : production,
    adminAddresses: admins,
    dataEncryptionKey: dataEncryptionKey as Buffer,
    networks,
    p2p: {
      matcherSecret: e.P2P_MATCHER_SECRET,
      merchantMaxOpenOrders: e.P2P_MERCHANT_MAX_OPEN_ORDERS,
      rpcTimeoutMs: e.P2P_RPC_TIMEOUT_MS,
      checkoutUrl: (e.CHECKOUT_URL ?? `${webOrigins[0]}/pay`).replace(/\/$/, ''),
    },
    sponsor: {
      secret: e.P2P_SPONSOR_SECRET,
      limits: {
        maxFeeStroops: e.SPONSOR_MAX_FEE_STROOPS,
        dailyBudgetStroops: BigInt(e.SPONSOR_DAILY_BUDGET_XLM) * 10_000_000n,
        perAddressPerHour: e.SPONSOR_ADDRESS_LIMIT_PER_HOUR,
        perIpPerHour: e.SPONSOR_IP_LIMIT_PER_HOUR,
        activationsPerIpPerDay: e.SPONSOR_ACTIVATIONS_PER_IP_PER_DAY,
      },
    },
    app: {
      tier: appTier,
      integratorAddress: e.APP_INTEGRATOR_ADDRESS,
      integratorFeeBps: appFee,
      maxLiveOrdersPerWallet: e.APP_MAX_LIVE_ORDERS_PER_WALLET,
    },
    jobs: {
      enabled: e.JOBS_ENABLED,
      intervalMs: e.JOB_INTERVAL_MS,
      webhookIntervalMs: e.WEBHOOK_INTERVAL_MS,
    },
    webhooks: { allowInsecure: e.WEBHOOKS_ALLOW_INSECURE, timeoutMs: e.WEBHOOK_TIMEOUT_MS },
    dev: { tools: e.DEV_TOOLS, walletSecrets },
  };
}

/** The matcher's account (G...), or null. */
export function matcherAddressOf(config: AppConfig): string | null {
  return config.p2p.matcherSecret ? publicKeyOf(config.p2p.matcherSecret) : null;
}

/** A short, stable id of a key (never the key): for logs and sealed values. */
export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/** The tiers that have at least one market contract configured. */
export function tiersWithMarket(config: AppConfig): Tier[] {
  return TIERS.filter((t) =>
    NETWORK_IDS.some(
      (id) => isNetworkId(id) && config.networks[id].tier === t && config.networks[id].contract,
    ),
  );
}
