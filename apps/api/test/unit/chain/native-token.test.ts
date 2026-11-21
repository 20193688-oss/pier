import { Asset, Keypair, Networks, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ChainClient, spendableLumens, type AccountState } from '@/chain/chain-client.service';
import { DeploymentsService, type StellarNetwork } from '@/chain/deployments.service';
import {
  assetOf,
  isAssetOf,
  isNativeToken,
  nativeTokenOf,
  tableTokens,
  tokenOf,
} from '@/chain/networks';
import { TxBuilder } from '@/chain/tx-builder.service';
import { extraTokenEntry, loadConfig } from '@/config/env';
import { AppWalletService, balancesView } from '@/p2p/app-wallet.service';

const USDC = tokenOf('testnet', 'USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
const XLM = nativeTokenOf('testnet');
const XLM_UNIT = 10_000_000n;

/** An account entry as the ledger holds it, with liabilities and sponsorship counts. */
function accountEntry(
  address: string,
  input: {
    balance: bigint;
    subentries?: number;
    selling?: bigint;
    sponsored?: number;
    sponsoring?: number;
  },
): xdr.AccountEntry {
  const ext =
    input.selling === undefined && input.sponsored === undefined && input.sponsoring === undefined
      ? xdr.AccountEntryExt.v0()
      : xdr.AccountEntryExt.v1(
          new xdr.AccountEntryExtensionV1({
            liabilities: new xdr.Liabilities({ buying: 0n, selling: input.selling ?? 0n }),
            ext:
              input.sponsored === undefined && input.sponsoring === undefined
                ? xdr.AccountEntryExtensionV1Ext.v0()
                : xdr.AccountEntryExtensionV1Ext.v2(
                    new xdr.AccountEntryExtensionV2({
                      numSponsored: input.sponsored ?? 0,
                      numSponsoring: input.sponsoring ?? 0,
                      signerSponsoringIDs: [],
                      ext: xdr.AccountEntryExtensionV2Ext.v0(),
                    }),
                  ),
          }),
        );
  return new xdr.AccountEntry({
    accountId: Keypair.fromPublicKey(address).xdrAccountId(),
    balance: input.balance,
    seqNum: 7n,
    numSubEntries: input.subentries ?? 0,
    inflationDest: null,
    flags: 0,
    homeDomain: '',
    thresholds: Buffer.from([1, 0, 0, 0]),
    signers: [],
    ext,
  });
}

const NETWORK: StellarNetwork = {
  network: 'testnet',
  tier: 'test',
  name: 'Stellar Testnet',
  passphrase: Networks.TESTNET,
  rpcUrl: 'http://rpc.invalid',
  horizonUrl: null,
  publicRpcUrl: null,
  publicHorizonUrl: null,
  explorerUrl: null,
  friendbotUrl: null,
};

/** A chain client whose `getLedgerEntries` answers from `entries` (no network). */
function chainWith(entries: { key: xdr.LedgerKey; val: xdr.LedgerEntryData }[]) {
  const client = new ChainClient({ timeoutMs: () => 1000 } as unknown as DeploymentsService);
  const asked: xdr.LedgerKey[][] = [];
  vi.spyOn(client, 'ledgerEntries').mockImplementation(async (_n, keys) => {
    asked.push(keys);
    const wanted = new Set(keys.map((k) => k.toXdr('base64')));
    return {
      latestLedger: 1,
      entries: entries.filter((e) => wanted.has(e.key.toXdr('base64'))),
    } as unknown as Awaited<ReturnType<ChainClient['ledgerEntries']>>;
  });
  return { client, asked };
}

function accountKey(address: string): xdr.LedgerKey {
  return xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }),
  );
}

function trustlineKey(address: string, asset: Asset): xdr.LedgerKey {
  return xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: Keypair.fromPublicKey(address).xdrAccountId(),
      asset: asset.toTrustLineXdrObject(),
    }),
  );
}

function trustlineEntry(address: string, asset: Asset, balance: bigint): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.trustline(
    new xdr.TrustLineEntry({
      accountId: Keypair.fromPublicKey(address).xdrAccountId(),
      asset: asset.toTrustLineXdrObject(),
      balance,
      limit: (1n << 63n) - 1n,
      flags: 1,
      ext: xdr.TrustLineEntryExt.v0(),
    }),
  );
}

