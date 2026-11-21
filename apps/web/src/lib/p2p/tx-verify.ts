/* tx-verify.ts: before a wallet is asked to sign a transaction the API built, the page decodes the
   XDR envelope and checks it does exactly what the person agreed to, field by field. A wallet
   shows a contract call as a function name and opaque values, so this is the check the person
   cannot do by eye. A compromised or buggy API cannot slip in a fee, a longer window, another
   recipient or a second operation: anything that differs is refused, never signed. Every
   expectation field is required; nothing is "not compared", and a missing expectation is a
   refusal.

   The envelope: not a fee-bump (the API wraps it after the signature), for the market's network
   (its hash under that passphrase is the one the API stated), unsigned, its source the signed-in
   wallet, exactly one operation (the sponsored activation is the only shape with more), time
   bounds at most ten minutes ahead, and a fee under a cap.

   A contract call: the market contract (or, for a payment to a contract, the token's Stellar
   Asset Contract); the function the person pressed; every argument decoded against the
   contract's interface and equal to a trusted value; one authorization entry, signed by the
   source account, whose root is the call itself and whose only sub-invocation is the token pull
   the function makes (the exact amount, from the wallet to the market). A classic payment:
   destination, asset, amount and memo as confirmed.

   Pure; tests/unit/tx-verify.test.ts. */
import {
  FeeBumpTransaction,
  TransactionBuilder,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk/base';
import type { P2pNetwork, P2pToken, P2pTransaction } from '@/lib/p2p/types';
import { integratorBpsFor, type AcceptedQuote } from '@/lib/p2p/fees';
import { orderRef, toHex } from '@/lib/p2p/order-ref';
import { toBaseUnits } from '@/lib/p2p/amounts';
import { BAD, decodeArgs, readInvocation, type Decoded } from '@/lib/stellar/decode';
import { MARKET_FUNCTIONS } from '@/lib/stellar/market-functions';
import { SAC_TRANSFER } from '@/lib/stellar/market-interface';
import { isAccount, isDestination, STELLAR_DECIMALS } from '@/lib/stellar/network';

export { integratorBpsFor, MAX_INTEGRATOR_FEE_BPS, type AcceptedQuote } from '@/lib/p2p/fees';

/** How far ahead a transaction's upper time bound may be (the API sets at most five minutes). */
export const MAX_VALID_SECONDS = 10 * 60;
/** The most an envelope's fee may offer, in stroops (2 XLM): a Soroban call with its resource
    fee and a restore costs a fraction of that. Matters when the API does not fee-bump. */
export const MAX_FEE_STROOPS = 20_000_000;
/** A trustline opened with no limit: the classic maximum. */
export const MAX_TRUST_LIMIT = '922337203685.4775807';

/** Every term a sale's `open_with_deposit` must carry: what the person saw (the amount, the fee
    shown) and what the market publishes (the bond rate, the windows). */
export interface SaleTerms {
  /* The order's ref (64 hex digits) and the seller: the signed-in wallet. */
  ref: string;
  seller: string;
  /* The token's symbol or SAC contract. */
  token: string;
  amountUnits: string;
  /* The merchant that buys. */
  buyer: string;
  bondUnits: string;
  acceptWindow: number;
  paymentWindow: number;
  settleWindow: number;
  /* Null and 0 when the fee shown to the person was zero. */
  integrator: string | null;
  integratorFeeBps: number;
}

export type OrderAction = 'accept' | 'mark_paid' | 'release' | 'cancel' | 'dispute';

/** What the person asked for, as the screen shows it. */
export type TxExpectation =
  | ({ action: 'open_with_deposit' } & SaleTerms)
  | { action: OrderAction; orderId: string | null }
  | { action: 'deposit' | 'withdraw'; token: string; amountUnits: string }
  | { action: 'set_operator'; operator: string; perms: number }
  | { action: 'set_matcher'; matcher: string; maxPerOrderUnits: string; autoSettle: boolean }
  /* A transfer of `token` to `to` (G or M: a classic payment; C, or the native coin to anyone:
     the token contract's `transfer`), with the note as a text memo (null: no memo; a contract
     call carries none, so a native transfer's note stays off chain). */
  | { action: 'payment'; to: string; token: string; amountUnits: string; memo: string | null }
  /* The sponsored activation (docs/STELLAR.md 5.6) for the trustline of `token` (for the native
     coin, only the missing account). */
  | { action: 'activate'; token: string };

export type VerifyProblem =
  | 'shape'
  | 'fee-bump'
  | 'network'
  | 'signed'
  | 'source'
  | 'operations'
  | 'time'
  | 'fee'
  | 'memo'
  | 'target'
  | 'function'
  | 'args'
  | 'auth';

export interface VerifyContext {
  network: Pick<P2pNetwork, 'id' | 'networkPassphrase' | 'contract' | 'tokens'>;
  /* The signed-in wallet's G address. */
  wallet: string;
  /* Seconds since the epoch (tests). */
  now?: number;
}

type InvokeOp = { type: 'invokeHostFunction'; func: xdr.HostFunction; auth?: xdr.SorobanAuthorizationEntry[]; source?: string };

const tokenOf = (network: VerifyContext['network'], t: string): P2pToken | null =>
  network.tokens.find((x) => x.symbol === t || x.contract === t) ?? null;
const units = (v: string) => (/^\d+$/.test(v) ? BigInt(v) : null);
const eqUnits = (a: Decoded, b: string) => typeof a === 'bigint' && units(b) === a;

/** The transaction's envelope, parsed for the market's network, or why it cannot be. */
export function parseEnvelope(
  t: P2pTransaction,
  network: VerifyContext['network'],
): { tx: Transaction } | { problem: VerifyProblem } {
  if (!t || typeof t !== 'object' || typeof t.xdr !== 'string' || !t.xdr)
    return { problem: 'shape' };
  if (t.network !== network.id) return { problem: 'network' };
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(t.xdr, network.networkPassphrase);
  } catch {
    return { problem: 'shape' };
  }
  if (parsed instanceof FeeBumpTransaction) return { problem: 'fee-bump' };
  // The hash covers the passphrase: an envelope the API built for another network does not
  // hash to what it stated for this one.
  if (typeof t.hash !== 'string' || toHex(parsed.hash()) !== t.hash.toLowerCase())
    return { problem: 'network' };
  if (parsed.signatures.length) return { problem: 'signed' };
  return { tx: parsed };
}

