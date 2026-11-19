import { devWallet, type LocalDeployment } from '@/dev/local-chain';

/**
 * The API's environment for a local market: the dev chain on the `test` tier
 * as network `local`, the matcher's dev key, the dev tools on (they refuse
 * anything but chain 31337), and insecure webhooks allowed (local receivers).
 */
export function localApiEnv(input: {
  port: number;
  databaseUrl: string;
  rpcUrl: string;
  deployment: LocalDeployment;
  dataEncryptionKey: string;
  webOrigin?: string;
  jobsEnabled?: boolean;
}): Record<string, string> {
  const webOrigin = input.webOrigin ?? 'http://localhost:3000';
  const d = input.deployment;
  return {
    NODE_ENV: 'development',
    PORT: String(input.port),
    HOST: '127.0.0.1',
    DATABASE_URL: input.databaseUrl,
    PUBLIC_API_URL: `http://localhost:${input.port}`,
    WEB_ORIGINS: webOrigin,
    SIWE_DOMAIN: new URL(webOrigin).host,
    COOKIE_SECURE: 'false',
    DATA_ENCRYPTION_KEY: input.dataEncryptionKey,
    ADMIN_ADDRESSES: devWallet('owner').address,
    P2P_CONTRACTS_TEST: JSON.stringify({ local: d.market }),
    P2P_DEPLOY_BLOCKS_TEST: JSON.stringify({ local: d.deployBlock }),
    P2P_RPC_URLS_TEST: JSON.stringify({ local: input.rpcUrl }),
    P2P_LOCAL_TOKENS: JSON.stringify([
      { symbol: d.tokenSymbol, address: d.token, decimals: d.tokenDecimals },
    ]),
    P2P_MATCHER_PRIVATE_KEY: devWallet('matcher').privateKey,
    CHECKOUT_URL: `${webOrigin}/pay`,
    APP_TIER: 'test',
    JOBS_ENABLED: input.jobsEnabled === false ? 'false' : 'true',
    JOB_INTERVAL_MS: '1000',
    WEBHOOK_INTERVAL_MS: '1000',
    WEBHOOKS_ALLOW_INSECURE: 'true',
    DEV_TOOLS: 'true',
    DEV_WALLET_KEYS: [devWallet('merchant').privateKey, devWallet('business').privateKey].join(','),
  };
}
