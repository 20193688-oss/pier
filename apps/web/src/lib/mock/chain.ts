/* The mock network: builds the unsigned transactions the API would build (real Stellar XDR, the
   market calls encoded against the contract interface, with their source-account
   authorization), and applies a signed, submitted envelope to the mock state: it checks the
   signatures, decodes the operation and moves balances and orders the way the contract and the
   indexer would. */
import {
  FeeBumpTransaction,
  Keypair,
  MuxedAccount,
  TransactionBuilder,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk/base';
import {
  activation,
  contractTransfer,
  envelope,
  marketCall,
  openWithDeposit,
  payment,
  sc,
} from '@/lib/stellar/build';
import { BAD, decodeArgs, readInvocation, type Decoded } from '@/lib/stellar/decode';
import { MARKET_INTERFACE, SAC_TRANSFER } from '@/lib/stellar/market-interface';
import { toHex } from '@/lib/p2p/order-ref';
import { toBaseUnits } from '@/lib/p2p/amounts';
import type { P2pTransaction } from '@/lib/p2p/types';
import { MATCHER, NETWORK, RULES, SPONSOR, USDC } from '@/lib/mock/fixtures';
import {
  credit,
  db,
  iso,
  now,
  onCompleted,
  refundSeller,
  save,
  type ChainAccount,
  type Wire,
} from '@/lib/mock/db';

const PASSPHRASE = NETWORK.networkPassphrase;
const MARKET = NETWORK.contract;

export const chainAccount = (address: string): ChainAccount | null =>
  db().chain.accounts[address] ?? null;

function env(source: string, ops: xdr.Operation[], action: string, memo: string | null = null) {
  const a = chainAccount(source);
  return envelope(
    {
      source,
      sequence: a?.seq ?? '0',
      networkId: NETWORK.id,
      passphrase: PASSPHRASE,
      maxTime: Math.floor(now() / 1000) + 300,
      memo,
    },
    ops,
    action,
  );
}

/** A sale's or QR payment's `open_with_deposit`, signed by its seller. */
export function saleOpen(o: Wire): P2pTransaction {
  const qr = o.kind === 'QR_PAY';
  return env(
    o.sellerAddress,
    [
      openWithDeposit(MARKET, {
        ref: o.ref,
        seller: o.sellerAddress,
        buyer: o.buyerAddress,
        token: USDC.contract,
        amountUnits: o.tokenAmount,
        bondUnits: o.bond,
        acceptWindow: qr ? RULES.qrAcceptSeconds : RULES.sellAcceptSeconds,
        paymentWindow: qr ? RULES.qrPaymentSeconds : RULES.sellPaymentSeconds,
        settleWindow: qr ? RULES.qrSettleSeconds : RULES.sellSettleSeconds,
        integrator: null,
        integratorFeeBps: 0,
      }),
    ],
    'open_with_deposit',
  );
}

const ORDER_FNS = ['accept', 'mark_paid', 'release', 'cancel', 'dispute'];
const API_ACTIONS: Record<string, string> = {
  markPaid: 'mark_paid',
  setMatcher: 'set_matcher',
  setOperator: 'set_operator',
};
/** The contract function an API action names (camelCase or the contract's own name). */
export const fnOf = (action: string) => API_ACTIONS[action] ?? action;

/** An order action by `caller`. */
export function orderCall(o: Wire, action: string, caller: string): P2pTransaction | null {
  const fn = fnOf(action);
  if (!ORDER_FNS.includes(fn) || !o.onchainId) return null;
  return env(caller, [marketCall(MARKET, fn, [sc.address(caller), sc.u64(o.onchainId)])], fn);
}

/** `POST /v1/p2p/transactions`: one of an organization's accounts acting on the market. */
export function buildTransaction(
  from: string,
  action: string,
  args: Wire,
): { tx?: P2pTransaction; error?: [number, string, string] } {
  const fn = fnOf(action);
  const amount = String(args.amount ?? '');
  switch (fn) {
    case 'deposit':
    case 'withdraw':
      if (!/^\d+$/.test(amount) || amount === '0')
        return { error: [422, 'invalid_args', `${fn} needs an amount.`] };
      return {
        tx: env(
          from,
          [
            marketCall(
              MARKET,
              fn,
              [sc.address(from), sc.address(USDC.contract), sc.i128(amount)],
              fn === 'deposit' ? { token: USDC.contract, from, amountUnits: amount } : null,
            ),
          ],
          fn,
        ),
      };
    case 'set_operator':
      return {
        tx: env(
          from,
          [
            marketCall(MARKET, fn, [
              sc.address(from),
              sc.address(String(args.operator)),
              sc.u32(Number(args.permissions ?? args.perms ?? 0)),
            ]),
          ],
          fn,
        ),
      };
    case 'set_matcher':
      return {
        tx: env(
          from,
          [
            marketCall(MARKET, fn, [
              sc.address(from),
              sc.address(MATCHER),
              sc.i128(String(args.maxPerOrder ?? '0')),
              sc.bool(args.autoSettle === true),
            ]),
          ],
          fn,
        ),
      };
    default: {
      if (!ORDER_FNS.includes(fn)) return { error: [422, 'unknown_action', 'Unknown action.'] };
      const order = db().orders.find((o) => o.id === args.orderId);
      if (!order || !order.onchainId) return { error: [404, 'not_found', 'Order not found.'] };
      return { tx: orderCall(order, fn, from)! };
    }
  }
}

/** A transfer of USDC: a classic payment to an account, a token transfer to a contract. */
export function transferTx(from: string, to: string, amountUnits: string, note: string | null) {
  return to.startsWith('C')
    ? env(from, [contractTransfer(from, to, USDC, amountUnits)], 'payment')
    : env(from, [payment(to, USDC, amountUnits)], 'payment', note);
}

/** The sponsored activation, or null when the account and trustline exist. */
export function activationTx(address: string): P2pTransaction | null {
  const a = chainAccount(address);
  if (a?.exists && a.trust.USDC !== null && a.trust.USDC !== undefined) return null;
  const create = !a?.exists;
  const ops = activation({ sponsor: SPONSOR, account: address, token: USDC, createAccount: create });
  return env(create ? SPONSOR : address, ops, 'activate');
}

/* --- Submission --- */

export interface Applied {
  hash: string;
  status: 'SUCCESS' | 'FAILED';
  error: string | null;
}

class OpFailed extends Error {}
const fail = (reason: string): never => {
  throw new OpFailed(reason);
};
const baseAccount = (a: string) =>
  a.startsWith('M') ? MuxedAccount.fromAddress(a, '0').baseAccount().accountId() : a;

function signedBy(tx: Transaction, address: string): boolean {
  const kp = Keypair.fromPublicKey(address);
  const h = tx.hash();
  return tx.signatures.some((s) => {
    try {
      return kp.verify(h, s.signature.value);
    } catch {
      return false;
    }
  });
}

/** A signed envelope submitted by `submitter` (the session's wallet or an organization's
    account): checked, applied, recorded. */
export function submitEnvelope(signedXdr: string, allowedSources: readonly string[]): Applied {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(signedXdr, PASSPHRASE);
  } catch {
    return { hash: '', status: 'FAILED', error: 'malformed' };
  }
  if (parsed instanceof FeeBumpTransaction)
    return { hash: toHex(parsed.hash()), status: 'FAILED', error: 'fee_bump' };
  const tx = parsed;
  const hash = toHex(tx.hash());
  const s = db();
  const seen = s.chain.submissions[hash];
  if (seen) return { hash, status: seen.status, error: seen.error };
  const record = (status: 'SUCCESS' | 'FAILED', error: string | null): Applied => {
    s.chain.submissions[hash] = { status, error, at: iso(now()) };
    save();
    return { hash, status, error };
  };
  // Who must have signed: the source and every operation's source (the sponsor signs here).
  const signers = new Set([tx.source, ...tx.operations.map((op) => op.source ?? tx.source)]);
  signers.delete(SPONSOR);
  if (!allowedSources.includes(tx.source) && tx.source !== SPONSOR) return record('FAILED', 'source');
  for (const a of signers) if (!signedBy(tx, a)) return record('FAILED', 'tx_bad_auth');
  const max = Number(tx.timeBounds?.maxTime ?? 0);
  if (max && max < now() / 1000) return record('FAILED', 'tx_too_late');
  const snapshot = JSON.stringify({ chain: s.chain.accounts, orders: s.orders, accounts: s.accounts });
  try {
    for (const op of tx.operations) applyOperation(tx, op, hash);
  } catch (e) {
    // All or nothing, like the network.
    const back = JSON.parse(snapshot);
    s.chain.accounts = back.chain;
    s.orders = back.orders;
    s.accounts = back.accounts;
    return record('FAILED', e instanceof OpFailed ? e.message : 'op_failed');
  }
  const source = s.chain.accounts[tx.source];
  if (source) source.seq = tx.sequence;
  afterSuccess(hash);
  return record('SUCCESS', null);
}

