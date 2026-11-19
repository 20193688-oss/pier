/* tx-verify.ts: before a wallet is asked to send a transaction the API built, the page decodes its
   calldata with the market contract's ABI (from @pedospe/contracts) and checks it does exactly what
   the screen says: the function is the action the person pressed, on this order's on-chain id,
   with this amount of this token, from this wallet, to the market's own matcher. A wallet shows a
   contract call as bytes; this is the check the person cannot do by eye. Anything else is
   refused, never sent.

   It runs after the shape check (tx-check.ts: chain, target contract, no native value). Pure;
   tests/unit/tx-verify.test.ts. */
import { decodeFunctionData, erc20Abi, isAddressEqual, type Hex } from 'viem';
import { P2P_MARKET_ARTIFACT } from '@pedospe/contracts';
import { checkTransaction, type TxProblem } from '@/lib/p2p/tx-check';
import type { P2pNetwork, P2pTransaction } from '@/lib/p2p/types';

export const MARKET_ABI = P2P_MARKET_ARTIFACT.abi;

/** What the person asked for, as the screen shows it. Fields left out are not compared. */
export type TxExpectation =
  | { action: 'approve'; token: string; spender: string; amountUnits?: string }
  | {
      action: 'openWithDeposit';
      seller: string;
      token: string;
      amountUnits: string;
      buyer?: string | null;
      ref?: string | null;
    }
  | { action: 'accept' | 'markPaid' | 'release' | 'cancel' | 'dispute'; orderId?: string | null }
  | { action: 'deposit' | 'withdraw'; token: string; amountUnits: string }
  | { action: 'setOperator'; operator: string; perms: number }
  | { action: 'setMatcher'; matcher: string; maxPerOrderUnits: string; autoSettle?: boolean };

export type VerifyProblem = TxProblem | 'function' | 'args';

const same = (a: unknown, b: string) =>
  typeof a === 'string' &&
  /^0x[0-9a-fA-F]{40}$/.test(a) &&
  /^0x[0-9a-fA-F]{40}$/.test(b) &&
  isAddressEqual(a as Hex, b as Hex);
const eqUnits = (a: unknown, b: string) =>
  typeof a === 'bigint' && /^\d+$/.test(b) && a === BigInt(b);

/** Why `tx` must not be sent (null when it may). */
export function verifyTransaction(
  tx: P2pTransaction,
  network: Pick<P2pNetwork, 'chainId' | 'contract' | 'tokens'>,
  expect: TxExpectation,
): VerifyProblem | null {
  const approveToken = expect.action === 'approve' ? expect.token : null;
  const shape = checkTransaction(tx, network, approveToken);
  if (shape) return shape;

  if (expect.action === 'approve') {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex });
    } catch {
      return 'function';
    }
    if (decoded.functionName !== 'approve') return 'function';
    const [spender, amount] = decoded.args as readonly [string, bigint];
    if (!same(spender, expect.spender)) return 'args';
    if (expect.amountUnits !== undefined && !eqUnits(amount, expect.amountUnits)) return 'args';
    return null;
  }

  let decoded;
  try {
    decoded = decodeFunctionData({ abi: MARKET_ABI, data: tx.data as Hex });
  } catch {
    return 'function';
  }
  if (decoded.functionName !== expect.action) return 'function';
  const args = (decoded.args ?? []) as readonly unknown[];
  const tokenAddress = (t: string) =>
    network.tokens.find((x) => x.symbol === t || x.address.toLowerCase() === t.toLowerCase())
      ?.address ?? t;

  switch (expect.action) {
    case 'openWithDeposit': {
      const p = args[0] as {
        ref: Hex;
        seller: string;
        buyer: string;
        token: string;
        amount: bigint;
      };
      if (
        !p ||
        !same(p.seller, expect.seller) ||
        !same(p.token, tokenAddress(expect.token)) ||
        !eqUnits(p.amount, expect.amountUnits)
      )
        return 'args';
      if (expect.buyer && !same(p.buyer, expect.buyer)) return 'args';
      if (expect.ref && p.ref.toLowerCase() !== expect.ref.toLowerCase()) return 'args';
      return null;
    }
    case 'accept':
    case 'markPaid':
    case 'release':
    case 'cancel':
    case 'dispute':
      if (
        expect.orderId &&
        !(
          typeof args[0] === 'bigint' &&
          /^\d+$/.test(expect.orderId) &&
          args[0] === BigInt(expect.orderId)
        )
      )
        return 'args';
      return null;
    case 'deposit':
    case 'withdraw':
      return same(args[0], tokenAddress(expect.token)) && eqUnits(args[1], expect.amountUnits)
        ? null
        : 'args';
    case 'setOperator':
      return same(args[0], expect.operator) && Number(args[1]) === expect.perms ? null : 'args';
    case 'setMatcher':
      if (!same(args[0], expect.matcher) || !eqUnits(args[1], expect.maxPerOrderUnits))
        return 'args';
      if (expect.autoSettle !== undefined && args[2] !== expect.autoSettle) return 'args';
      return null;
  }
}
