import { Address, type Asset, type Transaction } from '@stellar/stellar-sdk';
import { MARKET_USER_FUNCTIONS } from '@/chain/market-codec';
import { isAssetOf, isNativeToken, type Token } from '@/chain/networks';
import { STELLAR_BASE_RESERVE_STROOPS } from '@/p2p/domain/constants';

/**
 * What the API agrees to submit (and, with gasless on, pay the fee for): ONE
 * operation of an allowed shape, or the sponsored-activation shape. Pure: the
 * submissions service parses the envelope, then checks who may submit for
 * the source account, the signatures, rate limits and the budget.
 *
 * Allowed shapes:
 *   - `invoke`: an `invokeContract` of the market contract, on a function a
 *     wallet calls (never an owner function), with only source-account auth;
 *   - `sac_transfer`: a SAC `transfer(from = source, to, amount)` of a listed
 *     token, with only source-account auth;
 *   - `payment`: a classic payment of a listed token (lumens only when the
 *     native token is listed), from the source;
 *   - `activation`: `begin_sponsoring_future_reserves` (source = sponsor,
 *     for the account), `create_account` with 0 XLM (source = sponsor; only
 *     for a missing account), `change_trust` of a listed CLASSIC token
 *     (source = the account), `end_sponsoring_future_reserves` (source = the
 *     account). When the native lumen is listed, creating a missing account
 *     with no trustline (begin, create, end) is an activation too: the lumen
 *     needs none. A trustline is never opened for the lumen.
 */

export type SubmissionKind = 'invoke' | 'sac_transfer' | 'payment' | 'activation';

export interface SubmitContext {
  /** The market contract on this network. */
  contract: string;
  tokens: readonly Token[];
  /** The sponsor account, or null when gasless is off. */
  sponsor: string | null;
  /** Unix seconds now. */
  now: number;
  /** The largest inner fee accepted, stroops. */
  maxFeeStroops: number;
  /** Seconds a transaction may still be valid for (the build TTL plus skew). */
  maxTtlSeconds: number;
}

export type SubmitCheck =
  | {
      ok: true;
      kind: SubmissionKind;
      /** The wallet the transaction acts for (the tx source, or the sponsored account). */
      account: string;
      /** Reserves the sponsor commits, stroops. */
      reserveStroops: bigint;
      /** Upper time bound, unix seconds. */
      maxTime: number;
    }
  | { ok: false; error: string };

type Op = Transaction['operations'][number];

const refuse = (error: string): SubmitCheck => ({ ok: false, error });

function onlySourceAuth(op: Extract<Op, { type: 'invokeHostFunction' }>): boolean {
  return (op.auth ?? []).every((a) => a.credentials.type === 'sorobanCredentialsSourceAccount');
}

/** Whether a classic asset is a listed token (the lumen only when the native token is listed). */
function listedAsset(tokens: readonly Token[], asset: Asset): boolean {
  return tokens.some((t) => isAssetOf(t, asset));
}

/** Checks the shape, time bounds and fee of a parsed inner transaction. */
export function checkSubmission(tx: Transaction, ctx: SubmitContext): SubmitCheck {
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  const minTime = Number(tx.timeBounds?.minTime ?? 0);
  if (!maxTime) return refuse('the transaction must have an upper time bound');
  if (maxTime <= ctx.now) return refuse('the transaction expired: build a new one');
  if (maxTime > ctx.now + ctx.maxTtlSeconds) {
    return refuse(`the transaction must expire within ${ctx.maxTtlSeconds} seconds`);
  }
  if (minTime > ctx.now + 60) return refuse('the transaction is not valid yet');
  if (Number(tx.fee) > ctx.maxFeeStroops) {
    return refuse(
      `the transaction's fee is above the sponsor's cap (${ctx.maxFeeStroops} stroops)`,
    );
  }
  const ops = tx.operations;
  if (ops.length === 1) return single(tx, ops[0], ctx, maxTime);
  return activation(tx, ctx, maxTime);
}

