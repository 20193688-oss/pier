import { toOrderWebhookData, type P2pOrderRow } from '@/p2p/views';
import type { OutboxEvent, WebhookEventType } from '@/webhooks/webhook-outbox';

/**
 * The built-in organization the public app's orders belong to. It has no
 * members, keys or endpoints, and its events are not stored.
 */
export const APP_ORGANIZATION_ID = 'pedospe_app';

/** The order event an order's new status emits. */
export const STATUS_EVENTS: Record<string, WebhookEventType | undefined> = {
  awaiting_payment: 'P2P_ORDER_ACCEPTED',
  paid: 'P2P_ORDER_PAID',
  completed: 'P2P_ORDER_COMPLETED',
  cancelled: 'P2P_ORDER_CANCELLED',
  expired: 'P2P_ORDER_EXPIRED',
  disputed: 'P2P_ORDER_DISPUTED',
  resolved: 'P2P_ORDER_RESOLVED',
  failed: 'P2P_ORDER_FAILED',
};

/**
 * An order's event for each role: its client (the organization that created
 * it, `role: "client"`) and, when another organization's account is its
 * merchant, that organization (`role: "merchant"`). Bodies are public
 * projections: never a payment method, a payer's identity or a beneficiary's
 * account (those are read on the routes, by whoever is entitled).
 */
export function orderEvents(
  type: WebhookEventType,
  row: P2pOrderRow,
  chainId: number,
): OutboxEvent[] {
  const events: OutboxEvent[] = [];
  if (row.organizationId !== APP_ORGANIZATION_ID) {
    events.push({
      organizationId: row.organizationId,
      tier: row.tier,
      type,
      data: toOrderWebhookData(row, chainId, 'client'),
    });
  }
  if (row.merchantOrganizationId !== row.organizationId) {
    events.push({
      organizationId: row.merchantOrganizationId,
      tier: row.tier,
      type,
      data: toOrderWebhookData(row, chainId, 'merchant'),
    });
  }
  return events;
}
