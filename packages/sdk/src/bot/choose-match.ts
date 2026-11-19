import type { TransferMatch } from '@/types';

/** The best score the API gives: 1 for the amount, +1 for the payer's name, +1 for the document. */
export const MAX_MATCH_SCORE = 3;
/** The default threshold: amount, name and document all match. */
export const DEFAULT_MIN_SCORE = MAX_MATCH_SCORE;

/** What a bot does with an incoming transfer's matches. */
export type MatchDecision =
  | { action: 'release'; match: TransferMatch }
  | {
      action: 'skip';
      reason: 'no_matches' | 'below_threshold' | 'ambiguous' | 'not_a_purchase';
      /** The best score among the matches (0 without matches). */
      bestScore: number;
      /** The matches that share the best score. */
      candidates: TransferMatch[];
    };

/**
 * Decides whether a transfer settles exactly one order. Pure: it releases
 * only when the best match scores at least `minScore`, no other match shares
 * that score (two orders the transfer fits equally are left to a person) and
 * the order is a purchase (`BUY`). Ambiguity is judged over every match the
 * API returned, charges included, so a transfer that may belong to a charge
 * never releases a purchase. The API's order is not trusted: the best score
 * is recomputed here.
 */
export function chooseMatch(
  matches: readonly TransferMatch[],
  minScore: number = DEFAULT_MIN_SCORE,
): MatchDecision {
  if (!Number.isInteger(minScore) || minScore < 1 || minScore > MAX_MATCH_SCORE) {
    throw new RangeError(`minScore must be an integer from 1 to ${MAX_MATCH_SCORE}.`);
  }
  const scored = matches.filter((m) => Number.isFinite(m.score));
  if (scored.length === 0) {
    return { action: 'skip', reason: 'no_matches', bestScore: 0, candidates: [] };
  }
  const bestScore = Math.max(...scored.map((m) => m.score));
  const candidates = scored.filter((m) => m.score === bestScore);
  if (bestScore < minScore) {
    return { action: 'skip', reason: 'below_threshold', bestScore, candidates };
  }
  if (candidates.length > 1) {
    return { action: 'skip', reason: 'ambiguous', bestScore, candidates };
  }
  const [match] = candidates;
  if (match.order.kind !== 'BUY') {
    return { action: 'skip', reason: 'not_a_purchase', bestScore, candidates };
  }
  return { action: 'release', match };
}
