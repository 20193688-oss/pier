import { describe, expect, it } from 'vitest';
import { chooseMatch, DEFAULT_MIN_SCORE } from '@/bot/choose-match';
import { transferMatch } from '@test/fixtures';

describe('chooseMatch', () => {
  it('skips a transfer that matches nothing', () => {
    expect(chooseMatch([], 3)).toEqual({
      action: 'skip',
      reason: 'no_matches',
      bestScore: 0,
      candidates: [],
    });
  });

  it('defaults to the full score: amount, name and document', () => {
    expect(DEFAULT_MIN_SCORE).toBe(3);
    expect(chooseMatch([transferMatch('7', 2)])).toMatchObject({
      action: 'skip',
      reason: 'below_threshold',
      bestScore: 2,
    });
    expect(chooseMatch([transferMatch('7', 3)])).toMatchObject({ action: 'release' });
  });

  it('releases the single best match at or above the threshold', () => {
    const best = transferMatch('7', 3);
    const decision = chooseMatch([transferMatch('5', 1), best, transferMatch('6', 2)], 3);
    expect(decision).toEqual({ action: 'release', match: best });
  });

  it('honours a lower threshold', () => {
    const match = transferMatch('7', 2);
    expect(chooseMatch([match, transferMatch('8', 1)], 2)).toEqual({ action: 'release', match });
    expect(chooseMatch([transferMatch('9', 1)], 1)).toMatchObject({ action: 'release' });
  });

  it('skips when the best match is below the threshold', () => {
    expect(chooseMatch([transferMatch('7', 2), transferMatch('8', 1)], 3)).toMatchObject({
      action: 'skip',
      reason: 'below_threshold',
      bestScore: 2,
    });
  });

  it('skips when two matches share the best score', () => {
    const decision = chooseMatch(
      [transferMatch('7', 3), transferMatch('8', 3), transferMatch('9', 2)],
      3,
    );
    expect(decision).toMatchObject({ action: 'skip', reason: 'ambiguous', bestScore: 3 });
    expect(decision.action === 'skip' && decision.candidates.map((m) => m.order.id)).toEqual([
      'order-7',
      'order-8',
    ]);
  });

  it('is ambiguous at a lower threshold too, and ignores lower-scored matches', () => {
    expect(chooseMatch([transferMatch('7', 1), transferMatch('8', 1)], 1)).toMatchObject({
      reason: 'ambiguous',
    });
    expect(
      chooseMatch([transferMatch('7', 2), transferMatch('8', 1), transferMatch('9', 1)], 1),
    ).toMatchObject({ action: 'release', match: { order: { id: 'order-7' } } });
  });

  it('does not trust the order of the matches', () => {
    const best = transferMatch('9', 3);
    expect(chooseMatch([transferMatch('7', 2), best], 3)).toEqual({
      action: 'release',
      match: best,
    });
  });

  it('judges ambiguity across charges but releases purchases only', () => {
    const charge = transferMatch('8', 3, { kind: 'CHARGE' });
    expect(chooseMatch([transferMatch('7', 3), charge], 3)).toMatchObject({ reason: 'ambiguous' });
    expect(chooseMatch([charge, transferMatch('7', 2)], 3)).toMatchObject({
      action: 'skip',
      reason: 'not_a_purchase',
    });
  });

  it('rejects a threshold outside 1 to 3', () => {
    for (const minScore of [0, 4, 2.5, Number.NaN]) {
      expect(() => chooseMatch([transferMatch('7', 3)], minScore)).toThrow(RangeError);
    }
  });
});