function applyOperation(tx: Transaction, op: Transaction['operations'][number], hash: string) {
  const src = op.source ?? tx.source;
  const s = db();
  switch (op.type) {
    case 'payment': {
      if (op.asset.isNative() || op.asset.getCode() !== USDC.code) fail('op_no_trust');
      const amount = BigInt(toBaseUnits(op.amount, 7) ?? '0');
      const to = baseAccount(op.destination);
      const dest = s.chain.accounts[to];
      if (!dest?.exists) fail('op_no_destination');
      if (dest.trust.USDC === null || dest.trust.USDC === undefined) fail('op_no_trust');
      if (!credit(src, 'USDC', -amount)) fail('op_underfunded');
      credit(to, 'USDC', amount);
      return;
    }
    case 'beginSponsoringFutureReserves':
    case 'endSponsoringFutureReserves':
      return;
    case 'createAccount': {
      s.chain.accounts[op.destination] = { exists: true, seq: '1000', xlm: '0', trust: {} };
      return;
    }
    case 'changeTrust': {
      const a = s.chain.accounts[src];
      if (!a?.exists) fail('op_no_account');
      a.trust.USDC ??= '0';
      return;
    }
    case 'invokeHostFunction': {
      const func = (op as { func: xdr.HostFunction }).func;
      if (func.type !== 'hostFunctionTypeInvokeContract') fail('op_malformed');
      const inv = readInvocation((func as { invokeContract: xdr.InvokeContractArgs }).invokeContract);
      if (!inv) fail('op_malformed');
      if (inv!.contract === USDC.contract) {
        const a = decodeArgs(inv!, SAC_TRANSFER);
        if (a === BAD || inv!.fn !== 'transfer' || a.from !== src) fail('op_malformed');
        const args = a as Record<string, Decoded>;
        if (!credit(src, 'USDC', -(args.amount as bigint))) fail('op_underfunded');
        return;
      }
      if (inv!.contract !== MARKET) fail('op_unknown_contract');
      const signature = MARKET_INTERFACE[inv!.fn];
      if (!signature) fail('op_unknown_function');
      const args = decodeArgs(inv!, signature);
      if (args === BAD) fail('op_malformed');
      applyMarket(inv!.fn, args as Record<string, Decoded>, src, hash);
      return;
    }
    default:
      fail('op_not_supported');
  }
}

