import { createHash } from 'node:crypto';
import { getAddress, isAddress, type Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { z } from 'zod';
import {
  isNetworkId,
  NETWORKS,
  TIERS,
  type NetworkId,
  type Tier,
  type Token,
} from '@/chain/networks';

/**
 * The service's whole configuration, read ONCE from the environment and
 * validated here: a bad value stops the boot with every problem listed, never
 * a request later. Everything else reads `AppConfig`, never `process.env`.
 */

export interface TierDeploymentConfig {
  /** `P2P_CONTRACTS_<TIER>`: network id → contract address (EIP-55). */
  contracts: Partial<Record<NetworkId, string>>;
  /** `P2P_DEPLOY_BLOCKS_<TIER>`: where the indexer starts. */
  deployBlocks: Partial<Record<NetworkId, number>>;
  /** `P2P_RPC_URLS_<TIER>`: a node per network (test networks have public defaults). */
  rpcUrls: Partial<Record<NetworkId, string>>;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databaseUrl: string;
  /** Where this API is reachable, for links it hands out. */
  publicApiUrl: string;
  /** Browser origins allowed to call with credentials (CORS) and to send cookie-authenticated writes. */
  webOrigins: string[];
  /** `trust proxy` hops (0: the socket's address is the client's). */
  trustProxy: number;
  siwe: {
    /** The `domain` a SIWE message must name (the web app's host). */
    domain: string;
    nonceTtlSeconds: number;
    sessionTtlSeconds: number;
  };
  cookieSecure: boolean;
  /** Wallets that may use `/v1/admin/*` (EIP-55). */
  adminAddresses: string[];
  /** AES-256-GCM key for personal data and webhook secrets at rest. */
  dataEncryptionKey: Buffer;
  p2p: {
    tiers: Record<Tier, TierDeploymentConfig>;
    /** The dev chain's tokens (`local` network only). */
    localTokens: Token[];
    /** The matcher's key: opens orders within sellers' caps and acts for buyers. */
    matcherPrivateKey: Hex | null;
    merchantMaxOpenOrders: number;
    rpcTimeoutMs: number;
    /** Base URL of the hosted charge page; a charge's link is `<url>/<chargeId>`. */
    checkoutUrl: string;
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
    /** Keys of the dev chain's wallets the dev tools may sign with. */
    walletKeys: Hex[];
  };
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

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

const address = z.string().refine((v) => isAddress(v, { strict: false }), 'must be an EVM address');
const byNetwork = <T extends z.ZodType>(value: T) => z.record(z.string(), value);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000, 1, 65535),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'is required'),
  PUBLIC_API_URL: z.string().url().optional(),
  WEB_ORIGINS: list(),
  TRUST_PROXY: int(0, 0, 10),
  SIWE_DOMAIN: z.string().default('localhost:3000'),
  SIWE_NONCE_TTL_SECONDS: int(600, 60, 3600),
  SESSION_TTL_SECONDS: int(7 * 24 * 3600, 300, 90 * 24 * 3600),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  ADMIN_ADDRESSES: list(),
  DATA_ENCRYPTION_KEY: z.string().min(1, 'is required (32 bytes, hex or base64)'),
  P2P_CONTRACTS_LIVE: json(byNetwork(address), {}),
  P2P_CONTRACTS_TEST: json(byNetwork(address), {}),
  P2P_DEPLOY_BLOCKS_LIVE: json(byNetwork(z.number().int().min(0)), {}),
  P2P_DEPLOY_BLOCKS_TEST: json(byNetwork(z.number().int().min(0)), {}),
  P2P_RPC_URLS_LIVE: json(byNetwork(z.string().url()), {}),
  P2P_RPC_URLS_TEST: json(byNetwork(z.string().url()), {}),
  P2P_LOCAL_TOKENS: json(
    z.array(
      z.object({
        symbol: z.string().min(1).max(12),
        address,
        decimals: z.number().int().min(0).max(36),
      }),
    ),
    [],
  ),
  P2P_MATCHER_PRIVATE_KEY: z
    .string()
    .optional()
    .refine((v) => !v || PRIVATE_KEY_RE.test(v), 'must be 0x + 64 hex'),
  P2P_MERCHANT_MAX_OPEN_ORDERS: int(5, 1, 1000),
  P2P_RPC_TIMEOUT_MS: int(10_000, 1000, 120_000),
  CHECKOUT_URL: z.string().url().optional(),
  APP_TIER: z.enum(TIERS).default('live'),
  APP_INTEGRATOR_ADDRESS: address.optional(),
  APP_INTEGRATOR_FEE_BPS: int(0, 0, 500),
  APP_MAX_LIVE_ORDERS_PER_WALLET: int(3, 1, 100),
  JOBS_ENABLED: bool(true),
  JOB_INTERVAL_MS: int(5_000, 200, 3_600_000),
  WEBHOOK_INTERVAL_MS: int(2_000, 200, 3_600_000),
  WEBHOOK_TIMEOUT_MS: int(10_000, 1000, 60_000),
  WEBHOOKS_ALLOW_INSECURE: bool(false),
  DEV_TOOLS: bool(false),
  DEV_WALLET_KEYS: list(),
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

