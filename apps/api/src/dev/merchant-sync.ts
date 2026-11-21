import {
  Account,
  Address,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Keypair,
  type Transaction,
  type rpc,
} from '@stellar/stellar-sdk';
import { p2pCall } from '@/chain/market-codec';
import { submitOps } from '@/chain/market-deploy';
import { nativeTokenOf } from '@/chain/networks';
import { DevApi, signAndSubmit } from '@/dev/dev-api';
import { obtainDollars, walletBalances, type DevDollar } from '@/dev/dev-dollars';
import {
  marketBalanceOf,
  type DevAccounts,
  type DevChain,
  type DevMarket,
} from '@/dev/stellar-dev';
import type { P2pCurrency } from '@/p2p/domain/constants';

/**
 * Keeps a dev merchant's side of the market in the shape the dev stack wants
 * (testnet and local only), THROUGH THE API and idempotently, so a stack set
 * up before a change catches up on its next start without a reset: the
 * payment methods it lacks are added, the offers it lacks are published,
 * offers in a token it no longer trades are deactivated (never deleted), and
 * its liquidity in the market is topped up to a target. Every transaction the
 * API builds for a dev key is checked before it is signed
 * ({@link setUpCallProblem}).
 */

/** A rail account the merchant collects on (local money in) and pays from. */
export interface MerchantMethod {
  currency: P2pCurrency;
  rail: string;
  holderName: string;
  details: Record<string, string>;
  label?: string;
}

/** An offer as the merchant publishes it (`POST /v1/p2p/offers`). */
export interface MerchantOffer {
  side: 'SELL_TOKEN' | 'BUY_TOKEN';
  /** The token's symbol, as the market lists it. */
  token: string;
  currency: P2pCurrency;
  rails: string[];
  price: string;
  minFiat: string;
  maxFiat: string;
  priceTtlSeconds: number;
}

/** An offer as `GET /v1/p2p/offers` lists it (the fields the sync reads). */
export interface ListedOffer {
  id: string;
  side: string;
  /** The symbol while the token is listed; its contract address once it is not. */
  tokenSymbol: string;
  currency: string;
  rails: string[];
  minFiat: string;
  maxFiat: string;
  active: boolean;
}

/** A payment method as `GET /v1/p2p/payment-methods` lists it. */
export interface ListedMethod {
  id: string;
  currency: string;
  rail: string;
  active: boolean;
}

/** Side, token, currency and rails: what makes two offers the same offer. */
export function offerKey(o: { side: string; token: string; currency: string; rails: string[] }) {
  return [o.side, o.token, o.currency, [...o.rails].sort().join(',')].join('|');
}

/** Bounds that moved by more than this fraction are set again (e.g. a new maximum). */
const BOUNDS_DRIFT = 0.25;

const drifted = (current: string, wanted: string) =>
  Math.abs(Number(current) - Number(wanted)) > BOUNDS_DRIFT * Number(wanted);

/** What {@link planOffers} decides. */
export interface OfferPlan {
  create: MerchantOffer[];
  /** Active offers in a token the merchant no longer trades. */
  deactivate: string[];
  /** Active offers whose bounds drifted from the wanted ones. */
  resize: { id: string; minFiat: string; maxFiat: string }[];
}

/**
 * Compares a merchant's offers with the ones it should publish: an offer it
 * lacks (same side, token, currency and rails; active or not) is created, an
 * active offer in a token outside `tokens` is deactivated, and an active
 * offer whose bounds drifted is resized. Prices are the price loop's. Pure.
 */
export function planOffers(
  existing: readonly ListedOffer[],
  wanted: readonly MerchantOffer[],
  tokens: readonly string[],
): OfferPlan {
  const byKey = new Map(
    existing.map((o) => [offerKey({ ...o, token: o.tokenSymbol }), o] as const),
  );
  const plan: OfferPlan = { create: [], deactivate: [], resize: [] };
  for (const o of existing) {
    if (o.active && !tokens.includes(o.tokenSymbol)) plan.deactivate.push(o.id);
  }
  for (const w of wanted) {
    const found = byKey.get(offerKey(w));
    if (!found) {
      plan.create.push(w);
    } else if (
      found.active &&
      (drifted(found.minFiat, w.minFiat) || drifted(found.maxFiat, w.maxFiat))
    ) {
      plan.resize.push({ id: found.id, minFiat: w.minFiat, maxFiat: w.maxFiat });
    }
  }
  return plan;
}

