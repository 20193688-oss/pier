import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import {
  ORDER_CHAT_ATTACHMENT_MAX_BYTES,
  ORDER_CHAT_ATTACHMENT_TYPES,
  ORDER_CHAT_SIDES,
} from '@/p2p/domain/order-chat';

@ApiSchema({
  name: 'OrderChatSummary',
  description:
    'An order’s chat at a glance (an unread badge reads it): how many messages, when the last one came and from which side.',
})
export class OrderChatSummaryView {
  @ApiProperty({ example: 3 })
  count!: number;

  @ApiProperty({ type: String, nullable: true, example: '2026-11-20T12:05:00.000Z' })
  lastAt!: Date | null;

  @ApiProperty({ enum: ORDER_CHAT_SIDES, nullable: true, example: 'merchant' })
  lastFrom!: string | null;
}

@ApiSchema({
  name: 'OrderMessageAttachmentMeta',
  description: 'A message’s file, without its bytes.',
})
export class OrderMessageAttachmentMetaView {
  @ApiProperty({ example: 'comprobante.pdf', description: 'For display only.' })
  name!: string;

  @ApiProperty({ enum: ORDER_CHAT_ATTACHMENT_TYPES, example: 'application/pdf' })
  contentType!: string;

  @ApiProperty({ example: 48213, description: 'Bytes.' })
  size!: number;
}

@ApiSchema({
  name: 'OrderMessageView',
  description:
    'One message of an order’s chat, between the side that created the order (`creator`) and its merchant (`merchant`). A message with an attachment is a transfer receipt (`kind: receipt`); fetch its bytes from `…/messages/{messageId}/attachment`.',
})
export class OrderMessageView {
  @ApiProperty({ example: '6c1d0f3a-2b4e-4f6a-9c8d-7e6f5a4b3c2d' })
  id!: string;

  @ApiProperty({ example: '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10' })
  orderId!: string;

  @ApiProperty({ enum: ORDER_CHAT_SIDES, example: 'merchant' })
  from!: string;

  @ApiProperty({ enum: ['text', 'receipt'], example: 'receipt' })
  kind!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Listo, ya te transferí.' })
  text!: string | null;

  @ApiProperty({ type: OrderMessageAttachmentMetaView, nullable: true })
  attachment!: OrderMessageAttachmentMetaView | null;

  @ApiProperty({ example: '2026-11-20T12:05:00.000Z' })
  createdAt!: Date;
}

@ApiSchema({
  name: 'OrderMessageList',
  description: 'An order’s latest messages (200 at most), oldest first.',
})
export class OrderMessageListView {
  @ApiProperty({ type: [OrderMessageView] })
  data!: OrderMessageView[];
}

@ApiSchema({
  name: 'OrderMessageAttachment',
  description: 'A message’s file, its bytes in base64.',
})
export class OrderMessageAttachmentView extends OrderMessageAttachmentMetaView {
  @ApiProperty({
    format: 'byte',
    description: `The file, base64 (at most ${ORDER_CHAT_ATTACHMENT_MAX_BYTES} bytes decoded).`,
    example: 'JVBERi0xLjQK...',
  })
  data!: string;
}
