import type { DevAccounts, DevChain, DevMarket } from '@/dev/stellar-dev';

/**
 * The API's environment for a dev market on the local network or testnet (the
 * `test` tier): the market and TUSD, the matcher, sponsor and SEP-10 keys (three
 * distinct dev keys), the dev tools on (they refuse mainnet), and insecure
 * webhooks allowed (local receivers). `SEP10_HOME_DOMAIN` is the web origin's
 * host, as the web signs challenges for it.
 */
export function localApiEnv(input: {
  port: number;
  databaseUrl: string;
  chain: DevChain;
  market: DevMarket;
  accounts: DevAccounts;
  dataEncryptionKey: string;
  webOrigin: string;
  jobsEnabled?: boolean;
  jobIntervalMs?: number;
}): Record<string, string> {
  const { chain, market, accounts } = input;
  const net = chain.network.toUpperCase();
  return {
    NODE_ENV: 'development',
    PORT: String(input.port),
    HOST: '127.0.0.1',
    DATABASE_URL: input.databaseUrl,
    PUBLIC_API_URL: `http://localhost:${input.port}`,
    WEB_ORIGINS: input.webOrigin,
    SEP10_HOME_DOMAIN: new URL(input.webOrigin).host,
    SEP10_NETWORK: chain.network,
    SEP10_SIGNING_SECRET: accounts.sep10.secret,
    COOKIE_SECURE: 'false',
    DATA_ENCRYPTION_KEY: input.dataEncryptionKey,
    ADMIN_ADDRESSES: accounts.owner.publicKey,
    [`STELLAR_${net}_RPC_URL`]: chain.rpcUrl,
    ...(chain.horizonUrl ? { [`STELLAR_${net}_HORIZON_URL`]: chain.horizonUrl } : {}),
    [`P2P_${net}_CONTRACT`]: market.contract,
    [`P2P_${net}_START_LEDGER`]: String(market.startLedger),
    [`P2P_${net}_TOKENS`]: JSON.stringify([
      { code: market.tusd.code, issuer: market.tusd.issuer, symbol: market.tusd.code },
    ]),
    P2P_MATCHER_SECRET: accounts.matcher.secret,
    P2P_SPONSOR_SECRET: accounts.sponsor.secret,
    CHECKOUT_URL: `${input.webOrigin}/pay`,
    APP_TIER: 'test',
    JOBS_ENABLED: input.jobsEnabled === false ? 'false' : 'true',
    JOB_INTERVAL_MS: String(input.jobIntervalMs ?? 1000),
    WEBHOOK_INTERVAL_MS: '1000',
    WEBHOOKS_ALLOW_INSECURE: 'true',
    DEV_TOOLS: 'true',
    DEV_WALLET_SECRETS: [accounts.merchant.secret, accounts.business.secret].join(','),
  };
}