describe('the native lumen as a market token', () => {
  it('is XLM with no issuer, through the native Stellar Asset Contract', () => {
    expect(XLM).toEqual({
      symbol: 'XLM',
      code: 'XLM',
      issuer: null,
      contract: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      decimals: 7,
    });
    expect(nativeTokenOf('mainnet').contract).toBe(
      'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
    );
    expect(isNativeToken(XLM)).toBe(true);
    expect(isNativeToken(USDC)).toBe(false);
    expect(assetOf(XLM).isNative()).toBe(true);
    expect(assetOf(USDC).getIssuer()).toBe(USDC.issuer);
  });

  it('matches only the lumen as its asset, never a classic asset coded XLM', () => {
    const issuer = Keypair.random().publicKey();
    expect(isAssetOf(XLM, Asset.native())).toBe(true);
    expect(isAssetOf(XLM, new Asset('XLM', issuer))).toBe(false);
    expect(isAssetOf(USDC, Asset.native())).toBe(false);
    expect(isAssetOf(USDC, new Asset('USDC', USDC.issuer as string))).toBe(true);
  });

  it('is not in the mainnet table (the operator lists it there once decided)', () => {
    expect(tableTokens('mainnet').map((t) => t.symbol)).toEqual(['USDC']);
    expect(tableTokens('testnet').map((t) => t.symbol)).toEqual(['USDC']);
  });
});

describe('P2P_<NET>_TOKENS with the native lumen', () => {
  const base = {
    DATABASE_URL: 'postgresql://x@localhost/x',
    DATA_ENCRYPTION_KEY: 'ab'.repeat(32),
  };
  const tusdIssuer = Keypair.random().publicKey();

  it('lists `{"native":true}` as XLM next to the classic tokens', () => {
    const config = loadConfig({
      ...base,
      P2P_TESTNET_TOKENS: JSON.stringify([
        { code: 'TUSD', issuer: tusdIssuer, symbol: 'TUSD' },
        { native: true, symbol: 'XLM' },
      ]),
    });
    const tokens = config.networks.testnet.tokens;
    expect(tokens.map((t) => [t.symbol, t.issuer])).toEqual([
      ['USDC', USDC.issuer],
      ['TUSD', tusdIssuer],
      ['XLM', null],
    ]);
    expect(tokens[2].contract).toBe(XLM.contract);
    expect(config.networks.mainnet.tokens.map((t) => t.symbol)).toEqual(['USDC']);
  });

  it('refuses the lumen twice, and an entry that is neither shape', () => {
    expect(() =>
      loadConfig({
        ...base,
        P2P_TESTNET_TOKENS: JSON.stringify([{ native: true }, { native: true, symbol: 'XLM' }]),
      }),
    ).toThrow(/XLM is listed twice/);
    expect(() =>
      loadConfig({ ...base, P2P_TESTNET_TOKENS: JSON.stringify([{ native: true, code: 'X' }]) }),
    ).toThrow(/P2P_TESTNET_TOKENS/);
    expect(() =>
      loadConfig({ ...base, P2P_TESTNET_TOKENS: JSON.stringify([{ native: false }]) }),
    ).toThrow(/P2P_TESTNET_TOKENS/);
  });

  it('prints a token back as its environment entry', () => {
    expect(extraTokenEntry(XLM)).toEqual({ native: true, symbol: 'XLM' });
    const tusd = tokenOf('testnet', 'TUSD', tusdIssuer);
    expect(extraTokenEntry(tusd)).toEqual({ code: 'TUSD', issuer: tusdIssuer, symbol: 'TUSD' });
  });

  it('finds the lumen by symbol, by `native` and by its contract, never by CODE:null', () => {
    const d = { tokens: [USDC, XLM] };
    const deployments = Object.create(DeploymentsService.prototype) as DeploymentsService;
    expect(deployments.findToken(d, 'xlm')).toBe(XLM);
    expect(deployments.findToken(d, 'native')).toBe(XLM);
    expect(deployments.findToken(d, XLM.contract)).toBe(XLM);
    expect(deployments.findToken(d, 'XLM:null')).toBeNull();
    expect(deployments.findToken(d, `USDC:${USDC.issuer}`)).toBe(USDC);
  });
});

describe('spendable lumens', () => {
  const address = Keypair.random().publicKey();

  it('is the balance less two base reserves for a bare account', () => {
    expect(spendableLumens(accountEntry(address, { balance: 10_000n * XLM_UNIT }))).toBe(
      10_000n * XLM_UNIT - XLM_UNIT,
    );
  });

  it('takes one reserve per subentry, and the selling liabilities', () => {
    const entry = accountEntry(address, {
      balance: 100n * XLM_UNIT,
      subentries: 3,
      selling: 7n * XLM_UNIT,
    });
    // (2 + 3) × 0.5 XLM reserved, 7 XLM on offer.
    expect(spendableLumens(entry)).toBe(100n * XLM_UNIT - 25n * (XLM_UNIT / 10n) - 7n * XLM_UNIT);
  });

  it('does not count reserves a sponsor pays, and counts the ones it sponsors', () => {
    // The owner's app account: created and trusted by sponsors, holding 0 XLM.
    const sponsored = accountEntry(address, { balance: 0n, subentries: 3, sponsored: 5 });
    expect(spendableLumens(sponsored)).toBe(0n);
    const sponsoredWithLumens = accountEntry(address, {
      balance: 12n * XLM_UNIT,
      subentries: 3,
      sponsored: 5,
    });
    expect(spendableLumens(sponsoredWithLumens)).toBe(12n * XLM_UNIT);
    const sponsoring = accountEntry(address, {
      balance: 12n * XLM_UNIT,
      sponsoring: 4,
    });
    expect(spendableLumens(sponsoring)).toBe(12n * XLM_UNIT - 3n * XLM_UNIT);
  });

  it('is never negative', () => {
    expect(spendableLumens(accountEntry(address, { balance: 1n, subentries: 4 }))).toBe(0n);
  });
});

