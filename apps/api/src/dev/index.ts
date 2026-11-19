/**
 * Local development tooling, exported as `@pedospe/api/dev` for the root
 * `npm run dev:stack` and used by the e2e tests. Never imported by the
 * service itself.
 */
export {
  API_ROOT,
  anvilBinary,
  freePort,
  migrate,
  startAnvil,
  startEmbeddedPostgres,
  stopProcess,
  type RunningAnvil,
  type RunningPostgres,
} from '@/dev/infra';
export {
  DEV_MNEMONIC,
  DEV_ROLES,
  deployLocalMarket,
  devPublicClient,
  devSend,
  devWallet,
  devWallets,
  fundDevWallet,
  type DevRole,
  type DevWallet,
  type LocalDeployment,
} from '@/dev/local-chain';
export { localApiEnv } from '@/dev/local-env';
export { DevApi, refreshDevPrices, seedDevMarket, signIn, type SeedResult } from '@/dev/seed';
