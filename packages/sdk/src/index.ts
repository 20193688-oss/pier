/**
 * @pedospe/sdk: a typed client for the pedospe API, webhook verification and
 * the decision rule of the reference auto-release bot. The bot itself
 * (`dist/bot/auto-release.js`) needs `viem`; nothing exported here does.
 */
export {
  createPedospeClient,
  ORGANIZATION_HEADER,
  PedospeError,
  TIER_HEADER,
  UNEXPECTED_RESPONSE,
  unwrap,
  type PedospeClient,
  type PedospeClientOptions,
  type Unwrapped,
} from '@/client';
export {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  parseWebhook,
  PEDOSPE_SIGNATURE_HEADER,
  PedospeWebhookError,
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