/** The methods a merchant lacks (by currency and rail, active or not). Pure. */
export function planMethods(
  existing: readonly Pick<ListedMethod, 'currency' | 'rail'>[],
  wanted: readonly MerchantMethod[],
): MerchantMethod[] {
  const have = new Set(existing.map((m) => `${m.currency}|${m.rail}`));
  return wanted.filter((m) => !have.has(`${m.currency}|${m.rail}`));
}

// --- checks before a dev key signs what the API built ---------------------------

type InvokeOp = Extract<Transaction['operations'][number], { type: 'invokeHostFunction' }>;

/** A parsed transaction's one contract call, or why it is not one. */
function oneCall(tx: Transaction, signer: string): { problem: string } | { op: InvokeOp } {
  if (tx.source !== signer) return { problem: `the source is ${tx.source}, not ${signer}` };
  if (tx.operations.length !== 1) return { problem: 'not exactly one operation' };
  const op = tx.operations[0];
  if (op.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract') {
    return { problem: 'not a contract call' };
  }
  if (op.source && op.source !== signer) return { problem: 'the operation acts for another' };
  return { op };
}

/** The host function of `expected` as `signer` would send it. */
function hostFunctionOf(expected: xdr.Operation, signer: string, passphrase: string): string {
  const tx = new TransactionBuilder(new Account(signer, '1'), {
    fee: '100',
    networkPassphrase: passphrase,
  })
    .addOperation(expected)
    .setTimeout(60)
    .build();
  const op = tx.operations[0];
  if (op.type !== 'invokeHostFunction') throw new Error('not a contract call');
  return op.func.toXdr('base64');
}

/**
 * Why the dev keys must not sign a set-up transaction the API built, or null:
 * it must be exactly the expected market call from the signer (contract,
 * function and every argument), authorised only by the source account, and
 * any sub-invocation must be the deposit's own token pull (`transfer` of that
 * token from the signer to the market, that amount).
 */
export function setUpCallProblem(
  built: { xdr: string },
  input: {
    passphrase: string;
    signer: string;
    expected: xdr.Operation;
    pull?: { token: string; market: string; amount: bigint };
  },
): string | null {
  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(built.xdr, input.passphrase);
    if (!('operations' in parsed) || 'innerTransaction' in parsed) return 'not a transaction';
    tx = parsed;
  } catch {
    return 'not a transaction envelope';
  }
  const call = oneCall(tx, input.signer);
  if ('problem' in call) return call.problem;
  const want = hostFunctionOf(input.expected, input.signer, input.passphrase);
  if (call.op.func.toXdr('base64') !== want) return 'not the expected call';
  const pull = input.pull
    ? xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(input.pull.token).toScAddress(),
          functionName: 'transfer',
          args: [
            nativeToScVal(input.signer, { type: 'address' }),
            nativeToScVal(input.pull.market, { type: 'address' }),
            nativeToScVal(input.pull.amount, { type: 'i128' }),
          ],
        }),
      ).toXdr('base64')
    : null;
  for (const entry of call.op.auth ?? []) {
    if (entry.credentials.type !== 'sorobanCredentialsSourceAccount') {
      return 'authorised by someone other than the source account';
    }
    for (const sub of entry.rootInvocation.subInvocations) {
      if (sub.subInvocations.length > 0 || sub.function.toXdr('base64') !== pull) {
        return 'the authorisation covers another call';
      }
    }
  }
  return null;
}

// --- a merchant's session -----------------------------------------------------------

/** A dev merchant as the sync acts for it: its API key, account and (test) key. */
export interface MerchantSession {
  api: DevApi;
  apiKey: string;
  accountId: string;
  key: Keypair;
  chain: DevChain;
  market: DevMarket;
  server: rpc.Server;
}

