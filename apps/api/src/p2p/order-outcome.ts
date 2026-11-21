import type { Deployment } from '@/chain/deployments.service';
import type { MarketReader } from '@/chain/market-reader.service';
import { ApiError, ErrorCode } from '@/common/api-error';
import { chainOutcome, type P2pOutcomeAction } from '@/p2p/domain/action-outcome';
import { orderRef } from '@/p2p/domain/order-ref';
import type { P2pOrderStatus } from '@/p2p/domain/order-status';

/**
 * The answer to an action the order already shows: a 409 naming its status,
 * so a client that retried (or pressed twice) reads the order again instead
 * of reporting a failure. Nothing was built or sent.
 */
export function alreadyDone(status: string): ApiError {
  return ApiError.conflict(
    ErrorCode.AlreadyDone,
    `This order already shows that action: it is ${status}.`,
    [`status: ${status}`],
  );
}

/** What reading an order on-chain needs: its id there, or how its opening names it. */
export interface OutcomeOrder {
  id: string;
  onchainId: string | null;
  openerAddress: string;
}

/**
 * After the contract refused an action: the status the contract shows for
 * the order when it already shows `action` (the first call went through and
 * the indexer has not caught up yet), else null. A read that fails is null
 * too: the caller keeps its own refusal. Reads only; nothing is signed.
 */
export async function onchainOutcome(
  reader: MarketReader,
  d: Deployment,
  order: OutcomeOrder,
  action: P2pOutcomeAction,
): Promise<P2pOrderStatus | null> {
  try {
    const id = order.onchainId
      ? BigInt(order.onchainId)
      : await reader.orderIdOf(d, order.openerAddress, orderRef(order.id));
    if (id === 0n) return null;
    const onchain = await reader.getOrder(d, id);
    return onchain ? chainOutcome(action, onchain.status) : null;
  } catch {
    return null;
  }
}