/** Why `t` must not be signed (null when it may). */
export function verifyTransaction(
  t: P2pTransaction,
  ctx: VerifyContext,
  expect: TxExpectation | null | undefined,
): VerifyProblem | null {
  if (!expect || !isAccount(ctx.wallet)) return 'args';
  const parsed = parseEnvelope(t, ctx.network);
  if ('problem' in parsed) return parsed.problem;
  const { tx } = parsed;
  const now = ctx.now ?? Math.floor(Date.now() / 1000);
  const max = Number(tx.timeBounds?.maxTime ?? 0);
  if (!max || max <= now || max > now + MAX_VALID_SECONDS) return 'time';
  if (!(Number(tx.fee) > 0) || Number(tx.fee) > MAX_FEE_STROOPS) return 'fee';

  if (expect.action === 'activate') return verifyActivation(tx, ctx, expect.token);

  if (tx.source !== ctx.wallet) return 'source';
  if (tx.operations.length !== 1) return 'operations';
  const op = tx.operations[0];
  if (op.source !== undefined && op.source !== ctx.wallet) return 'source';

  if (expect.action === 'payment') return verifyPayment(tx, ctx, expect);

  if (tx.memo.type !== 'none') return 'memo';
  if (op.type !== 'invokeHostFunction') return 'function';
  const invoke = invocationOf(op as InvokeOp);
  if (!invoke) return 'function';
  if (invoke.contract !== ctx.network.contract) return 'target';
  if (invoke.fn !== expect.action) return 'function';
  const signature = MARKET_FUNCTIONS[expect.action];
  if (!signature) return 'function';
  const args = decodeArgs(invoke, signature);
  if (args === BAD) return 'args';
  const w = ctx.wallet;
  const auth = (op as InvokeOp).auth ?? [];

  switch (expect.action) {
    case 'open_with_deposit': {
      const p = args.p as Record<string, Decoded>;
      const token = tokenOf(ctx.network, expect.token);
      if (!token) return 'args';
      const ok =
        p.ref_id === expect.ref.toLowerCase() &&
        p.seller === w &&
        expect.seller === w &&
        p.buyer === expect.buyer &&
        p.token === token.contract &&
        eqUnits(p.amount, expect.amountUnits) &&
        eqUnits(p.bond, expect.bondUnits) &&
        p.accept_window === expect.acceptWindow &&
        p.payment_window === expect.paymentWindow &&
        p.settle_window === expect.settleWindow &&
        p.integrator === expect.integrator &&
        p.integrator_fee_bps === expect.integratorFeeBps;
      if (!ok) return 'args';
      return checkAuth(auth, invoke.raw, w, {
        token: token.contract,
        to: ctx.network.contract,
        amountUnits: expect.amountUnits,
      });
    }
    case 'accept':
    case 'mark_paid':
    case 'release':
    case 'cancel':
    case 'dispute': {
      // The order on screen: an order whose on-chain id is not known yet cannot be signed for.
      const ok =
        args.caller === w &&
        !!expect.orderId &&
        /^\d+$/.test(expect.orderId) &&
        args.id === BigInt(expect.orderId);
      return ok ? checkAuth(auth, invoke.raw, w, null) : 'args';
    }
    case 'deposit':
    case 'withdraw': {
      const token = tokenOf(ctx.network, expect.token);
      const ok =
        !!token &&
        args.account === w &&
        args.token === token.contract &&
        eqUnits(args.amount, expect.amountUnits);
      if (!ok) return 'args';
      return checkAuth(
        auth,
        invoke.raw,
        w,
        expect.action === 'deposit'
          ? { token: token.contract, to: ctx.network.contract, amountUnits: expect.amountUnits }
          : null,
      );
    }
    case 'set_operator':
      return args.account === w &&
        args.operator === expect.operator &&
        Number.isInteger(expect.perms) &&
        args.perms === expect.perms
        ? checkAuth(auth, invoke.raw, w, null)
        : 'args';
    case 'set_matcher':
      return args.seller === w &&
        args.matcher === expect.matcher &&
        eqUnits(args.max_per_order, expect.maxPerOrderUnits) &&
        args.auto_settle === expect.autoSettle
        ? checkAuth(auth, invoke.raw, w, null)
        : 'args';
  }
}

