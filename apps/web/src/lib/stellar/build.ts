/* Building the transactions the API builds (docs/STELLAR.md 5.4 and 5.6), for the mock API and the
   tests: a market call with its source-account authorization (and the token pull it makes), a
   payment, a token contract transfer and the sponsored activation. The real API also simulates
   and prepares them (footprint, resource fee); nothing here talks to a network, and the
   production app never builds a transaction itself. */
import {
  Account,
  Address,
  Asset,
  Memo,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk/base';
import type { P2pToken, P2pTransaction } from '@/lib/p2p/types';
import { fromHex, toHex } from '@/lib/p2p/order-ref';
import { fromBaseUnits } from '@/lib/p2p/amounts';
import { MAX_TRUST_LIMIT } from '@/lib/p2p/tx-verify';

export const sc = {
  address: (a: string) => new Address(a).toScVal(),
  i128: (v: bigint | string) => nativeToScVal(BigInt(v), { type: 'i128' }),
  u32: (v: number) => nativeToScVal(v, { type: 'u32' }),
  u64: (v: bigint | string | number) => nativeToScVal(BigInt(v), { type: 'u64' }),
  bool: (v: boolean) => xdr.ScVal.scvBool(v),
  bytes: (hex: string) => xdr.ScVal.scvBytes(fromHex(hex)),
  none: () => xdr.ScVal.scvVoid(),
  /* A Soroban struct: a map of symbol keys in sorted order. */
  struct: (fields: Record<string, xdr.ScVal>) =>
    xdr.ScVal.scvMap(
      Object.keys(fields)
        .sort()
        .map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: fields[k] })),
    ),
};

export const invokeArgs = (contract: string, fn: string, args: xdr.ScVal[]) =>
  new xdr.InvokeContractArgs({
    contractAddress: new Address(contract).toScAddress(),
    functionName: fn,
    args,
  });

export const invocation = (
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  subs: xdr.SorobanAuthorizedInvocation[] = [],
) =>
  new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      invokeArgs(contract, fn, args),
    ),
    subInvocations: subs,
  });

/** The source account's authorization of a call (and of the calls it makes). */
export const sourceAuth = (root: xdr.SorobanAuthorizedInvocation) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: root,
  });

/** A token's `transfer(from, to, amount)` as an authorized sub-invocation. */
export const transferCall = (token: string, from: string, to: string, amountUnits: string) =>
  invocation(token, 'transfer', [sc.address(from), sc.address(to), sc.i128(amountUnits)]);

export interface Envelope {
  source: string;
  sequence: string;
  networkId: string;
  passphrase: string;
  /* Seconds: the upper time bound. */
  maxTime: number;
  fee?: string;
  memo?: string | null;
}

/** One unsigned transaction, as the API answers it. */
export function envelope(
  e: Envelope,
  ops: xdr.Operation[],
  action: string,
  description = action,
): P2pTransaction {
  // TransactionBuilder takes the account's current sequence and adds one.
  const builder = new TransactionBuilder(new Account(e.source, e.sequence), {
    fee: e.fee ?? '100000',
    networkPassphrase: e.passphrase,
    timebounds: { minTime: 0, maxTime: e.maxTime },
    memo: e.memo ? Memo.text(e.memo) : Memo.none(),
  });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.build();
  return {
    network: e.networkId,
    action,
    description,
    xdr: tx.toXDR(),
    hash: toHex(tx.hash()),
    expiresAt: new Date(e.maxTime * 1000).toISOString(),
  };
}

/** A market call by `caller`, authorized by the source account, with an optional token pull. */
export function marketCall(
  market: string,
  fn: string,
  args: xdr.ScVal[],
  pull: { token: string; from: string; amountUnits: string } | null = null,
): xdr.Operation {
  const subs = pull ? [transferCall(pull.token, pull.from, market, pull.amountUnits)] : [];
  return Operation.invokeContractFunction({
    contract: market,
    function: fn,
    args,
    auth: [sourceAuth(invocation(market, fn, args, subs))],
  });
}

export interface OpenParamsInput {
  ref: string;
  seller: string;
  buyer: string;
  token: string;
  amountUnits: string;
  bondUnits: string;
  acceptWindow: number;
  paymentWindow: number;
  settleWindow: number;
  integrator: string | null;
  integratorFeeBps: number;
}

export const openParams = (p: OpenParamsInput) =>
  sc.struct({
    ref_id: sc.bytes(p.ref),
    seller: sc.address(p.seller),
    buyer: sc.address(p.buyer),
    token: sc.address(p.token),
    amount: sc.i128(p.amountUnits),
    bond: sc.i128(p.bondUnits),
    accept_window: sc.u32(p.acceptWindow),
    payment_window: sc.u32(p.paymentWindow),
    settle_window: sc.u32(p.settleWindow),
    integrator: p.integrator ? sc.address(p.integrator) : sc.none(),
    integrator_fee_bps: sc.u32(p.integratorFeeBps),
  });

/** A sale's `open_with_deposit`: pulls the amount from the seller. */
export const openWithDeposit = (market: string, p: OpenParamsInput) =>
  marketCall(market, 'open_with_deposit', [openParams(p)], {
    token: p.token,
    from: p.seller,
    amountUnits: p.amountUnits,
  });

/** A classic payment of `token` (G or M destination). */
export const payment = (to: string, token: P2pToken, amountUnits: string) =>
  Operation.payment({
    destination: to,
    asset: new Asset(token.code, token.issuer ?? undefined),
    amount: fromBaseUnits(amountUnits, 7),
  });

/** A token contract transfer to a contract (C destination). */
export function contractTransfer(from: string, to: string, token: P2pToken, amountUnits: string) {
  const args = [sc.address(from), sc.address(to), sc.i128(amountUnits)];
  return Operation.invokeContractFunction({
    contract: token.contract,
    function: 'transfer',
    args,
    auth: [sourceAuth(invocation(token.contract, 'transfer', args))],
  });
}

/** The sponsored activation's operations: the account (when missing) and the trustline. */
export function activation(input: {
  sponsor: string;
  account: string;
  token: P2pToken;
  createAccount: boolean;
}): xdr.Operation[] {
  return [
    Operation.beginSponsoringFutureReserves({ sponsoredId: input.account, source: input.sponsor }),
    ...(input.createAccount
      ? [
          Operation.createAccount({
            destination: input.account,
            startingBalance: '0',
            source: input.sponsor,
          }),
        ]
      : []),
    Operation.changeTrust({
      asset: new Asset(input.token.code, input.token.issuer ?? undefined),
      limit: MAX_TRUST_LIMIT,
      source: input.account,
    }),
    Operation.endSponsoringFutureReserves({ source: input.account }),
  ];
}
