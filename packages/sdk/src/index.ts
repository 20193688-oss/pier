/**
 * @midpoint/sdk: a typed client for the Midpoint API, webhook verification and
 * the decision rule of the reference auto-release bot. The bot itself
 * (`dist/bot/auto-release.js`) needs `viem`; nothing exported here does.
 */
export {
  createMidpointClient,
  ORGANIZATION_HEADER,
  MidpointError,
  TIER_HEADER,
  UNEXPECTED_RESPONSE,
  unwrap,
  type MidpointClient,
  type MidpointClientOptions,
  type Unwrapped,
} from '@/client';
export {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  parseWebhook,
  MIDPOINT_SIGNATURE_HEADER,
  MidpointWebhookError,
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
