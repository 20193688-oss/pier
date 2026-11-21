import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ApiError } from '@/common/api-error';
import { DataCipher } from '@/common/data-cipher';
import type { Prisma } from '@/generated/prisma/client';
import {
  ORDER_CHAT_LIST_MAX,
  checkOrderMessage,
  type OrderChatSide,
} from '@/p2p/domain/order-chat';
import { isUuid } from '@/p2p/domain/order-ref';
import type { CreateOrderMessageDto } from '@/p2p/dto/order-message.dto';
import type {
  OrderMessageAttachmentView,
  OrderMessageListView,
  OrderMessageView,
} from '@/p2p/entities/order-message.entity';
import { APP_ORGANIZATION_ID } from '@/p2p/p2p-events';
import { PrismaService } from '@/prisma/prisma.service';
import { enqueueWebhooks, type OutboxEvent } from '@/webhooks/webhook-outbox';

/** Every column a message view reads: never the attachment's bytes. */
const MESSAGE_SELECT = {
  id: true,
  orderId: true,
  sender: true,
  text: true,
  attachmentName: true,
  attachmentType: true,
  attachmentSize: true,
  createdAt: true,
} as const satisfies Prisma.P2pOrderMessageSelect;
type MessageRow = Prisma.P2pOrderMessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

/** The order a message is on, as the service needs it (the caller already proved access). */
export interface ChatOrder {
  id: string;
  tier: string;
  organizationId: string;
  merchantOrganizationId: string;
}

/** Who sends a message: their side of the order, their organization, and the app's wallet. */
export interface ChatSender {
  from: OrderChatSide;
  organizationId: string;
  address: string | null;
}

/**
 * The `P2P_ORDER_MESSAGE` event for the other side's organization: the order
 * and the message, without its text and its file's name and bytes (personal
 * data: event bodies are stored in plain text, so the receiver reads them on
 * the route). None for the public app's own organization, nor when both sides
 * are the same organization. Pure.
 */
export function orderMessageEvents(order: ChatOrder, message: OrderMessageView): OutboxEvent[] {
  const to = message.from === 'creator' ? order.merchantOrganizationId : order.organizationId;
  const from = message.from === 'creator' ? order.organizationId : order.merchantOrganizationId;
  if (to === APP_ORGANIZATION_ID || to === from) return [];
  return [
    {
      organizationId: to,
      tier: order.tier,
      type: 'P2P_ORDER_MESSAGE',
      data: {
        orderId: order.id,
        role: message.from === 'creator' ? 'merchant' : 'client',
        message: {
          id: message.id,
          orderId: message.orderId,
          from: message.from,
          kind: message.kind,
          attachment: message.attachment
            ? { contentType: message.attachment.contentType, size: message.attachment.size }
            : null,
          createdAt: message.createdAt,
        },
      },
    },
  ];
}

/**
 * An order's chat: its two sides' messages and the transfer receipts attached
 * to them. The text, the file's name and its bytes are sealed at rest; each
 * message also updates the order's chat summary (count, last time, last side)
 * without touching the order's own `updatedAt`. Access is the caller's: the
 * routes find the order the way their order GET does (404 for anyone else).
 */
@Injectable()
export class OrderMessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: DataCipher,
  ) {}

  private view(row: MessageRow): OrderMessageView {
    const attachment =
      row.attachmentType && row.attachmentName && row.attachmentSize !== null
        ? {
            name: this.cipher.open<string>(
              'order-message.attachment-name',
              row.id,
              row.attachmentName,
            ),
            contentType: row.attachmentType,
            size: row.attachmentSize,
          }
        : null;
    return {
      id: row.id,
      orderId: row.orderId,
      from: row.sender,
      kind: attachment ? 'receipt' : 'text',
      text: row.text ? this.cipher.open<string>('order-message.text', row.id, row.text) : null,
      attachment,
      createdAt: row.createdAt,
    };
  }

  /** The order's latest messages, oldest first. */
  async list(order: Pick<ChatOrder, 'id'>): Promise<OrderMessageListView> {
    const rows = await this.prisma.p2pOrderMessage.findMany({
      where: { orderId: order.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: ORDER_CHAT_LIST_MAX,
      select: MESSAGE_SELECT,
    });
    return { data: rows.reverse().map((r) => this.view(r)) };
  }

  /** Checks, seals and stores a message, updates the order's summary and tells the other side. */
  async send(
    order: ChatOrder,
    sender: ChatSender,
    dto: CreateOrderMessageDto,
  ): Promise<OrderMessageView> {
    const checked = checkOrderMessage(dto);
    if (!checked.ok) throw ApiError.validation(checked.errors);
    const { text, attachment } = checked.message;
    const id = randomUUID();
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.p2pOrderMessage.create({
        data: {
          id,
          orderId: order.id,
          sender: sender.from,
          senderOrganizationId: sender.organizationId,
          senderAddress: sender.address,
          text: text === null ? null : this.cipher.seal('order-message.text', id, text),
          ...(attachment
            ? {
                attachmentName: this.cipher.seal(
                  'order-message.attachment-name',
                  id,
                  attachment.name,
                ),
                attachmentType: attachment.contentType,
                attachmentSize: attachment.size,
                attachmentData: this.cipher.seal('order-message.attachment', id, attachment.data),
              }
            : {}),
        },
        select: MESSAGE_SELECT,
      });
      // The summary takes the message's own time; a chat message is not a change of the
      // order, so its `updatedAt` (which the jobs order their batches by) stays.
      await tx.$executeRaw`
        UPDATE "p2p_order"
        SET "chatCount" = "chatCount" + 1,
            "chatLastAt" = (SELECT "createdAt" FROM "p2p_order_message" WHERE "id" = ${id}),
            "chatLastFrom" = ${sender.from}
        WHERE "id" = ${order.id}`;
      await enqueueWebhooks(tx, orderMessageEvents(order, this.view(created)));
      return created;
    });
    return this.view(row);
  }

  /** A message's file, its bytes in base64; 404 when the message has none. */
  async attachment(
    order: Pick<ChatOrder, 'id'>,
    messageId: string,
  ): Promise<OrderMessageAttachmentView> {
    const row = isUuid(messageId)
      ? await this.prisma.p2pOrderMessage.findFirst({
          where: { id: messageId, orderId: order.id },
          select: { ...MESSAGE_SELECT, attachmentData: true },
        })
      : null;
    if (!row?.attachmentData || !row.attachmentType || !row.attachmentName) {
      throw ApiError.notFound(`Message ${messageId} has no attachment on this order`);
    }
    return {
      name: this.cipher.open<string>('order-message.attachment-name', row.id, row.attachmentName),
      contentType: row.attachmentType,
      size: row.attachmentSize ?? 0,
      data: this.cipher.open<string>('order-message.attachment', row.id, row.attachmentData),
    };
  }
}
