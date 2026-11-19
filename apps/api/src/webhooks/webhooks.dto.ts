import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQueryDto } from '@/common/pagination';
import { WEBHOOK_EVENT_TYPES } from '@/webhooks/webhook-outbox';

@ApiSchema({ name: 'CreateWebhookEndpoint' })
export class CreateWebhookEndpointDto {
  @ApiProperty({
    example: 'https://merchant.example/hooks/pedospe',
    description: 'https only; it must resolve to public addresses.',
  })
  @IsString()
  @MaxLength(2000)
  url!: string;

  @ApiPropertyOptional({ example: 'Order bot', maxLength: 140 })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  description?: string;

  @ApiPropertyOptional({
    enum: WEBHOOK_EVENT_TYPES,
    isArray: true,
    description: 'Events to receive; omitted or empty: every event.',
  })
  @IsOptional()
  @IsArray()
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true })
  events?: string[];
}

@ApiSchema({ name: 'UpdateWebhookEndpoint' })
export class UpdateWebhookEndpointDto {
  @ApiPropertyOptional({ example: 'https://merchant.example/hooks/pedospe' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;

  @ApiPropertyOptional({ maxLength: 140 })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  description?: string;

  @ApiPropertyOptional({ enum: WEBHOOK_EVENT_TYPES, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true })
  events?: string[];

  @ApiPropertyOptional({ description: 'false pauses deliveries to it.' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

@ApiSchema({
  name: 'WebhookEndpoint',
  description: 'Where an organization receives events, per tier.',
})
export class WebhookEndpointView {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['live', 'test'] }) tier!: string;
  @ApiProperty() url!: string;
  @ApiPropertyOptional({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ enum: WEBHOOK_EVENT_TYPES, isArray: true }) events!: string[];
  @ApiProperty() active!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

@ApiSchema({ name: 'CreatedWebhookEndpoint' })
export class CreatedWebhookEndpointView extends WebhookEndpointView {
  @ApiProperty({
    example: 'whsec_9x...',
    description:
      'The signing secret, shown once. Verify `pedospe-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.',
  })
  secret!: string;
}

@ApiSchema({ name: 'WebhookEndpointList' })
export class WebhookEndpointListView {
  @ApiProperty({ type: [WebhookEndpointView] }) data!: WebhookEndpointView[];
}

@ApiSchema({
  name: 'WebhookDelivery',
  description: 'One event sent (or being sent) to one endpoint.',
})
export class WebhookDeliveryView {
  @ApiProperty() id!: string;
  @ApiProperty() eventId!: string;
  @ApiProperty({ enum: WEBHOOK_EVENT_TYPES }) type!: string;
  @ApiProperty({ enum: ['pending', 'delivered', 'failed'] }) status!: string;
  @ApiProperty() attempts!: number;
  @ApiProperty() nextAttemptAt!: Date;
  @ApiPropertyOptional({ nullable: true, type: Number }) lastStatus!: number | null;
  @ApiPropertyOptional({ nullable: true, type: String }) lastError!: string | null;
  @ApiPropertyOptional({ nullable: true, type: Date }) deliveredAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'The body that is sent.',
  })
  payload!: Record<string, unknown>;
}

@ApiSchema({ name: 'WebhookDeliveryList' })
export class WebhookDeliveryListView {
  @ApiProperty({ type: [WebhookDeliveryView] }) data!: WebhookDeliveryView[];
  @ApiProperty() total!: number;
  @ApiProperty() take!: number;
  @ApiProperty() skip!: number;
}

export class QueryDeliveriesDto extends PageQueryDto {}