function invocationOf(op: InvokeOp) {
  if (!op.func || op.func.type !== 'hostFunctionTypeInvokeContract') return null;
  return readInvocation(op.func.invokeContract);
}

/** The call's authorization: one entry, signed by the source account (no other signer), whose
    root is the call itself and whose only sub-invocation, when one is expected, is the token's
    `transfer` from the wallet to `pull.to` for exactly the amount. */
function checkAuth(
  auth: readonly xdr.SorobanAuthorizationEntry[],
  root: xdr.InvokeContractArgs,
  wallet: string,
  pull: { token: string; to: string; amountUnits: string } | null,
): VerifyProblem | null {
  if (auth.length !== 1) return 'auth';
  const [entry] = auth;
  if (entry.credentials.type !== 'sorobanCredentialsSourceAccount') return 'auth';
  const fn = entry.rootInvocation.function;
  if (fn.type !== 'sorobanAuthorizedFunctionTypeContractFn' || !fn.contractFn.equals(root))
    return 'auth';
  const subs = entry.rootInvocation.subInvocations;
  if (!pull) return subs.length === 0 ? null : 'auth';
  if (subs.length !== 1 || subs[0].subInvocations.length !== 0) return 'auth';
  const sub = subs[0].function;
  if (sub.type !== 'sorobanAuthorizedFunctionTypeContractFn') return 'auth';
  const inv = readInvocation(sub.contractFn);
  if (!inv || inv.contract !== pull.token || inv.fn !== 'transfer') return 'auth';
  const a = decodeArgs(inv, SAC_TRANSFER);
  if (a === BAD) return 'auth';
  return a.from === wallet && a.to === pull.to && eqUnits(a.amount, pull.amountUnits)
    ? null
    : 'auth';
}

const memoText = (tx: Transaction): string | null => {
  if (tx.memo.type !== 'text') return null;
  const v = tx.memo.value as unknown;
  return typeof v === 'string' ? v : v instanceof Uint8Array ? new TextDecoder().decode(v) : null;
};

function verifyPayment(
  tx: Transaction,
  ctx: VerifyContext,
  expect: Extract<TxExpectation, { action: 'payment' }>,
): VerifyProblem | null {
  const token = tokenOf(ctx.network, expect.token);
  if (!token || !isDestination(expect.to) || units(expect.amountUnits) === null) return 'args';
  if (expect.to === ctx.wallet) return 'args';
  const op = tx.operations[0];
  // A contract receives through the token contract, and so does anyone receiving the native coin
  // (the API moves XLM through its Stellar Asset Contract). A contract call carries no memo: a
  // contract may not be promised one; a native transfer's note stays off chain.
  const native = token.issuer === null;
  if (expect.to.startsWith('C') || native) {
    if ((expect.to.startsWith('C') && expect.memo !== null) || tx.memo.type !== 'none') return 'memo';
    if (op.type !== 'invokeHostFunction') return 'function';
    const invoke = invocationOf(op as InvokeOp);
    if (!invoke) return 'function';
    if (invoke.contract !== token.contract) return 'target';
    if (invoke.fn !== 'transfer') return 'function';
    const a = decodeArgs(invoke, SAC_TRANSFER);
    if (a === BAD) return 'args';
    if (a.from !== ctx.wallet || a.to !== expect.to || !eqUnits(a.amount, expect.amountUnits))
      return 'args';
    return checkAuth((op as InvokeOp).auth ?? [], invoke.raw, ctx.wallet, null);
  }
  if (op.type !== 'payment') return 'function';
  if (op.destination !== expect.to) return 'args';
  if (op.asset.isNative() || op.asset.getCode() !== token.code || op.asset.getIssuer() !== token.issuer)
    return 'args';
  if (toBaseUnits(op.amount, STELLAR_DECIMALS) !== expect.amountUnits.replace(/^0+(?=\d)/, ''))
    return 'args';
  if (expect.memo === null) return tx.memo.type === 'none' ? null : 'memo';
  return memoText(tx) === expect.memo ? null : 'memo';
}

