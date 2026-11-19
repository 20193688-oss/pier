/* The mock chain: builds the unsigned transactions the API would build (real calldata, encoded
   with the market contract's ABI) and applies a sent transaction's effect to the mock state, the
   way the indexer would after reading the contract's events. */
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddressEqual,
  type Hex,
} from 'viem';
import { MARKET_ABI } from '@/lib/p2p/tx-verify';
import { MARKET, NETWORKS, RULES } from '@/lib/mock/fixtures';
import { db, hash32, iso, now, onCompleted, save, type Wire } from '@/lib/mock/db';

const net = (id: string) => NETWORKS.find((n) => n.id === id);
const eq = (a: string, b: string) => isAddressEqual(a as Hex, b as Hex);

export function txFor(network: string, to: string, data: Hex, action: string): Wire {
  return { chainId: net(network)!.chainId, to, data, value: '0', action, description: action };
}

/** A sale's two steps for its seller: approve the exact amount, then open with the deposit. */
export function saleSteps(o: Wire): Wire[] {
  const n = net(o.network)!;
  const approve = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [getAddress(n.contract), BigInt(o.tokenAmount)],
  });
  const open = encodeFunctionData({
    abi: MARKET_ABI,
    functionName: 'openWithDeposit',
    args: [
      {
        ref: o.ref as Hex,
        seller: getAddress(o.sellerAddress),
        buyer: getAddress(o.buyerAddress),
        token: getAddress(o.token),
        amount: BigInt(o.tokenAmount),
        bond: BigInt(o.bond),
        acceptWindow: RULES.sellAcceptSeconds,
        paymentWindow: RULES.sellPaymentSeconds,
        settleWindow: RULES.sellSettleSeconds,
        integrator: '0x0000000000000000000000000000000000000000',
        integratorFeeBps: 0,
      },
    ],
  });
  return [
    txFor(o.network, o.token, approve, 'approve'),
    txFor(o.network, n.contract, open, 'openWithDeposit'),
  ];
}

/** `POST /v1/transactions`: the unsigned transaction for one action, or an error code. */
export function buildTransaction(body: Wire): { tx?: Wire; error?: [number, string, string] } {
  const n = net(String(body.network));
  if (!n) return { error: [422, 'unknown_network', 'Unknown network.'] };
  const args = (body.args ?? {}) as Wire;
  const action = String(body.action);
  const tokenAddr = (t: unknown) =>
    n.tokens.find((x) => x.symbol === t || x.address.toLowerCase() === String(t).toLowerCase())
      ?.address;
  const enc = (functionName: string, a: readonly unknown[]) =>
    encodeFunctionData({ abi: MARKET_ABI, functionName: functionName as never, args: a as never });
  switch (action) {
    case 'approve': {
      const token = tokenAddr(args.token);
      if (!token || !/^\d+$/.test(String(args.amount)))
        return { error: [422, 'invalid_args', 'approve needs token and amount.'] };
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [getAddress(n.contract), BigInt(args.amount)],
      });
      return { tx: txFor(n.id, token, data, 'approve') };
    }
    case 'deposit':
    case 'withdraw': {
      const token = tokenAddr(args.token);
      if (!token || !/^\d+$/.test(String(args.amount)))
        return { error: [422, 'invalid_args', `${action} needs token and amount.`] };
      return {
        tx: txFor(n.id, n.contract, enc(action, [getAddress(token), BigInt(args.amount)]), action),
      };
    }
    case 'setOperator':
      return {
        tx: txFor(
          n.id,
          n.contract,
          enc('setOperator', [getAddress(String(args.operator)), Number(args.permissions ?? 0)]),
          action,
        ),
      };
    case 'setMatcher':
      return {
        tx: txFor(
          n.id,
          n.contract,
          enc('setMatcher', [
            getAddress(MARKET.matcher!),
            BigInt(String(args.maxPerOrder ?? '0')),
            args.autoSettle === true,
          ]),
          action,
        ),
      };
    case 'accept':
    case 'markPaid':
    case 'release':
    case 'cancel':
    case 'dispute': {
      const order = db().orders.find((o) => o.id === args.orderId);
      if (!order || !order.onchainId) return { error: [404, 'not_found', 'Order not found.'] };
      return {
        tx: txFor(
          order.network,
          net(order.network)!.contract,
          enc(action, [BigInt(order.onchainId)]),
          action,
        ),
      };
    }
    default:
      return { error: [422, 'unknown_action', 'Unknown action.'] };
  }
}

