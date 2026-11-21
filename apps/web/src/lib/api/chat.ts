/* An order's chat through the API (src/lib/p2p/chat.ts has the shapes): read the messages, send
   one (text, a receipt, or both), and fetch a receipt's file. `scope` names whose side asks: the
   payments app's wallet (`app`), an integrator's org (`org`) or the merchant (`merchant`); a
   dashboard call also names its organization and tier (`org`, the dashboard's Scope). */
import { ApiError, itemOf, listOf, request } from '@/lib/api/client';
import { ROUTES } from '@/lib/api/routes';
import { scoped, type Scope } from '@/lib/api/endpoints';
import {
  readAttachment,
  readMessage,
  type ChatAttachment,
  type ChatMessage,
  type ChatSide,
} from '@/lib/p2p/chat';

export type ChatScope = 'app' | 'org' | 'merchant';

/** The side a scope writes as. */
export const sideOf = (scope: ChatScope): ChatSide =>
  scope === 'merchant' ? 'merchant' : 'creator';

export interface NewMessage {
  text?: string;
  attachment?: { name: string; contentType: string; data: string };
}

const bad = () => new ApiError(502, 'bad_response', 'The API answered in an unexpected shape.');

export const chat = {
  list: async (scope: ChatScope, orderId: string, org?: Scope): Promise<ChatMessage[]> =>
    listOf(
      await request({
        method: 'GET',
        path: ROUTES.orderMessages(scope, orderId),
        headers: scoped(org),
      }),
    )
      .map(readMessage)
      .filter((m): m is ChatMessage => m !== null),
  send: async (
    scope: ChatScope,
    orderId: string,
    body: NewMessage,
    org?: Scope,
  ): Promise<ChatMessage> => {
    const m = readMessage(
      itemOf(
        await request({
          method: 'POST',
          path: ROUTES.orderMessages(scope, orderId),
          body,
          headers: scoped(org),
        }),
      ),
    );
    if (!m) throw bad();
    return m;
  },
  attachment: async (
    scope: ChatScope,
    orderId: string,
    messageId: string,
    org?: Scope,
  ): Promise<ChatAttachment> => {
    const a = readAttachment(
      itemOf(
        await request({
          method: 'GET',
          path: ROUTES.orderMessageAttachment(scope, orderId, messageId),
          headers: scoped(org),
        }),
      ),
    );
    if (!a) throw bad();
    return a;
  },
};