describe('ChainClient.trustlines with the lumen', () => {
  const address = Keypair.random().publicKey();

  it('answers the lumen as the spendable balance, authorised, with no trustline read', async () => {
    const entry = accountEntry(address, { balance: 50n * XLM_UNIT, subentries: 1 });
    const { client, asked } = chainWith([
      { key: accountKey(address), val: xdr.LedgerEntryData.account(entry) },
      {
        key: trustlineKey(address, assetOf(USDC)),
        val: trustlineEntry(address, assetOf(USDC), 1_000n * XLM_UNIT),
      },
    ]);
    const lines = await client.trustlines(NETWORK, address, [USDC, XLM]);
    expect(lines).toEqual([
      { balance: 1_000n * XLM_UNIT, limit: (1n << 63n) - 1n, authorized: true },
      {
        balance: 50n * XLM_UNIT - 15n * (XLM_UNIT / 10n),
        limit: (1n << 63n) - 1n,
        authorized: true,
      },
    ]);
    // One read: the trustline and the account, never a trustline for the lumen.
    expect(asked).toHaveLength(1);
    expect(asked[0].map((k) => k.type)).toEqual(['trustline', 'account']);
  });

  it('answers null for the lumen of a missing account', async () => {
    const { client } = chainWith([]);
    expect(await client.trustlines(NETWORK, address, [XLM])).toEqual([null]);
  });
});

describe('the balances answer', () => {
  const state = (balance: bigint, spendable: bigint): AccountState => ({
    address: Keypair.random().publicKey(),
    sequence: 1n,
    balance,
    spendable,
    thresholds: { master: 1, low: 0, medium: 0, high: 0 },
    signers: [],
    subentries: 3,
  });

  it('keeps the owner’s USDC and shows 0 spendable lumens when sponsors pay every reserve', () => {
    const view = balancesView(
      'testnet',
      state(0n, 0n),
      [USDC, XLM],
      [{ balance: 1_000n * XLM_UNIT, limit: 1n, authorized: true }, null],
    );
    expect(view).toEqual({
      network: 'testnet',
      account: { exists: true },
      xlm: '0',
      tokens: [
        {
          symbol: 'USDC',
          contract: USDC.contract,
          amount: '10000000000',
          trustline: true,
          authorized: true,
        },
        { symbol: 'XLM', contract: XLM.contract, amount: '0', trustline: true, authorized: true },
      ],
    });
  });

  it('reports the spendable lumens, not the whole balance, as the XLM entry', () => {
    const view = balancesView(
      'testnet',
      state(100n * XLM_UNIT, 98n * XLM_UNIT),
      [USDC, XLM],
      [null, { balance: 98n * XLM_UNIT, limit: 1n, authorized: true }],
    );
    expect(view.xlm).toBe('1000000000');
    expect(view.tokens[0]).toMatchObject({ amount: '0', trustline: false, authorized: false });
    expect(view.tokens[1]).toMatchObject({
      amount: '980000000',
      trustline: true,
      authorized: true,
    });
  });

  it('needs no trustline for the lumen even before the account exists', () => {
    const view = balancesView('testnet', null, [USDC, XLM], []);
    expect(view.account.exists).toBe(false);
    expect(view.tokens[1]).toEqual({
      symbol: 'XLM',
      contract: XLM.contract,
      amount: '0',
      trustline: true,
      authorized: true,
    });
  });
});