function accountChain(address: string, network: string): Wire | null {
  const acc = db().accounts.find((a) => eq(a.address, address));
  if (!acc) return null;
  let chain = acc.networks.find((c: Wire) => c.network === network);
  if (!chain) {
    chain = {
      network,
      balances: [],
      matcher: { maxPerOrder: '0', autoSettle: false },
      operators: {},
    };
    acc.networks.push(chain);
  }
  return chain;
}

/** A transaction the demo wallet sent: its effect on the mock state. Returns its hash. */
export function applyTransaction(from: string, chainId: number, to: string, data: Hex): string {
  const hash = hash32();
  const n = NETWORKS.find((x) => x.chainId === chainId);
  if (!n || !eq(to, n.contract)) {
    save();
    return hash; // an approval, or anything else: no market effect
  }
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: MARKET_ABI, data });
  } catch {
    return hash;
  }
  const s = db();
  const t = now();
  const byChainId = (id: unknown) =>
    s.orders.find((o) => o.network === n.id && o.onchainId === String(id));
  const a = (decoded.args ?? []) as readonly unknown[];
  switch (decoded.functionName) {
    case 'openWithDeposit': {
      const p = a[0] as { ref: string };
      const o = s.orders.find((x) => x.ref === p.ref && x.status === 'pending');
      if (o) {
        o.status = 'awaiting_acceptance';
        o.onchainId = String(s.nextOnchainId++);
        o.acceptDeadline = iso(t + RULES.sellAcceptSeconds * 1000);
        o.txHashes = { ...o.txHashes, open: hash };
        o._t = { ...o._t, opened: t };
        o.updatedAt = iso(t);
      }
      break;
    }
    case 'accept': {
      const o = byChainId(a[0]);
      if (o) {
        o.status = 'awaiting_payment';
        o.paymentDeadline = iso(t + RULES.sellPaymentSeconds * 1000);
        o.txHashes = { ...o.txHashes, accept: hash };
        o.updatedAt = iso(t);
      }
      break;
    }
    case 'markPaid': {
      const o = byChainId(a[0]);
      if (o) {
        o.status = 'paid';
        o.settleDeadline = o.kind === 'SELL' ? iso(t + RULES.sellSettleSeconds * 1000) : null;
        o.txHashes = { ...o.txHashes, paid: hash };
        o.updatedAt = iso(t);
      }
      break;
    }
    case 'release': {
      const o = byChainId(a[0]);
      if (o) {
        o.status = 'completed';
        o.txHashes = { ...o.txHashes, release: hash };
        o.updatedAt = iso(t);
        onCompleted(o);
      }
      break;
    }
    case 'cancel': {
      const o = byChainId(a[0]);
      if (o) {
        o.status = 'cancelled';
        o.txHashes = { ...o.txHashes, cancel: hash };
        o.updatedAt = iso(t);
      }
      break;
    }
    case 'dispute': {
      const o = byChainId(a[0]);
      if (o) {
        o.status = 'disputed';
        o.txHashes = { ...o.txHashes, dispute: hash };
        o.updatedAt = iso(t);
      }
      break;
    }
    case 'deposit':
    case 'withdraw': {
      const chain = accountChain(from, n.id);
      const [token, amount] = a as [string, bigint];
      if (chain) {
        let b = chain.balances.find((x: Wire) => eq(x.token, token));
        if (!b) {
          const tk = n.tokens.find((x) => eq(x.address, token));
          b = {
            token,
            symbol: tk?.symbol ?? '',
            decimals: tk?.decimals ?? 6,
            freeUnits: '0',
            lockedUnits: '0',
          };
          chain.balances.push(b);
        }
        const next = BigInt(b.freeUnits) + (decoded.functionName === 'deposit' ? amount : -amount);
        b.freeUnits = (next < 0n ? 0n : next).toString();
      }
      break;
    }
    case 'setOperator': {
      const chain = accountChain(from, n.id);
      const [op, perms] = a as [string, number];
      if (chain) {
        if (Number(perms) === 0) delete chain.operators[op.toLowerCase()];
        else chain.operators[op.toLowerCase()] = Number(perms);
      }
      break;
    }
    case 'setMatcher': {
      const chain = accountChain(from, n.id);
      const [, max, auto] = a as [string, bigint, boolean];
      if (chain) chain.matcher = { maxPerOrder: max.toString(), autoSettle: auto };
      break;
    }
  }
  save();
  return hash;
}
