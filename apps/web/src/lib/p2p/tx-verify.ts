/* tx-verify.ts: before a wallet is asked to send a transaction the API built, the page decodes its
   calldata with the market contract's ABI (from @pedospe/contracts) and checks it does exactly what
   the person agreed to, field by field: the function is the action they pressed; on the order they
   are looking at; this amount of this token from this wallet; for a sale, every term of the order
   (merchant, bond, windows, integrator and its fee) equal to the quote they accepted and the
   market's published rules; for liquidity, the matcher, cap, bot and bits they typed. A wallet
   shows a contract call as bytes, so this is the check the person cannot do by eye. A compromised
   or buggy API cannot slip in a fee, a longer window or another recipient: anything that differs
   is refused, never sent. Every field is required; nothing is "not compared".

   It runs after the shape check (tx-check.ts: chain, target contract, no native value). Pure;
   tests/unit/tx-verify.test.ts. */
import { decodeFunctionData, erc20Abi, isAddressEqual, zeroAddress, type Hex } from 'viem';
import { P2P_MARKET_ARTIFACT } from '@pedospe/contracts';
import { checkTransaction, type TxProblem } from '@/lib/p2p/tx-check';
import type { P2pNetwork, P2pTransaction } from '@/lib/p2p/types';
import { integratorBpsFor, type AcceptedQuote } from '@/lib/p2p/fees';

export { integratorBpsFor, MAX_INTEGRATOR_FEE_BPS, type AcceptedQuote } from '@/lib/p2p/fees';

export const MARKET_ABI = P2P_MARKET_ARTIFACT.abi;

/** Every term a sale's `openWithDeposit` must carry: what the person saw (the amount, the fee
    shown to them) and what the market publishes (the bond rate, the windows). Every field is
    required; there is no "not compared". */
export interface SaleTerms {
  /* The order's own reference (bytes32) and the seller: the connected wallet. */
  ref: string;
  seller: string;
  token: string;
  amountUnits: string;
  /* The merchant that buys. */
  buyer: string;
  bondUnits: string;
  acceptWindow: number;
  paymentWindow: number;
  settleWindow: number;
  /* The zero address and 0 when the fee shown to the person was zero. */
  integrator: string;
  integratorFeeBps: number;
}

/** What the person asked for, as the screen shows it. */
export type TxExpectation =
  | { action: 'approve'; token: string; spender: string; amountUnits: string }
  | ({ action: 'openWithDeposit' } & SaleTerms)
  | { action: 'accept' | 'markPaid' | 'release' | 'cancel' | 'dispute'; orderId: string | null }
  | { action: 'deposit' | 'withdraw'; token: string; amountUnits: string }
  | { action: 'setOperator'; operator: string; perms: number }
  | { action: 'setMatcher'; matcher: string; maxPerOrderUnits: string; autoSettle: boolean };

export type VerifyProblem = TxProblem | 'function' | 'args';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const same = (a: unknown, b: string | null | undefined) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  ADDRESS.test(a) &&
  ADDRESS.test(b) &&
  isAddressEqual(a as Hex, b as Hex);
const eqUnits = (a: unknown, b: string | null | undefined) =>
  typeof a === 'bigint' && typeof b === 'string' && /^\d+$/.test(b) && a === BigInt(b);
const eqInt = (a: unknown, b: number) =>
  (typeof a === 'number' || typeof a === 'bigint') && Number.isInteger(b) && Number(a) === b;

