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

export const MARKET_ABI = P2P_MARKET_ARTIFACT.abi;

/** Every term a sale's `openWithDeposit` must carry, from the quote the person accepted and the
    market's published rules. */
export interface SaleTerms {
  /* The order's own reference (bytes32) and the seller: the connected wallet. */
  ref: string;
  seller: string;
  token: string;
  amountUnits: string;
  /* The merchant that buys: its address as the quote named it, or null when the quote did not
     name one (then the page makes no claim about it, and nothing else may differ). */
  buyer: string | null;
  bondUnits: string;
  acceptWindow: number;
  paymentWindow: number;
  settleWindow: number;
  /* The zero address and 0 when the quote carries no integrator fee. */
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
        (expect.buyer === null || same(p.buyer, expect.buyer)) &&
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

/** A sale's terms from the quote the person accepted and the market's rules: no integrator fee
    unless the quote carried one (then its address and rate, as the quote named them), the bond the
    quote stated or the market's sale bond rate of the amount, the market's windows. */
export function saleTerms(input: {
  ref: string;
  seller: string;
  token: string;
  amountUnits: string;
  quote: {
    buyer: string | null;
    bondUnits: string | null;
    integrator: string | null;
    integratorFeeBps: number;
  };
  market: {
    sellBondBps: number;
    windows: { acceptSeconds: number; paymentSeconds: number; settleSeconds: number };
  };
}): SaleTerms {
  const { quote, market } = input;
  const bond =
    quote.bondUnits ??
    ((BigInt(input.amountUnits) * BigInt(market.sellBondBps)) / 10_000n).toString();
  return {
    ref: input.ref,
    seller: input.seller,
    token: input.token,
    amountUnits: input.amountUnits,
    buyer: quote.buyer,
    bondUnits: bond,
    acceptWindow: market.windows.acceptSeconds,
    paymentWindow: market.windows.paymentSeconds,
    settleWindow: market.windows.settleSeconds,
    integrator: quote.integratorFeeBps > 0 && quote.integrator ? quote.integrator : zeroAddress,
    integratorFeeBps: quote.integratorFeeBps > 0 && quote.integrator ? quote.integratorFeeBps : 0,
  };
}
