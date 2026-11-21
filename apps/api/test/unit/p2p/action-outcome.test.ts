import { describe, expect, it } from 'vitest';
import { P2P_CHAIN_STATUSES } from '@/chain/market-codec';
import {
  chainOutcome,
  P2P_ACTION_OUTCOMES,
  P2P_OUTCOME_ACTIONS,
  showsOutcome,
  type P2pOutcomeAction,
} from '@/p2p/domain/action-outcome';
import { P2P_EVENT_TRANSITIONS, P2P_ORDER_STATUSES } from '@/p2p/domain/order-status';

/** The event each action emits when it goes through. */
const EVENT_OF: Record<Exclude<P2pOutcomeAction, 'open'>, keyof typeof P2P_EVENT_TRANSITIONS> = {
  accept: 'order_accepted',
  markPaid: 'order_paid',
  release: 'order_released',
  cancel: 'order_cancelled',
  dispute: 'order_disputed',
};

const shown = (action: P2pOutcomeAction) =>
  P2P_ORDER_STATUSES.filter((status) => showsOutcome(action, status));

describe('what an order already shows', () => {
  it('answers each action from its own table', () => {
    expect(shown('accept')).toEqual([
      'awaiting_payment',
      'paid',
      'disputed',
      'completed',
      'resolved',
    ]);
    expect(shown('markPaid')).toEqual(['paid', 'disputed', 'completed', 'resolved']);
    expect(shown('release')).toEqual(['completed']);
    expect(shown('cancel')).toEqual(['cancelled', 'expired']);
    expect(shown('dispute')).toEqual(['disputed', 'resolved']);
    expect(shown('open')).toEqual([
      'awaiting_acceptance',
      'awaiting_payment',
      'paid',
      'disputed',
      'completed',
      'cancelled',
      'expired',
      'resolved',
    ]);
  });

  it('names only statuses the API has', () => {
    for (const action of P2P_OUTCOME_ACTIONS) {
      for (const status of P2P_ACTION_OUTCOMES[action]) {
        expect(P2P_ORDER_STATUSES).toContain(status);
      }
    }
  });

  it('never reads pending or failed as done, nor a status it does not know', () => {
    for (const action of P2P_OUTCOME_ACTIONS) {
      expect(showsOutcome(action, 'pending'), action).toBe(false);
      expect(showsOutcome(action, 'failed'), action).toBe(false);
      expect(showsOutcome(action, 'settled'), action).toBe(false);
    }
  });

  it('is never what an action starts from, and always where its event lands', () => {
    for (const [action, event] of Object.entries(EVENT_OF) as [
      P2pOutcomeAction,
      keyof typeof P2P_EVENT_TRANSITIONS,
    ][]) {
      const { from, to } = P2P_EVENT_TRANSITIONS[event];
      for (const status of from)
        expect(showsOutcome(action, status), `${action} ${status}`).toBe(false);
      expect(showsOutcome(action, to), `${action} ${to}`).toBe(true);
    }
    // A sale opens from pending (and, signed late, from failed).
    expect(showsOutcome('open', 'pending')).toBe(false);
  });

  it('stays done as the order moves on, unless it is cancelled', () => {
    for (const action of P2P_OUTCOME_ACTIONS) {
      for (const [event, { from, to }] of Object.entries(P2P_EVENT_TRANSITIONS)) {
        if (event === 'order_cancelled') continue;
        for (const status of from) {
          if (showsOutcome(action, status)) {
            expect(showsOutcome(action, to), `${action}: ${status} -> ${to}`).toBe(true);
          }
        }
      }
    }
  });

  it('reads the contract’s status as the API would', () => {
    expect(chainOutcome('markPaid', 'Paid')).toBe('paid');
    expect(chainOutcome('markPaid', 'Released')).toBe('completed');
    expect(chainOutcome('markPaid', 'Active')).toBeNull();
    expect(chainOutcome('release', 'Released')).toBe('completed');
    expect(chainOutcome('release', 'Paid')).toBeNull();
    expect(chainOutcome('cancel', 'Cancelled')).toBe('cancelled');
    expect(chainOutcome('cancel', 'Active')).toBeNull();
    expect(chainOutcome('dispute', 'Disputed')).toBe('disputed');
    expect(chainOutcome('dispute', 'Resolved')).toBe('resolved');
    expect(chainOutcome('accept', 'Active')).toBe('awaiting_payment');
    expect(chainOutcome('accept', 'Offered')).toBeNull();
    expect(chainOutcome('open', 'Offered')).toBe('awaiting_acceptance');
    expect(chainOutcome('open', 'Cancelled')).toBe('cancelled');
    for (const action of P2P_OUTCOME_ACTIONS) {
      expect(chainOutcome(action, 'None'), action).toBeNull();
    }
    for (const status of P2P_CHAIN_STATUSES) {
      const read = chainOutcome('open', status);
      expect(read === null).toBe(status === 'None');
    }
  });
});