/** Why `tx` must not be sent (null when it may). */
export function verifyTransaction(
  tx: P2pTransaction,
  network: Pick<P2pNetwork, 'chainId' | 'contract' | 'tokens'>,
  expect: TxExpectation,
): VerifyProblem | null {
  const approveToken = expect.action === 'approve' ? expect.token : null;
  const shape = checkTransaction(tx, network, approveToken);
  if (shape) return shape;
  const tokenAddress = (t: string) =>
    network.tokens.find((x) => x.symbol === t || x.address.toLowerCase() === t.toLowerCase())
      ?.address ?? null;

  if (expect.action === 'approve') {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex });
    } catch {
      return 'function';
    }
    if (decoded.functionName !== 'approve') return 'function';
    const [spender, amount] = decoded.args as readonly [string, bigint];
    // The market contract of this network, for exactly the order's amount (never unlimited).
    if (!same(tx.to, tokenAddress(expect.token))) return 'target';
    if (!same(spender, expect.spender) || !same(spender, network.contract)) return 'args';
    return eqUnits(amount, expect.amountUnits) ? null : 'args';
  }

  if (!same(tx.to, network.contract)) return 'target';
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: MARKET_ABI, data: tx.data as Hex });
  } catch {
    return 'function';
  }
  if (decoded.functionName !== expect.action) return 'function';
  const args = (decoded.args ?? []) as readonly unknown[];

  switch (expect.action) {
    case 'openWithDeposit': {
      const p = args[0] as Record<string, unknown> | undefined;
      if (!p) return 'args';
      const ok =
        typeof p.ref === 'string' &&
        p.ref.toLowerCase() === expect.ref.toLowerCase() &&
        same(p.seller, expect.seller) &&
        same(p.token, tokenAddress(expect.token)) &&
        eqUnits(p.amount, expect.amountUnits) &&
        same(p.buyer, expect.buyer) &&
        eqUnits(p.bond, expect.bondUnits) &&
        eqInt(p.acceptWindow, expect.acceptWindow) &&
        eqInt(p.paymentWindow, expect.paymentWindow) &&
        eqInt(p.settleWindow, expect.settleWindow) &&
        same(p.integrator, expect.integrator) &&
        eqInt(p.integratorFeeBps, expect.integratorFeeBps);
      return ok ? null : 'args';
    }
    case 'accept':
    case 'markPaid':
    case 'release':
    case 'cancel':
    case 'dispute':
      // The order on screen: an order whose on-chain id is not known yet cannot be signed for.
      return typeof args[0] === 'bigint' &&
        !!expect.orderId &&
        /^\d+$/.test(expect.orderId) &&
        args[0] === BigInt(expect.orderId)
        ? null
        : 'args';
    case 'deposit':
    case 'withdraw':
      return same(args[0], tokenAddress(expect.token)) && eqUnits(args[1], expect.amountUnits)
        ? null
        : 'args';
    case 'setOperator':
      return same(args[0], expect.operator) && eqInt(args[1], expect.perms) ? null : 'args';
    case 'setMatcher':
      return same(args[0], expect.matcher) &&
        eqUnits(args[1], expect.maxPerOrderUnits) &&
        args[2] === expect.autoSettle
        ? null
        : 'args';
  }
}

export type SaleTermsProblem = 'buyer' | 'fee';

/** A sale's terms, from trusted sources only: the accepted quote as the person saw it (or, when
    this tab no longer has it, the order's own amount, its buyer and no fee), the market's
    published sale bond rate and windows. A sale whose buyer no source names, or whose shown fee
    no rate reproduces, is refused: `problem` says why, and nothing is signed. */
export function saleTerms(input: {
  ref: string;
  seller: string;
  token: string;
  accepted: AcceptedQuote | null;
  order: { amountUnits: string; buyer: string | null };
  market: {
    sellBondBps: number;
    windows: { acceptSeconds: number; sellPaymentSeconds: number; settleSeconds: number };
  };
}): { terms: SaleTerms; problem: null } | { terms: null; problem: SaleTermsProblem } {
  const { accepted, order, market } = input;
  const amountUnits = accepted?.amountUnits ?? order.amountUnits;
  const buyer = accepted?.buyer ?? order.buyer;
  if (!buyer || !ADDRESS.test(buyer) || /^0x0{40}$/.test(buyer))
    return { terms: null, problem: 'buyer' };
  const feeUnits = accepted?.integratorFeeUnits ?? '0';
  const bps = integratorBpsFor(amountUnits, feeUnits);
  if (bps === null) return { terms: null, problem: 'fee' };
  const integrator = bps > 0 ? accepted?.integrator : zeroAddress;
  if (!integrator || !ADDRESS.test(integrator) || (bps > 0 && /^0x0{40}$/.test(integrator)))
    return { terms: null, problem: 'fee' };
  return {
    problem: null,
    terms: {
      ref: input.ref,
      seller: input.seller,
      token: input.token,
      amountUnits,
      buyer,
      bondUnits: ((BigInt(amountUnits) * BigInt(market.sellBondBps)) / 10_000n).toString(),
      acceptWindow: market.windows.acceptSeconds,
      paymentWindow: market.windows.sellPaymentSeconds,
      settleWindow: market.windows.settleSeconds,
      integrator,
      integratorFeeBps: bps,
    },
  };
}
