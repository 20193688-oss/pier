import { Asset, Keypair, Operation, xdr, type rpc } from '@stellar/stellar-sdk';
import { spendableLumens } from '@/chain/chain-client.service';
import { submitOps } from '@/chain/market-deploy';
import { NETWORKS, tokenOf } from '@/chain/networks';
import {
  fund,
  listsTusd,
  mintTusd,
  type DevAccounts,
  type DevChain,
  type DevMarket,
} from '@/dev/stellar-dev';

/**
 * The dev market's dollar on a network, and how a dev account gets more of
 * it (testnet and local only): Circle's USDC where Circle issues it (testnet),
 * bought with test lumens on the network's DEX by throwaway friendbot
 * accounts; the stack's own TUSD where it does not (the local quickstart
 * network), minted by the dev issuer.
 */

/** Units of one token (7 decimals). */
const U = 10_000_000n;
/** The most USDC one friendbot account buys (10 000 test lumens at about 0.71 USDC each). */
const USDC_PER_FUNDER = 6_000n * U;
/** Throwaway accounts one purchase may use. */
const MAX_FUNDERS = 4;
/** Lumens a throwaway account keeps for its reserve and fees until it merges. */
const FUNDER_MARGIN = 5n * U;
/** The most a path payment may cost above its quote. */
const SLIPPAGE_PERCENT = 2n;
/** Less than this much left to buy is done. */
const DUST = U;

export interface DevDollar {
  symbol: string;
  asset: Asset;
  /** Its Stellar Asset Contract. */
  contract: string;
  /** How a holder gets more: minted by the dev issuer (TUSD), or bought on the DEX (USDC). */
  source: 'mint' | 'dex';
}

/** The dollar the dev market lists on `chain`. */
export function devDollar(chain: DevChain, market: DevMarket): DevDollar {
  if (listsTusd(chain.network)) {
    return {
      symbol: market.tusd.code,
      asset: new Asset(market.tusd.code, market.tusd.issuer),
      contract: market.tusd.contract,
      source: 'mint',
    };
  }
  const issuer = NETWORKS[chain.network].usdcIssuer as string;
  return {
    symbol: 'USDC',
    asset: new Asset('USDC', issuer),
    contract: tokenOf(chain.network, 'USDC', issuer).contract,
    source: 'dex',
  };
}

/** Base units as a classic amount (`12.3400000`). */
export function amountOf(units: bigint): string {
  return `${units / U}.${(units % U).toString().padStart(7, '0')}`;
}

/** A classic amount as base units (at most 7 decimals). */
export function unitsOf(amount: string): bigint {
  const [whole, frac = ''] = amount.split('.');
  return BigInt(whole) * U + BigInt(frac.padEnd(7, '0').slice(0, 7));
}

/** What an account holds: spendable lumens and its balance of one asset (null: no trustline). */
export interface WalletBalances {
  exists: boolean;
  lumens: bigint;
  asset: bigint | null;
}

/** Reads an account and, when `asset` is given (a classic asset, not the lumen), its trustline. */
export async function walletBalances(
  server: rpc.Server,
  address: string,
  asset: Asset | null,
): Promise<WalletBalances> {
  const accountId = Keypair.fromPublicKey(address).xdrAccountId();
  const keys = [
    xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId })),
    ...(asset
      ? [
          xdr.LedgerKey.trustline(
            new xdr.LedgerKeyTrustLine({ accountId, asset: asset.toTrustLineXdrObject() }),
          ),
        ]
      : []),
  ];
  const res = await server.getLedgerEntries(...keys);
  const find = (k: xdr.LedgerKey) =>
    res.entries.find((e) => e.key.toXdr('base64') === k.toXdr('base64'))?.val;
  const account = find(keys[0]);
  const line = keys[1] ? find(keys[1]) : undefined;
  return {
    exists: account?.type === 'account',
    lumens: account?.type === 'account' ? spendableLumens(account.account) : 0n,
    asset: line?.type === 'trustline' ? BigInt(line.trustLine.balance) : null,
  };
}

/** One path Horizon offers between the lumen and the dollar. */
export interface HorizonPath {
  source_amount: string;
  destination_amount: string;
  path: { asset_type: string; asset_code?: string; asset_issuer?: string }[];
}

/**
 * The best of Horizon's paths: for a strict-receive (a fixed amount to
 * receive) the one that costs the fewest lumens, for a strict-send (a fixed
 * amount to spend) the one that delivers the most. Null when there is none.
 */
export function bestPath(
  records: readonly HorizonPath[],
  kind: 'strict-receive' | 'strict-send',
): HorizonPath | null {
  const usable = records.filter((r) =>
    kind === 'strict-receive' ? Number(r.source_amount) > 0 : Number(r.destination_amount) > 0,
  );
  if (usable.length === 0) return null;
  return usable.reduce((best, r) =>
    kind === 'strict-receive'
      ? Number(r.source_amount) < Number(best.source_amount)
        ? r
        : best
      : Number(r.destination_amount) > Number(best.destination_amount)
        ? r
        : best,
  );
}

