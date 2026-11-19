/* A sale's two unsigned transactions may come only with the order's creation (a later read need
   not repeat them), so this tab keeps them until the wallet sent both: a reload can still sign.
   sessionStorage only; they are unsigned calldata, not secrets. */
import type { P2pTransaction } from '@/lib/p2p/types';

const KEY = (orderId: string) => `pedospe.steps:${orderId}`;

export function saveSteps(orderId: string, steps: P2pTransaction[] | undefined) {
  try {
    if (steps?.length) sessionStorage.setItem(KEY(orderId), JSON.stringify(steps));
    else sessionStorage.removeItem(KEY(orderId));
  } catch {
    /* private mode: the steps stay in memory for this page only */
  }
}

export function savedSteps(orderId: string): P2pTransaction[] | undefined {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY(orderId)) ?? 'null');
    return Array.isArray(raw) && raw.length ? (raw as P2pTransaction[]) : undefined;
  } catch {
    return undefined;
  }
}