function marketChain(address: string) {
  const acc = db().accounts.find((a) => a.address === address);
  if (!acc) return null;
  let chain = acc.networks.find((c: Wire) => c.network === NETWORK.id);
  if (!chain) {
    chain = {
      network: NETWORK.id,
      balances: [],
      matcher: { maxPerOrder: '0', autoSettle: false },
      operators: {},
    };
    acc.networks.push(chain);
  }
  return chain;
}

function marketBalance(address: string) {
  const chain = marketChain(address);
  if (!chain) return null;
  let b = chain.balances.find((x: Wire) => x.token === USDC.contract);
  if (!b) {
    b = { token: USDC.contract, symbol: 'USDC', decimals: 7, freeUnits: '0', lockedUnits: '0' };
    chain.balances.push(b);
  }
  return b;
}

function applyMarket(fn: string, a: Record<string, Decoded>, src: string, hash: string) {
  const s = db();
  const t = now();
  const byId = (id: Decoded) => s.orders.find((o) => o.onchainId === String(id));
  switch (fn) {
    case 'open_with_deposit': {
      const p = a.p as Record<string, Decoded>;
      if (p.seller !== src) fail('not_authorized');
      const o = s.orders.find((x) => x.ref === p.ref_id && x.status === 'pending');
      if (!o) fail('ref_unknown');
      if (!credit(src, 'USDC', -(p.amount as bigint))) fail('insufficient_balance');
      const qr = o!.kind === 'QR_PAY';
      o!.status = 'awaiting_acceptance';
      o!._locked = true;
      o!.onchainId = String(s.nextOnchainId++);
      o!.acceptDeadline = iso(t + (qr ? RULES.qrAcceptSeconds : RULES.sellAcceptSeconds) * 1000);
      o!.txHashes = { ...o!.txHashes, open: hash };
      o!._t = { ...o!._t, opened: t };
      o!.updatedAt = iso(t);
      return;
    }
    case 'accept':
    case 'mark_paid':
    case 'release':
    case 'cancel':
    case 'dispute': {
      const o = byId(a.id);
      if (!o) fail('unknown_order');
      if (a.caller !== src) fail('not_authorized');
      const key = { mark_paid: 'paid', accept: 'accept', release: 'release', cancel: 'cancel', dispute: 'dispute' }[fn]!;
      o!.txHashes = { ...o!.txHashes, [key]: hash };
      o!.updatedAt = iso(t);
      if (fn === 'accept') {
        o!.status = 'awaiting_payment';
        o!.paymentDeadline = iso(t + RULES.sellPaymentSeconds * 1000);
      } else if (fn === 'mark_paid') {
        o!.status = 'paid';
        o!._t = { ...o!._t, paid: t };
        o!.settleDeadline =
          o!.kind === 'SELL'
            ? iso(t + RULES.sellSettleSeconds * 1000)
            : o!.kind === 'QR_PAY'
              ? iso(t + RULES.qrSettleSeconds * 1000)
              : null;
      } else if (fn === 'release') {
        if (o!.sellerAddress !== src) fail('not_authorized');
        o!.status = 'completed';
        onCompleted(o!);
      } else if (fn === 'cancel') {
        o!.status = 'cancelled';
        refundSeller(o!);
      } else {
        o!.status = 'disputed';
        o!._auto = false;
      }
      return;
    }
    case 'deposit':
    case 'withdraw': {
      if (a.account !== src || a.token !== USDC.contract) fail('not_authorized');
      const b = marketBalance(src);
      if (!b) fail('not_registered');
      const amount = a.amount as bigint;
      if (fn === 'deposit') {
        if (!credit(src, 'USDC', -amount)) fail('insufficient_balance');
        b!.freeUnits = (BigInt(b!.freeUnits) + amount).toString();
      } else {
        if (BigInt(b!.freeUnits) < amount) fail('insufficient_balance');
        b!.freeUnits = (BigInt(b!.freeUnits) - amount).toString();
        credit(src, 'USDC', amount);
      }
      return;
    }
    case 'set_operator': {
      const chain = marketChain(src);
      if (!chain || a.account !== src) fail('not_authorized');
      if (Number(a.perms) === 0) delete chain!.operators[String(a.operator)];
      else chain!.operators[String(a.operator)] = Number(a.perms);
      return;
    }
    case 'set_matcher': {
      const chain = marketChain(src);
      if (!chain || a.seller !== src) fail('not_authorized');
      chain!.matcher = { maxPerOrder: String(a.max_per_order), autoSettle: a.auto_settle === true };
      return;
    }
    default:
      fail('op_unknown_function');
  }
}

/** What a settled transaction completes besides its operation: a transfer, a charge payment. */
function afterSuccess(hash: string) {
  const s = db();
  const t = iso(now());
  for (const tr of s.transfers) {
    if (tr._hash === hash) {
      tr.status = 'COMPLETED';
      tr.hash = hash;
      tr.completedAt = t;
    }
  }
  for (const p of Object.values(s.chargePayments)) {
    if (p._hash !== hash) continue;
    p.status = 'COMPLETED';
    const c = s.charges.find((x) => x.id === p.chargeId);
    if (c) {
      c.orders = Number(c.orders ?? 0) + 1;
      if (!c.multiUse) {
        c.status = 'paid';
        c.paidAt = t;
      }
    }
  }
}
