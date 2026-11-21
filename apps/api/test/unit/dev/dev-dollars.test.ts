import { Asset, Keypair, Networks, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { NETWORKS } from '@/chain/networks';
import { loadConfig } from '@/config/env';
import { amountOf, bestPath, devDollar, unitsOf, type HorizonPath } from '@/dev/dev-dollars';
import { devExtraTokens, localApiEnv } from '@/dev/local-env';
import { devChain, listsTusd, newDevAccounts, type DevMarket } from '@/dev/stellar-dev';

const TUSD_ISSUER = Keypair.random().publicKey();
const MARKET: DevMarket = {
  contract: StrKey.encodeContract(Buffer.alloc(32, 9)),
  startLedger: 1,
  tusd: {
    code: 'TUSD',
    issuer: TUSD_ISSUER,
    contract: new Asset('TUSD', TUSD_ISSUER).contractId(Networks.TESTNET),
  },
  feeBps: 50,
};
const CIRCLE_TESTNET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

describe('the dev market’s dollar', () => {
  it('is Circle’s USDC on testnet, bought on the DEX', () => {
    expect(listsTusd('testnet')).toBe(false);
    const dollar = devDollar(devChain('testnet'), MARKET);
    expect(dollar.symbol).toBe('USDC');
    expect(dollar.source).toBe('dex');
    expect(dollar.asset.getIssuer()).toBe(CIRCLE_TESTNET);
    expect(dollar.contract).toBe(new Asset('USDC', CIRCLE_TESTNET).contractId(Networks.TESTNET));
  });

  it('is the stack’s TUSD on the local network (no Circle there), minted', () => {
    expect(NETWORKS.local.usdcIssuer).toBeNull();
    expect(listsTusd('local')).toBe(true);
    const dollar = devDollar(devChain('local'), MARKET);
    expect(dollar).toMatchObject({
      symbol: 'TUSD',
      source: 'mint',
      contract: MARKET.tusd.contract,
    });
    expect(dollar.asset.getIssuer()).toBe(TUSD_ISSUER);
  });
});

describe('the dev API’s token list', () => {
  it('lists only USDC and XLM on testnet: TUSD is gone', () => {
    expect(devExtraTokens(devChain('testnet'), MARKET)).toEqual([{ native: true, symbol: 'XLM' }]);
    const env = localApiEnv({
      port: 4100,
      databaseUrl: 'postgresql://u:p@localhost:5432/db',
      chain: devChain('testnet'),
      market: MARKET,
      accounts: newDevAccounts(),
      dataEncryptionKey: 'ab'.repeat(32),
      webOrigin: 'http://localhost:3300',
    });
    expect(JSON.parse(env.P2P_TESTNET_TOKENS)).toEqual([{ native: true, symbol: 'XLM' }]);
    const config = loadConfig(env);
    expect(config.networks.testnet.tokens.map((t) => t.symbol)).toEqual(['USDC', 'XLM']);
  });

  it('keeps the dev dollar TUSD on the local network, before XLM', () => {
    expect(devExtraTokens(devChain('local'), MARKET)).toEqual([
      { code: 'TUSD', issuer: TUSD_ISSUER, symbol: 'TUSD' },
      { native: true, symbol: 'XLM' },
    ]);
  });
});

describe('amounts', () => {
  it('turns base units into classic amounts and back', () => {
    expect(amountOf(52_345_678n)).toBe('5.2345678');
    expect(amountOf(5_000n * 10_000_000n)).toBe('5000.0000000');
    expect(unitsOf('7010.5')).toBe(70_105_000_000n);
    expect(unitsOf('214.1232626')).toBe(2_141_232_626n);
    expect(unitsOf(amountOf(123_456_789n))).toBe(123_456_789n);
  });
});

describe('bestPath', () => {
  const path = (source: string, destination: string): HorizonPath => ({
    source_amount: source,
    destination_amount: destination,
    path: [],
  });

  it('takes the cheapest path to receive a fixed amount', () => {
    const records = [path('7020', '5000'), path('7005.5', '5000'), path('7100', '5000')];
    expect(bestPath(records, 'strict-receive')).toEqual(path('7005.5', '5000'));
  });

  it('takes the path that delivers the most for a fixed spend', () => {
    const records = [path('9995', '7100'), path('9995', '7136.2'), path('9995', '0')];
    expect(bestPath(records, 'strict-send')).toEqual(path('9995', '7136.2'));
  });

  it('is null when Horizon offers no usable path', () => {
    expect(bestPath([], 'strict-receive')).toBeNull();
    expect(bestPath([path('9995', '0')], 'strict-send')).toBeNull();
  });
});
