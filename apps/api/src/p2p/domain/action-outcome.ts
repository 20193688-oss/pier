import type { P2pChainStatus } from '@/chain/market-codec';
import { CHAIN_TO_API_STATUS, type P2pOrderStatus } from '@/p2p/domain/order-status';

/**
 * Whether an order already shows what an action does, so a retried action
 * (pressed twice, or sent again after it went through) is answered as done
 * instead of refused. Pure: the services read the status (stored, or the
 * contract's when a simulation is refused) and decide what to answer.
 *
 * An action's outcome is every status the order can reach once the action
 * happened: a purchase marked paid stays "paid" through a dispute, a release
 * or a resolution. `open` is a sale's or a QR payment's `open_with_deposit`:
 * anything after `pending` but `failed` (a sale we gave up on before it
 * opened). A cancel reads `expired` when it landed after the deadline of the
 * step the order was waiting on (`cancellationStatus`), so both count.
 */

export const P2P_OUTCOME_ACTIONS = [
  'open',
  'accept',
  'markPaid',
  'release',
  'cancel',
  'dispute',
] as const;
export type P2pOutcomeAction = (typeof P2P_OUTCOME_ACTIONS)[number];

export const P2P_ACTION_OUTCOMES: Record<P2pOutcomeAction, readonly P2pOrderStatus[]> = {
  open: [
    'awaiting_acceptance',
    'awaiting_payment',
    'paid',
    'disputed',
    'completed',
    'resolved',
    'cancelled',
    'expired',
  ],
  accept: ['awaiting_payment', 'paid', 'disputed', 'completed', 'resolved'],
  markPaid: ['paid', 'disputed', 'completed', 'resolved'],
  release: ['completed'],
  cancel: ['cancelled', 'expired'],
  dispute: ['disputed', 'resolved'],
};

/** Whether an order in `status` (as the API stores it) already shows `action`. */
export function showsOutcome(action: P2pOutcomeAction, status: string): boolean {
  return (P2P_ACTION_OUTCOMES[action] as readonly string[]).includes(status);
}

/**
 * The status the contract's `status` reads as when it already shows
 * `action`, or null when it does not (or the contract has no such order).
 */
export function chainOutcome(
  action: P2pOutcomeAction,
  status: P2pChainStatus,
): P2pOrderStatus | null {
  const api = CHAIN_TO_API_STATUS[status];
  return api !== null && showsOutcome(action, api) ? api : null;
}
