/**
 * @pier/sdk: a typed client for the Pier API, webhook verification and
 * the decision rule of the reference auto-release bot. The bot itself
 * (`dist/bot/auto-release.js`) needs `viem`; nothing exported here does.
 */
export {
  createPierClient,
  ORGANIZATION_HEADER,
  PierError,
  TIER_HEADER,
  UNEXPECTED_RESPONSE,
  unwrap,
  type PierClient,
  type PierClientOptions,
  type Unwrapped,
} from '@/client';
export {
  getOrderMessageAttachment,
  listOrderMessages,
  sendOrderMessage,
  type OrderChatRoutes,
} from '@/chat';
export {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  parseWebhook,
  PIER_SIGNATURE_HEADER,
  PierWebhookError,
  signWebhook,
  verifyWebhook,
  type VerifyWebhookOptions,
  type WebhookFailure,
} from '@/webhooks';
export {
  chooseMatch,
  DEFAULT_MIN_SCORE,
  MAX_MATCH_SCORE,
  type MatchDecision,
} from '@/bot/choose-match';
export type * from '@/types';