/** Has the API build a market call for the merchant, checks it, signs it and submits it. */
async function buildCheckedAndSubmit(
  s: MerchantSession,
  action: string,
  args: Record<string, unknown>,
  expected: xdr.Operation,
  pull?: { token: string; market: string; amount: bigint },
): Promise<void> {
  const built = await s.api.call<{ xdr: string; network: string }>(
    'POST',
    '/v1/p2p/transactions',
    s.apiKey,
    { network: s.chain.network, from: s.accountId, action, args },
  );
  const problem = setUpCallProblem(built, {
    passphrase: s.chain.passphrase,
    signer: s.key.publicKey(),
    expected,
    pull,
  });
  if (problem) throw new Error(`refused to sign what the API built: ${problem}`);
  await signAndSubmit(s.api, s.apiKey, 'org', built, s.key, s.chain.passphrase);
}

/** Deposits `amount` of a token (its symbol and SAC) into the market. */
export async function depositToMarket(
  s: MerchantSession,
  symbol: string,
  contract: string,
  amount: bigint,
): Promise<void> {
  const address = s.key.publicKey();
  await buildCheckedAndSubmit(
    s,
    'deposit',
    { token: symbol, amount: amount.toString() },
    p2pCall.deposit(s.market.contract, address, contract, amount),
    { token: contract, market: s.market.contract, amount },
  );
}

/** Authorises the matcher on the merchant's balance (`setMatcher`, no auto-settle). */
export async function authoriseMatcher(
  s: MerchantSession,
  matcher: string,
  maxPerOrder: bigint,
): Promise<void> {
  await buildCheckedAndSubmit(
    s,
    'setMatcher',
    { maxPerOrder: maxPerOrder.toString(), autoSettle: false },
    p2pCall.setMatcher(s.market.contract, s.key.publicKey(), matcher, maxPerOrder, false),
  );
}

/** What {@link syncMerchantMarket} changed. */
export interface MarketSync {
  methodsAdded: number;
  offersCreated: number;
  offersDeactivated: number;
  offersResized: number;
  /** Active offers after the sync. */
  activeOffers: number;
}

/**
 * Adds the payment methods the merchant lacks, publishes the offers it lacks,
 * deactivates its active offers in tokens outside `tokens` and resizes
 * drifted bounds ({@link planOffers}). Idempotent.
 */
export async function syncMerchantMarket(
  s: MerchantSession,
  methods: readonly MerchantMethod[],
  offers: readonly MerchantOffer[],
  tokens: readonly string[],
): Promise<MarketSync> {
  const accountQuery = `accountId=${encodeURIComponent(s.accountId)}`;
  const listedMethods = await s.api.all<ListedMethod>(
    `/v1/p2p/payment-methods?${accountQuery}`,
    s.apiKey,
  );
  const missing = planMethods(listedMethods, methods);
  for (const m of missing) {
    await s.api.call('POST', '/v1/p2p/payment-methods', s.apiKey, {
      accountId: s.accountId,
      currency: m.currency,
      rail: m.rail,
      holderName: m.holderName,
      details: m.details,
      label: m.label ?? `${m.currency} account`,
    });
  }
  const listed = await s.api.all<ListedOffer>(`/v1/p2p/offers?${accountQuery}`, s.apiKey);
  const plan = planOffers(listed, offers, tokens);
  for (const id of plan.deactivate) {
    await s.api.call('PATCH', `/v1/p2p/offers/${id}`, s.apiKey, { active: false });
  }
  for (const r of plan.resize) {
    await s.api.call('PATCH', `/v1/p2p/offers/${r.id}`, s.apiKey, {
      minFiat: r.minFiat,
      maxFiat: r.maxFiat,
    });
  }
  for (const offer of plan.create) {
    await s.api.call('POST', '/v1/p2p/offers', s.apiKey, {
      accountId: s.accountId,
      network: s.chain.network,
      ...offer,
    });
  }
  const deactivated = new Set(plan.deactivate);
  return {
    methodsAdded: missing.length,
    offersCreated: plan.create.length,
    offersDeactivated: plan.deactivate.length,
    offersResized: plan.resize.length,
    activeOffers:
      listed.filter((o) => o.active && !deactivated.has(o.id)).length + plan.create.length,
  };
}