/** The sponsored activation: the sponsor begins sponsoring the wallet's reserves, creates its
    account (only when it is missing, with nothing in it), the wallet opens the token's trustline
    with no limit and ends the sponsorship. Nothing else, in that order. The native coin needs no
    trustline: its activation is only the missing account (begin, create, end). */
function verifyActivation(tx: Transaction, ctx: VerifyContext, symbol: string): VerifyProblem | null {
  const token = tokenOf(ctx.network, symbol);
  if (!token) return 'args';
  const native = token.issuer === null;
  if (tx.memo.type !== 'none') return 'memo';
  const ops = tx.operations;
  if (native ? ops.length !== 3 : ops.length !== 3 && ops.length !== 4) return 'operations';
  const src = (op: { source?: string }) => op.source ?? tx.source;
  const w = ctx.wallet;
  const [begin, ...rest] = ops;
  const end = rest[rest.length - 1];
  const trust = native ? null : rest[rest.length - 2];
  const create = native || rest.length === 3 ? rest[0] : null;
  if (begin.type !== 'beginSponsoringFutureReserves' || begin.sponsoredId !== w) return 'operations';
  const sponsor = src(begin);
  if (sponsor === w || !isAccount(sponsor)) return 'source';
  if (tx.source !== w && tx.source !== sponsor) return 'source';
  if (create) {
    if (create.type !== 'createAccount' || create.destination !== w || src(create) !== sponsor)
      return 'operations';
    if (Number(create.startingBalance) !== 0) return 'args';
    // A missing account has no sequence: the sponsor's transaction creates it.
    if (tx.source !== sponsor) return 'source';
  }
  if (native) {
    if (!create) return 'operations';
  } else {
    if (!trust || trust.type !== 'changeTrust' || src(trust) !== w) return 'operations';
    const line = trust.line as { isNative?: () => boolean; getCode?: () => string; getIssuer?: () => string };
    if (
      typeof line.getCode !== 'function' ||
      line.isNative?.() ||
      line.getCode() !== token.code ||
      line.getIssuer?.() !== token.issuer
    )
      return 'args';
    if (trust.limit !== MAX_TRUST_LIMIT) return 'args';
  }
  if (end.type !== 'endSponsoringFutureReserves' || src(end) !== w) return 'operations';
  return null;
}

export type SaleTermsProblem = 'ref' | 'buyer' | 'fee';

/** A sale's terms, from trusted sources only: its on-chain ref derived from the order's uuid (an
    answer's own `ref` is never read), the accepted quote as the person saw it (or, when this tab
    no longer has it, the order's own amount, its buyer and no fee), and the market's published
    bond rate and windows (a QR payment's are constants: src/lib/p2p/qr-pay.ts). A sale whose ref
    cannot be derived, whose buyer no source names, or whose shown fee no rate reproduces, is
    refused: `problem` says why, and nothing is signed. */
export function saleTerms(input: {
  orderId: string;
  seller: string;
  token: string;
  accepted: AcceptedQuote | null;
  order: { amountUnits: string; buyer: string | null };
  bondBps: number;
  windows: { acceptSeconds: number; paymentSeconds: number; settleSeconds: number };
}): { terms: SaleTerms; problem: null } | { terms: null; problem: SaleTermsProblem } {
  const { accepted, order, windows } = input;
  const ref = orderRef(input.orderId);
  if (!ref) return { terms: null, problem: 'ref' };
  const amountUnits = accepted?.amountUnits ?? order.amountUnits;
  const buyer = accepted?.buyer ?? order.buyer;
  if (!isAccount(buyer) || buyer === input.seller) return { terms: null, problem: 'buyer' };
  const feeUnits = accepted?.integratorFeeUnits ?? '0';
  const bps = integratorBpsFor(amountUnits, feeUnits);
  if (bps === null) return { terms: null, problem: 'fee' };
  const integrator = bps > 0 ? (accepted?.integrator ?? null) : null;
  if (bps > 0 && !isAccount(integrator)) return { terms: null, problem: 'fee' };
  return {
    problem: null,
    terms: {
      ref,
      seller: input.seller,
      token: input.token,
      amountUnits,
      buyer,
      bondUnits: ((BigInt(amountUnits) * BigInt(input.bondBps)) / 10_000n).toString(),
      acceptWindow: windows.acceptSeconds,
      paymentWindow: windows.paymentSeconds,
      settleWindow: windows.settleSeconds,
      integrator,
      integratorFeeBps: bps,
    },
  };
}
