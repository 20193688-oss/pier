import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsString, ValidateNested } from 'class-validator';
import {
  ORDER_CHAT_ATTACHMENT_MAX_BASE64,
  ORDER_CHAT_ATTACHMENT_MAX_BYTES,
  ORDER_CHAT_ATTACHMENT_TYPES,
  ORDER_CHAT_NAME_MAX,
  ORDER_CHAT_TEXT_MAX,
} from '@/p2p/domain/order-chat';

// The lengths, the type list, the base64 and the file's leading bytes are checked by
// `checkOrderMessage` (one message per problem); these classes shape the body and document it.

@ApiSchema({
  name: 'CreateOrderMessageAttachment',
  description: `An image or a PDF (a transfer receipt), at most ${ORDER_CHAT_ATTACHMENT_MAX_BYTES} bytes, in base64. Its leading bytes must be those of its type.`,
})
export class OrderMessageAttachmentDto {
  @ApiProperty({
    minLength: 1,
    maxLength: ORDER_CHAT_NAME_MAX,
    example: 'comprobante.pdf',
    description: 'Shown to the other side; never used as a path.',
  })
  @IsString()
  name!: string;

  @ApiProperty({ enum: ORDER_CHAT_ATTACHMENT_TYPES, example: 'application/pdf' })
  @IsString()
  contentType!: string;

  @ApiProperty({
    format: 'byte',
    maxLength: ORDER_CHAT_ATTACHMENT_MAX_BASE64,
    example: 'JVBERi0xLjQK...',
    description: 'The file in standard base64 (padded, no line breaks).',
  })
  @IsString()
  data!: string;
}

@ApiSchema({
  name: 'CreateOrderMessage',
  description:
    'A message on an order’s chat: a text, an attachment (a transfer receipt), or both. At least one.',
})
export class CreateOrderMessageDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: ORDER_CHAT_TEXT_MAX,
    example: 'Listo, ya te transferí.',
    description: `Trimmed; 1 to ${ORDER_CHAT_TEXT_MAX} characters.`,
  })
  @IsOptional()
  @IsString()
  text?: string;

  @ApiPropertyOptional({ type: OrderMessageAttachmentDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OrderMessageAttachmentDto)
  attachment?: OrderMessageAttachmentDto;
}
