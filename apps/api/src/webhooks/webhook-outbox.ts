import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';

/** Every event the API emits. */
export const WEBHOOK_EVENT_TYPES = [
  'P2P_ORDER_CREATED',
  'P2P_ORDER_ACCEPTED',
  'P2P_ORDER_PAID',
  'P2P_ORDER_COMPLETED',
  'P2P_ORDER_CANCELLED',
  'P2P_ORDER_EXPIRED',
  'P2P_ORDER_DISPUTED',
  'P2P_ORDER_RESOLVED',
  'P2P_ORDER_FAILED',
  'P2P_CHARGE_SUCCEEDED',
  'P2P_PAYOUT_BATCH_COMPLETED',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** A database handle inside a transaction (or the client itself). */
export type Tx = Prisma.TransactionClient;

export interface OutboxEvent {
  organizationId: string;
  tier: string;
  type: WebhookEventType;
  data: Record<string, unknown>;
}

/** What a delivery's body is: the event envelope. */
export interface WebhookEnvelope {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  data: Record<string, unknown>;
}

/**
 * Writes events to the durable outbox INSIDE the caller's transaction, with
 * one pending delivery per active endpoint of the organization and tier that
 * subscribes to the type. The state change and its events commit together or
 * not at all; the sender job delivers them afterwards.
 */
export async function enqueueWebhooks(tx: Tx, events: readonly OutboxEvent[]): Promise<void> {
  for (const event of events) {
    const endpoints = await tx.webhookEndpoint.findMany({
      where: { organizationId: event.organizationId, tier: event.tier, active: true },
      select: { id: true, events: true },
    });
    const targets = endpoints.filter((e) => e.events.length === 0 || e.events.includes(event.type));
    const id = `evt_${randomUUID().replace(/-/g, '')}`;
    const envelope: WebhookEnvelope = {
      id,
      type: event.type,
      createdAt: new Date().toISOString(),
      // Dates to ISO strings, exactly as the body will be sent.
      data: JSON.parse(JSON.stringify(event.data)) as Record<string, unknown>,
    };
    await tx.webhookEvent.create({
      data: {
        id,
        organizationId: event.organizationId,
        tier: event.tier,
        type: event.type,
        payload: envelope as unknown as Prisma.InputJsonValue,
      },
    });
    if (targets.length > 0) {
      await tx.webhookDelivery.createMany({
        data: targets.map((t) => ({ eventId: id, endpointId: t.id })),
      });
    }
  }
}