function tierConfig(
  tier: Tier,
  contracts: Record<string, string>,
  deployBlocks: Record<string, number>,
  rpcUrls: Record<string, string>,
  problems: string[],
): TierDeploymentConfig {
  const suffix = tier.toUpperCase();
  const out: TierDeploymentConfig = { contracts: {}, deployBlocks: {}, rpcUrls: {} };
  for (const [id, contract] of Object.entries(contracts)) {
    if (!isNetworkId(id)) {
      problems.push(`P2P_CONTRACTS_${suffix}: ${id} is not a network id`);
      continue;
    }
    const entry = NETWORKS[id].tiers[tier];
    if (!entry) {
      problems.push(`P2P_CONTRACTS_${suffix}: ${id} has no ${tier} network`);
      continue;
    }
    out.contracts[id] = getAddress(contract);
    if (!rpcUrls[id] && !entry.defaultRpcUrl) {
      problems.push(`P2P_RPC_URLS_${suffix}: ${id} needs a node (no public default on ${tier})`);
    }
  }
  for (const [id, block] of Object.entries(deployBlocks)) {
    if (isNetworkId(id)) out.deployBlocks[id] = block;
    else problems.push(`P2P_DEPLOY_BLOCKS_${suffix}: ${id} is not a network id`);
  }
  for (const [id, url] of Object.entries(rpcUrls)) {
    if (isNetworkId(id)) out.rpcUrls[id] = url;
    else problems.push(`P2P_RPC_URLS_${suffix}: ${id} is not a network id`);
  }
  return out;
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

  const tiers: Record<Tier, TierDeploymentConfig> = {
    live: tierConfig(
      'live',
      e.P2P_CONTRACTS_LIVE,
      e.P2P_DEPLOY_BLOCKS_LIVE,
      e.P2P_RPC_URLS_LIVE,
      problems,
    ),
    test: tierConfig(
      'test',
      e.P2P_CONTRACTS_TEST,
      e.P2P_DEPLOY_BLOCKS_TEST,
      e.P2P_RPC_URLS_TEST,
      problems,
    ),
  };
  if (tiers.test.contracts.local) {
    if (production)
      problems.push('P2P_CONTRACTS_TEST: the local dev chain is refused in production');
    if (e.P2P_LOCAL_TOKENS.length === 0) {
      problems.push('P2P_LOCAL_TOKENS: the local network needs its token(s)');
    }
  }

  const matcher = (e.P2P_MATCHER_PRIVATE_KEY as Hex | undefined) ?? null;
  if (
    matcher &&
    dataEncryptionKey &&
    Buffer.from(matcher.slice(2), 'hex').equals(dataEncryptionKey)
  ) {
    problems.push('P2P_MATCHER_PRIVATE_KEY: must not equal DATA_ENCRYPTION_KEY');
  }
  const anyDeployment = TIERS.some((t) => Object.keys(tiers[t].contracts).length > 0);
  if (anyDeployment && !matcher) {
    problems.push('P2P_MATCHER_PRIVATE_KEY: required once a P2P contract is configured');
  }

  const appFee = e.APP_INTEGRATOR_FEE_BPS;
  if (appFee > 0 && !e.APP_INTEGRATOR_ADDRESS) {
    problems.push('APP_INTEGRATOR_ADDRESS: required when APP_INTEGRATOR_FEE_BPS > 0');
  }

  if (production && e.DEV_TOOLS) problems.push('DEV_TOOLS: refused in production');
  if (production && e.WEBHOOKS_ALLOW_INSECURE) {
    problems.push('WEBHOOKS_ALLOW_INSECURE: refused in production');
  }
  const walletKeys = e.DEV_WALLET_KEYS.filter((k) => {
    if (PRIVATE_KEY_RE.test(k)) return true;
    problems.push('DEV_WALLET_KEYS: every key must be 0x + 64 hex');
    return false;
  }) as Hex[];
  if (walletKeys.length > 0 && !e.DEV_TOOLS) {
    problems.push('DEV_WALLET_KEYS: only read with DEV_TOOLS=true');
  }
  if (matcher && walletKeys.some((k) => k.toLowerCase() === matcher.toLowerCase())) {
    problems.push('DEV_WALLET_KEYS: must not include the matcher key');
  }

  const admins: string[] = [];
  for (const a of e.ADMIN_ADDRESSES) {
    if (isAddress(a, { strict: false })) admins.push(getAddress(a));
    else problems.push(`ADMIN_ADDRESSES: ${a} is not an EVM address`);
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
    publicApiUrl,
    webOrigins,
    trustProxy: e.TRUST_PROXY,
    siwe: {
      domain: e.SIWE_DOMAIN,
      nonceTtlSeconds: e.SIWE_NONCE_TTL_SECONDS,
      sessionTtlSeconds: e.SESSION_TTL_SECONDS,
    },
    cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : production,
    adminAddresses: admins,
    dataEncryptionKey: dataEncryptionKey as Buffer,
    p2p: {
      tiers,
      localTokens: e.P2P_LOCAL_TOKENS.map((t) => ({ ...t, address: getAddress(t.address) })),
      matcherPrivateKey: matcher,
      merchantMaxOpenOrders: e.P2P_MERCHANT_MAX_OPEN_ORDERS,
      rpcTimeoutMs: e.P2P_RPC_TIMEOUT_MS,
      checkoutUrl: (e.CHECKOUT_URL ?? `${webOrigins[0]}/pay`).replace(/\/$/, ''),
    },
    app: {
      tier: e.APP_TIER,
      integratorAddress: e.APP_INTEGRATOR_ADDRESS ? getAddress(e.APP_INTEGRATOR_ADDRESS) : null,
      integratorFeeBps: appFee,
      maxLiveOrdersPerWallet: e.APP_MAX_LIVE_ORDERS_PER_WALLET,
    },
    jobs: {
      enabled: e.JOBS_ENABLED,
      intervalMs: e.JOB_INTERVAL_MS,
      webhookIntervalMs: e.WEBHOOK_INTERVAL_MS,
    },
    webhooks: { allowInsecure: e.WEBHOOKS_ALLOW_INSECURE, timeoutMs: e.WEBHOOK_TIMEOUT_MS },
    dev: { tools: e.DEV_TOOLS, walletKeys },
  };
}

/** The matcher's address, or null. */
export function matcherAddressOf(config: AppConfig): string | null {
  const key = config.p2p.matcherPrivateKey;
  return key ? privateKeyToAddress(key) : null;
}

/** A short, stable id of a key (never the key): for logs and sealed values. */
export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}
