import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { OrgPrincipal } from '@/auth/auth.types';
import { CurrentOrg, OrgAuth } from '@/auth/decorators';
import { ApiErrors } from '@/common/openapi';
import {
  CreatedWebhookEndpointView,
  CreateWebhookEndpointDto,
  QueryDeliveriesDto,
  UpdateWebhookEndpointDto,
  WebhookDeliveryListView,
  WebhookEndpointListView,
  WebhookEndpointView,
} from '@/webhooks/webhooks.dto';
import { WebhooksService } from '@/webhooks/webhooks.service';

@ApiTags('Webhooks')
@Controller('v1/webhook-endpoints')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post()
  @OrgAuth('p2p:write')
  @ApiOperation({
    summary: 'Register a webhook endpoint',
    description:
      'Receives the events of your organization on this tier, signed with `midpoint-signature`. The secret is in this response only.',
  })
  @ApiCreatedResponse({ type: CreatedWebhookEndpointView })
  @ApiErrors(400, 409)
  create(@CurrentOrg() org: OrgPrincipal, @Body() dto: CreateWebhookEndpointDto) {
    return this.webhooks.create(org, dto);
  }

  @Get()
  @OrgAuth('p2p:read')
  @ApiOperation({ summary: 'Webhook endpoints on this tier' })
  @ApiOkResponse({ type: WebhookEndpointListView })
  async list(@CurrentOrg() org: OrgPrincipal): Promise<WebhookEndpointListView> {
    return { data: await this.webhooks.list(org) };
  }

  @Get(':id')
  @OrgAuth('p2p:read')
  @ApiOperation({ summary: 'One webhook endpoint' })
  @ApiOkResponse({ type: WebhookEndpointView })
  @ApiErrors(404)
  get(@CurrentOrg() org: OrgPrincipal, @Param('id') id: string) {
    return this.webhooks.get(org, id);
  }

  @Patch(':id')
  @OrgAuth('p2p:write')
  @ApiOperation({ summary: 'Change or pause a webhook endpoint' })
  @ApiOkResponse({ type: WebhookEndpointView })
  @ApiErrors(400, 404)
  update(
    @CurrentOrg() org: OrgPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookEndpointDto,
  ) {
    return this.webhooks.update(org, id, dto);
  }

  @Delete(':id')
  @OrgAuth('p2p:write')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a webhook endpoint',
    description: 'Its pending deliveries are dropped.',
  })
  @ApiNoContentResponse()
  @ApiErrors(404)
  remove(@CurrentOrg() org: OrgPrincipal, @Param('id') id: string): Promise<void> {
    return this.webhooks.remove(org, id);
  }

  @Get(':id/deliveries')
  @OrgAuth('p2p:read')
  @ApiOperation({
    summary: 'Deliveries of a webhook endpoint',
    description: 'Newest first, with attempts, the last answer and the body sent.',
  })
  @ApiOkResponse({ type: WebhookDeliveryListView })
  @ApiErrors(400, 404)
  deliveries(
    @CurrentOrg() org: OrgPrincipal,
    @Param('id') id: string,
    @Query() query: QueryDeliveriesDto,
  ) {
    return this.webhooks.deliveries(org, id, query);
  }
}
