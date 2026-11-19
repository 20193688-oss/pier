import type { components, operations, paths } from '@/generated/schema';

/**
 * Friendly names for the schemas of the API contract. They are views of the
 * generated `components['schemas']` (from `apps/api/openapi.json`), so a
 * regenerated contract changes them too.
 */
type Schemas = components['schemas'];

export type { components, operations, paths };

/** A P2P order as the organization that created it sees it. */
export type Order = Schemas['OrderView'];
/** The order `POST /v1/p2p/orders` creates, with the transaction to open it when one is needed. */
export type CreatedOrder = Schemas['CreatedOrderView'];
/** An order as the merchant that fills it sees it (payer, sides, settlement). */
export type MerchantOrder = Schemas['MerchantOrderView'];
/** A priced, short-lived quote; an order is created from its id. */
export type Quote = Schemas['QuoteView'];
/** An order an incoming bank transfer most likely settles, with its `release` ready to sign. */
export type TransferMatch = Schemas['TransferMatchView'];
/** An incoming bank transfer as the merchant's bank notified it. */
export type TransferMatchRequest = Schemas['TransferMatchesDto'];
/** An unsigned EVM transaction (`chainId`, `to`, `data`, `value`) for a wallet or a bot to sign. */
export type Transaction = Schemas['TransactionView'];
/** The public market overview: networks, tokens, currencies, rails and windows. */
export type MarketOverview = Schemas['MarketOverviewView'];
export type Charge = Schemas['ChargeView'];
export type Offer = Schemas['OfferView'];
export type PaymentMethod = Schemas['PaymentMethodView'];
export type PayoutBatch = Schemas['PayoutBatchView'];
export type WebhookEndpoint = Schemas['WebhookEndpoint'];

/** The order kinds: BUY, SELL, CHARGE and PAYOUT. */
export type OrderKind = Order['kind'];
/** The order statuses, from `pending` to `completed`, `cancelled`, `expired`, `resolved` or `failed`. */
export type OrderStatus = Order['status'];
/** Every error the API answers: `{ "error": { "code", "message", "details"? } }`. */
export type ApiErrorBody = Schemas['Error'];
/** The machine-readable error codes. */
export type ErrorCode = Schemas['ErrorDetail']['code'];
/** The events a webhook endpoint can subscribe to. */
export type WebhookEventType = NonNullable<Schemas['CreateWebhookEndpoint']['events']>[number];
/** Credentials act on one tier: `live` or `test`. */
export type Tier = 'live' | 'test';

/** The body of every webhook delivery (not part of the OpenAPI contract). */
export interface WebhookEnvelope {
  /** The event id (`evt_...`), the same across retries: deduplicate on it. */
  id: string;
  type: WebhookEventType;
  /** When the event happened, ISO 8601. */
  createdAt: string;
  /** The resource the event is about (an order, a charge, a payout batch). */
  data: Record<string, unknown>;
}