/** A one-line account of a sync, or null when it changed nothing. */
export function describeSync(r: MarketSync): string | null {
  const parts = [
    r.methodsAdded ? `${r.methodsAdded} payment methods added` : '',
    r.offersCreated ? `${r.offersCreated} offers published` : '',
    r.offersDeactivated
      ? `${r.offersDeactivated} offers deactivated (tokens no longer traded)`
      : '',
    r.offersResized ? `${r.offersResized} offers resized` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// --- liquidity ----------------------------------------------------------------------

/** Below this share of its target (percent), a merchant's dollar liquidity is topped up. */
const TOP_UP_BELOW_PERCENT = 90n;

/**
 * Tops the merchant's free dollar balance in the market up to `target` when
 * it is below 90 % of it: trusts the dollar if it does not yet, gets what its
 * wallet lacks (minted, or bought on the DEX with throwaway friendbot accounts
 * whose leftover lumens it receives) and deposits it. Answers its dollar
 * balance in the market afterwards.
 */
export async function ensureDollarLiquidity(
  s: MerchantSession,
  input: {
    dollar: DevDollar;
    accounts: DevAccounts;
    target: bigint;
    log: (message: string) => void;
  },
): Promise<bigint> {
  const { dollar, target, log } = input;
  const address = s.key.publicKey();
  const read = () =>
    marketBalanceOf(s.server, s.chain.passphrase, s.market.contract, address, dollar.contract);
  const inMarket = await read();
  if (inMarket * 100n >= target * TOP_UP_BELOW_PERCENT) return inMarket;
  const deficit = target - inMarket;
  let wallet = await walletBalances(s.server, address, dollar.asset);
  if (wallet.asset === null) {
    await submitOps(s.server, s.chain.passphrase, s.key, [
      Operation.changeTrust({ asset: dollar.asset }),
    ]);
    wallet = { ...wallet, asset: 0n };
  }
  if ((wallet.asset ?? 0n) < deficit) {
    const delivered = await obtainDollars({
      server: s.server,
      chain: s.chain,
      accounts: input.accounts,
      dollar,
      to: address,
      units: deficit - (wallet.asset ?? 0n),
      mergeInto: address,
      log,
    });
    if (delivered > 0n) log(`got ${amountText(delivered)} ${dollar.symbol} (${dollar.source})`);
    wallet = await walletBalances(s.server, address, dollar.asset);
  }
  const held = wallet.asset ?? 0n;
  const amount = held < deficit ? held : deficit;
  if (amount > 0n) {
    await depositToMarket(s, dollar.symbol, dollar.contract, amount);
    log(`deposited ${amountText(amount)} ${dollar.symbol}`);
  }
  return read();
}

/** Less than this many spare lumens are not worth a deposit. */
const MIN_LUMEN_DEPOSIT = 100n * 10_000_000n;

/**
 * Deposits the merchant's lumens above `kept` (reserves and a margin stay in
 * its wallet) into the market. Answers its lumen balance in the market.
 */
export async function depositSpareLumens(
  s: MerchantSession,
  kept: bigint,
  log: (message: string) => void,
): Promise<bigint> {
  const address = s.key.publicKey();
  const native = nativeTokenOf(s.chain.network);
  const wallet = await walletBalances(s.server, address, null);
  const spare = wallet.lumens - kept;
  if (spare >= MIN_LUMEN_DEPOSIT) {
    await depositToMarket(s, native.symbol, native.contract, spare);
    log(`deposited ${amountText(spare)} ${native.symbol}`);
  }
  return marketBalanceOf(s.server, s.chain.passphrase, s.market.contract, address, native.contract);
}

/** Base units as whole tokens, for logs. */
export function amountText(units: bigint): string {
  return (units / 10_000_000n).toLocaleString('en-US');
}
