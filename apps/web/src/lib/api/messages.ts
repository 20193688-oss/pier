/* An API or network failure in the reader's words: network down, too many requests, a role that
   may not do this, or the screen's own fallback. */
import { ApiError } from '@/lib/api/client';
import type { Messages } from '@/i18n';

export function errorMessage(common: Messages['common'], e: unknown, fallback?: string): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return common.errors.network;
    if (e.status === 429) return common.errors.limited;
    if (e.status === 403) return common.errors.forbidden;
    if (e.status === 503) return common.errors.unavailable;
    if (e.code === 'bad_response') return common.errors.badResponse;
  }
  return fallback ?? common.errors.generic;
}

export const isUnauthorized = (e: unknown) => e instanceof ApiError && e.status === 401;
export const isNotFound = (e: unknown) => e instanceof ApiError && e.status === 404;