function single(tx: Transaction, op: Op, ctx: SubmitContext, maxTime: number): SubmitCheck {
  const source = tx.source;
  if (op.source && op.source !== source) {
    return refuse('the operation must act for the transaction’s source');
  }
  if (!source.startsWith('G')) return refuse('the source must be an account (G...)');
  const ok = (kind: SubmissionKind): SubmitCheck => ({
    ok: true,
    kind,
    account: source,
    reserveStroops: 0n,
    maxTime,
  });
  switch (op.type) {
    case 'invokeHostFunction': {
      if (op.func.type !== 'hostFunctionTypeInvokeContract') {
        return refuse('only contract calls are submitted (no uploads or deployments)');
      }
      const call = op.func.invokeContract;
      const contract = Address.fromScAddress(call.contractAddress).toString();
      const fn = String(call.functionName);
      if (!onlySourceAuth(op)) {
        return refuse('only the source account may authorise the call');
      }
      if (contract === ctx.contract) {
        return (MARKET_USER_FUNCTIONS as readonly string[]).includes(fn)
          ? ok('invoke')
          : refuse(`the market function ${fn} is not submitted here`);
      }
      const token = ctx.tokens.find((t) => t.contract === contract);
      if (!token) return refuse('the call must be to the market or a listed token');
      if (fn !== 'transfer' || call.args.length !== 3) {
        return refuse('only a token transfer is submitted on a token contract');
      }
      const from = call.args[0];
      if (from.type !== 'scvAddress' || Address.fromScVal(from).toString() !== source) {
        return refuse('a token transfer must be from the transaction’s source');
      }
      return ok('sac_transfer');
    }
    case 'payment':
      if (!listedAsset(ctx.tokens, op.asset)) {
        return refuse('only payments of a listed token are submitted');
      }
      return ok('payment');
    default:
      return refuse(`a ${op.type} operation is not submitted here`);
  }
}

function activation(tx: Transaction, ctx: SubmitContext, maxTime: number): SubmitCheck {
  const ops = tx.operations;
  if (!ctx.sponsor) return refuse('exactly one operation, unless it is a sponsored activation');
  if (ops.length !== 3 && ops.length !== 4) return refuse('exactly one operation is submitted');
  const [begin, ...rest] = ops;
  if (begin.type !== 'beginSponsoringFutureReserves' || begin.source !== ctx.sponsor) {
    return refuse('exactly one operation, unless it is a sponsored activation');
  }
  const account = begin.sponsoredId;
  // begin, create, end: a missing account for the native lumen, which needs no trustline.
  const createOnly = ops.length === 3 && rest[0]?.type === 'createAccount';
  if (createOnly && !ctx.tokens.some(isNativeToken)) {
    return refuse('the activation must open a trustline of a listed token, for the account');
  }
  const create = ops.length === 4 || createOnly ? rest.shift() : null;
  const [trust, end] = createOnly ? [null, rest[0]] : rest;
  if (create) {
    if (
      create.type !== 'createAccount' ||
      create.source !== ctx.sponsor ||
      create.destination !== account ||
      Number(create.startingBalance) !== 0
    ) {
      return refuse('the activation may only create the account, with 0 XLM, from the sponsor');
    }
    if (tx.source !== ctx.sponsor) {
      return refuse('an activation that creates the account has the sponsor as source');
    }
  } else if (tx.source !== account) {
    return refuse('the activation of an existing account has that account as source');
  }
  if (
    !createOnly &&
    (trust?.type !== 'changeTrust' ||
      trust.source !== account ||
      !('code' in trust.line) ||
      trust.line.isNative() ||
      !listedAsset(
        ctx.tokens.filter((t) => !isNativeToken(t)),
        trust.line,
      ))
  ) {
    return refuse('the activation must open a trustline of a listed token, for the account');
  }
  if (end?.type !== 'endSponsoringFutureReserves' || end.source !== account) {
    return refuse('the activation must end the sponsorship as the account');
  }
  return {
    ok: true,
    kind: 'activation',
    account,
    // An account takes two base reserves, a trustline one.
    reserveStroops: STELLAR_BASE_RESERVE_STROOPS * ((create ? 2n : 0n) + (createOnly ? 0n : 1n)),
    maxTime,
  };
}
