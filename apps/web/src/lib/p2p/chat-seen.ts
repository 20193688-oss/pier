/* What this browser already showed of each order's chat: the newest message's time, per side, so
   a list can mark an order with a message the person has not read (`hasUnseen`). Per viewer and
   per browser on purpose; a lost mark only shows a dot again. */
import type { ChatScope } from '@/lib/api/chat';

const key = (scope: ChatScope, orderId: string) => `midpoint.chat.seen.${scope}.${orderId}`;

export function seenAt(scope: ChatScope, orderId: string): string | null {
  try {
    return localStorage.getItem(key(scope, orderId));
  } catch {
    return null;
  }
}

/** Records `iso` as seen, never moving the mark back. */
export function markSeen(scope: ChatScope, orderId: string, iso: string) {
  try {
    const prev = localStorage.getItem(key(scope, orderId));
    if (!prev || Date.parse(iso) > Date.parse(prev)) localStorage.setItem(key(scope, orderId), iso);
  } catch {
    /* storage blocked: the dot shows again, nothing else */
  }
}