function pathAssets(path: HorizonPath['path']): Asset[] {
  return path.map((p) =>
    p.asset_type === 'native'
      ? Asset.native()
      : new Asset(p.asset_code as string, p.asset_issuer as string),
  );
}

async function findPath(
  horizonUrl: string,
  kind: 'strict-receive' | 'strict-send',
  query: Record<string, string>,
): Promise<HorizonPath | null> {
  const res = await fetch(`${horizonUrl}/paths/${kind}?${new URLSearchParams(query).toString()}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Horizon answered ${res.status} for a ${kind} path`);
  const body = (await res.json()) as { _embedded?: { records?: HorizonPath[] } };
  return bestPath(body._embedded?.records ?? [], kind);
}

/**
 * Buys about `units` of USDC for `to` (which must trust it) on the network's
 * DEX: each throwaway friendbot account pays a path payment from its lumens
 * straight to `to` (exactly what is left to buy, up to {@link USDC_PER_FUNDER};
 * when that costs more lumens than it has, all it can spend), then merges its
 * leftover lumens into `mergeInto`. Answers the units delivered; a missing
 * path or a failure stops early and is logged, never thrown.
 */
export async function buyUsdc(input: {
  server: rpc.Server;
  chain: DevChain;
  dollar: DevDollar;
  to: string;
  units: bigint;
  mergeInto: string;
  log: (message: string) => void;
}): Promise<bigint> {
  const { server, chain, dollar, log } = input;
  const horizon = chain.horizonUrl;
  if (dollar.source !== 'dex' || !horizon) return 0n;
  const usdc = dollar.asset;
  const startBalance = (await walletBalances(server, input.to, usdc)).asset ?? 0n;
  let delivered = 0n;
  for (let i = 0; i < MAX_FUNDERS && input.units - delivered > DUST; i++) {
    const funder = Keypair.random();
    try {
      await fund(chain.friendbotUrl, funder.publicKey());
      const budget =
        (await walletBalances(server, funder.publicKey(), null)).lumens - FUNDER_MARGIN;
      if (budget <= 0n) throw new Error('the throwaway account has no lumens to spend');
      const want =
        input.units - delivered < USDC_PER_FUNDER ? input.units - delivered : USDC_PER_FUNDER;
      const receive = await findPath(horizon, 'strict-receive', {
        source_assets: 'native',
        destination_asset_type: 'credit_alphanum4',
        destination_asset_code: usdc.getCode(),
        destination_asset_issuer: usdc.getIssuer() as string,
        destination_amount: amountOf(want),
      });
      const cost = receive ? unitsOf(receive.source_amount) : null;
      if (receive && cost !== null && cost <= budget) {
        const sendMax = (cost * (100n + SLIPPAGE_PERCENT)) / 100n;
        await submitOps(server, chain.passphrase, funder, [
          Operation.pathPaymentStrictReceive({
            sendAsset: Asset.native(),
            sendMax: amountOf(sendMax < budget ? sendMax : budget),
            destination: input.to,
            destAsset: usdc,
            destAmount: amountOf(want),
            path: pathAssets(receive.path),
          }),
        ]);
      } else {
        const send = await findPath(horizon, 'strict-send', {
          source_asset_type: 'native',
          source_amount: amountOf(budget),
          destination_assets: `${usdc.getCode()}:${usdc.getIssuer()}`,
        });
        if (!send) {
          log(`no XLM→USDC path on the ${chain.network} DEX: stopped buying USDC`);
          break;
        }
        const destMin = (unitsOf(send.destination_amount) * (100n - SLIPPAGE_PERCENT)) / 100n;
        await submitOps(server, chain.passphrase, funder, [
          Operation.pathPaymentStrictSend({
            sendAsset: Asset.native(),
            sendAmount: amountOf(budget),
            destination: input.to,
            destAsset: usdc,
            destMin: amountOf(destMin),
            path: pathAssets(send.path),
          }),
        ]);
      }
    } catch (err) {
      log(`USDC purchase stopped: ${err instanceof Error ? err.message : String(err)}`);
      break;
    } finally {
      // The throwaway account's leftover lumens are not wasted (a failure only logs).
      await submitOps(server, chain.passphrase, funder, [
        Operation.accountMerge({ destination: input.mergeInto }),
      ]).catch(() => undefined);
      delivered = await walletBalances(server, input.to, usdc).then(
        (b) => (b.asset ?? 0n) - startBalance,
        () => delivered,
      );
    }
  }
  return delivered;
}

/**
 * Gives `to` (which must trust the dollar) about `units` more of it: minted
 * by the dev issuer (TUSD), or bought on the DEX (USDC, leftover lumens
 * merged into `mergeInto`). Answers the units delivered.
 */
export async function obtainDollars(input: {
  server: rpc.Server;
  chain: DevChain;
  accounts: DevAccounts;
  dollar: DevDollar;
  to: string;
  units: bigint;
  mergeInto: string;
  log: (message: string) => void;
}): Promise<bigint> {
  if (input.units <= 0n) return 0n;
  if (input.dollar.source === 'mint') {
    await mintTusd(input.server, input.chain, input.accounts.issuer, input.to, input.units);
    return input.units;
  }
  return buyUsdc(input);
}
