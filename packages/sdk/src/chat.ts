import { unwrap, type PierClient } from '@/client';
import type { NewOrderMessage, OrderMessage, OrderMessageAttachment } from '@/types';

/**
 * An order's chat between its two sides: the organization that created it
 * (`creator`, through `/v1/p2p/orders/{id}`), its merchant (`merchant`,
 * through `/v1/p2p/merchant/orders/{id}`), and the public app's signed-in
 * wallet, which creates its own orders (`app`, through `/v1/app/orders/{id}`,
 * with a session token). A message with a file is a transfer receipt.
 *
 * ```ts
 * await sendOrderMessage(client, 'merchant', order.id, {
 *   text: 'Listo, ya te transferí.',
 *   attachment: { name: 'comprobante.pdf', contentType: 'application/pdf', data: pdfBase64 },
 * });
 * ```
 */
export type OrderChatRoutes = 'creator' | 'merchant' | 'app';

/** The order's latest messages (200 at most), oldest first. */
export async function listOrderMessages(
  client: PierClient,
  as: OrderChatRoutes,
  orderId: string,
): Promise<OrderMessage[]> {
  const params = { params: { path: { id: orderId } } };
  const page =
    as === 'merchant'
      ? await unwrap(client.GET('/v1/p2p/merchant/orders/{id}/messages', params))
      : as === 'app'
        ? await unwrap(client.GET('/v1/app/orders/{id}/messages', params))
        : await unwrap(client.GET('/v1/p2p/orders/{id}/messages', params));
  return page.data;
}

/**
 * Sends a message: a text (1 to 1000 characters), a file (an image or a PDF of
 * at most 2 MiB, base64), or both.
 */
export async function sendOrderMessage(
  client: PierClient,
  as: OrderChatRoutes,
  orderId: string,
  body: NewOrderMessage,
): Promise<OrderMessage> {
  const init = { params: { path: { id: orderId } }, body };
  return as === 'merchant'
    ? unwrap(client.POST('/v1/p2p/merchant/orders/{id}/messages', init))
    : as === 'app'
      ? unwrap(client.POST('/v1/app/orders/{id}/messages', init))
      : unwrap(client.POST('/v1/p2p/orders/{id}/messages', init));
}

/** A message's file, its bytes in base64 (a `404 not_found` when it has none). */
export async function getOrderMessageAttachment(
  client: PierClient,
  as: OrderChatRoutes,
  orderId: string,
  messageId: string,
): Promise<OrderMessageAttachment> {
  const params = { params: { path: { id: orderId, messageId } } };
  return as === 'merchant'
    ? unwrap(client.GET('/v1/p2p/merchant/orders/{id}/messages/{messageId}/attachment', params))
    : as === 'app'
      ? unwrap(client.GET('/v1/app/orders/{id}/messages/{messageId}/attachment', params))
      : unwrap(client.GET('/v1/p2p/orders/{id}/messages/{messageId}/attachment', params));
}