describe('the sponsored activation for the lumen', () => {
  const sponsor = Keypair.random();
  const user = Keypair.random().publicKey();

  function builder(existing: boolean) {
    const chain = {
      account: vi.fn(async (_n: unknown, address: string) =>
        existing || address === sponsor.publicKey()
          ? { address, sequence: 5n, balance: 0n, spendable: 0n }
          : null,
      ),
      loadAccount: vi.fn(async (_n: unknown, address: string) => {
        const { Account } = await import('@stellar/stellar-sdk');
        return new Account(address, '5');
      }),
      trustlines: vi.fn(async () => [null]),
    };
    const deployments = { sponsorAddress: () => sponsor.publicKey() };
    return {
      chain,
      tx: new TxBuilder(
        chain as unknown as ChainClient,
        deployments as unknown as DeploymentsService,
      ),
    };
  }

  it('is nothing to do for an existing account: no trustline is ever asked for', async () => {
    const { tx, chain } = builder(true);
    expect(await tx.activation(NETWORK, user, XLM)).toBeNull();
    expect(chain.trustlines).not.toHaveBeenCalled();
  });

  it('only creates a missing account, sponsored, with no change_trust', async () => {
    const { tx } = builder(false);
    const built = await tx.activation(NETWORK, user, XLM);
    expect(built).not.toBeNull();
    const parsed = TransactionBuilder.fromXDR(built?.xdr as string, Networks.TESTNET);
    if (!('operations' in parsed) || !('source' in parsed)) throw new Error('not a transaction');
    expect(parsed.source).toBe(sponsor.publicKey());
    expect(parsed.operations.map((o) => o.type)).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'endSponsoringFutureReserves',
    ]);
    expect(built?.description).toBe('Create your account (the reserves are sponsored)');
  });

  it('still opens the trustline of a classic token', async () => {
    const { tx } = builder(true);
    const built = await tx.activation(NETWORK, user, USDC);
    const parsed = TransactionBuilder.fromXDR(built?.xdr as string, Networks.TESTNET);
    if (!('operations' in parsed)) throw new Error('not a transaction');
    expect(parsed.operations.map((o) => o.type)).toEqual([
      'beginSponsoringFutureReserves',
      'changeTrust',
      'endSponsoringFutureReserves',
    ]);
  });
});

describe('app transfers of the lumen', () => {
  const me = Keypair.random().publicKey();
  const friend = Keypair.random().publicKey();
  const built = {
    network: 'testnet',
    action: 'transfer',
    description: 'Send 1 XLM',
    xdr: 'AAAA',
    hash: 'ab'.repeat(32),
    expiresAt: new Date(Date.now() + 300_000),
  };

  function wallet(recipientExists: boolean) {
    const deployment = { ...NETWORK, contract: USDC.contract, tokens: [USDC, XLM] };
    const chain = {
      trustlines: vi.fn(async () => [{ balance: 50n * XLM_UNIT, limit: 1n, authorized: true }]),
      account: vi.fn(async (_n: unknown, address: string) =>
        address === friend && !recipientExists ? null : { address },
      ),
    };
    const builder = { sacTransfer: vi.fn(async () => built), payment: vi.fn(async () => built) };
    const prisma = {
      appProfile: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
      appTransfer: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          status: 'PENDING',
          origin: 'app',
          createdAt: new Date(),
          completedAt: null,
        })),
      },
    };
    const service = new AppWalletService(
      { app: { tier: 'test' }, brandName: 'Pier' } as never,
      prisma as never,
      { pick: () => deployment, token: () => XLM } as never,
      { requireLive: async () => deployment } as never,
      chain as never,
      builder as never,
      { tier: () => 'test' } as never,
      {} as never,
    );
    return { service, chain, builder };
  }

  it('sends XLM to a G account through the native SAC `transfer`, never a classic payment', async () => {
    const { service, builder } = wallet(true);
    const out = await service.createTransfer(
      { address: me } as never,
      { to: friend, token: 'XLM', amount: String(XLM_UNIT), note: 'Lunch' } as never,
    );
    expect(builder.sacTransfer).toHaveBeenCalledWith(expect.anything(), me, friend, XLM, XLM_UNIT);
    expect(builder.payment).not.toHaveBeenCalled();
    expect(out.transfer).toMatchObject({
      token: 'XLM',
      tokenContract: XLM.contract,
      note: 'Lunch',
    });
  });

  it('refuses a recipient account that does not exist (the lumen needs only the account)', async () => {
    const { service, builder } = wallet(false);
    await expect(
      service.createTransfer(
        { address: me } as never,
        { to: friend, token: 'XLM', amount: String(XLM_UNIT) } as never,
      ),
    ).rejects.toMatchObject({ code: 'recipient_cannot_receive' });
    expect(builder.sacTransfer).not.toHaveBeenCalled();
  });

  it('refuses more lumens than the spendable balance', async () => {
    const { service } = wallet(true);
    await expect(
      service.createTransfer(
        { address: me } as never,
        { to: friend, token: 'XLM', amount: String(51n * XLM_UNIT) } as never,
      ),
    ).rejects.toMatchObject({ code: 'insufficient_balance' });
  });
});
