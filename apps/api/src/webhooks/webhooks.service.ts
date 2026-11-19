import { Inject, Injectable } from '@nestjs/common';
import { newSecret, type OrgPrincipal } from '@/auth/auth.types';
import { ApiError, ErrorCode } from '@/common/api-error';
import { DataCipher } from '@/common/data-cipher';
import { page, type Page } from '@/common/pagination';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { PrismaService } from '@/prisma/prisma.service';
import { destinationProblem } from '@/webhooks/ssrf';
import type {
  CreatedWebhookEndpointView,
  CreateWebhookEndpointDto,
  QueryDeliveriesDto,
  UpdateWebhookEndpointDto,
  WebhookDeliveryView,
  WebhookEndpointView,
} from '@/webhooks/webhooks.dto';

/** Endpoints one organization may register per tier. */
const MAX_ENDPOINTS = 10;

const SELECT = {
  id: true,
  tier: true,
  url: true,
  description: true,
  events: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Webhook endpoints per organization and tier. The signing secret is shown
 * once and kept sealed (it must be readable to sign, unlike a key hash).
 */
@Injectable()
export class WebhooksService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly cipher: DataCipher,
  ) {}

  private checkUrl(url: string): void {
    const problem = destinationProblem(url, { allowInsecure: this.config.webhooks.allowInsecure });
    if (problem) throw ApiError.validation([problem]);
  }

  async create(
    org: OrgPrincipal,
    dto: CreateWebhookEndpointDto,
  ): Promise<CreatedWebhookEndpointView> {
    this.checkUrl(dto.url);
    const count = await this.prisma.webhookEndpoint.count({
      where: { organizationId: org.organizationId, tier: org.tier },
    });
    if (count >= MAX_ENDPOINTS) {
      throw ApiError.conflict(ErrorCode.Conflict, `At most ${MAX_ENDPOINTS} endpoints per tier.`);
    }
    const secret = newSecret('whsec_');
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.webhookEndpoint.create({
        data: {
          organizationId: org.organizationId,
          tier: org.tier,
          url: dto.url,
          description: dto.description?.trim() || null,
          events: [...new Set(dto.events ?? [])],
          secret: 'pending',
        },
        select: { id: true },
      });
      return tx.webhookEndpoint.update({
        where: { id: created.id },
        data: { secret: this.cipher.seal('webhook-endpoint.secret', created.id, secret) },
        select: SELECT,
      });
    });
    return { ...row, secret };
  }

  async list(org: OrgPrincipal): Promise<WebhookEndpointView[]> {
    return this.prisma.webhookEndpoint.findMany({
      where: { organizationId: org.organizationId, tier: org.tier },
      orderBy: { createdAt: 'desc' },
      select: SELECT,
    });
  }

  async get(org: OrgPrincipal, id: string): Promise<WebhookEndpointView> {
    const row = await this.prisma.webhookEndpoint.findFirst({
      where: { id, organizationId: org.organizationId, tier: org.tier },
      select: SELECT,
    });
    if (!row) throw ApiError.notFound(`Webhook endpoint ${id} not found`);
    return row;
  }

  async update(
    org: OrgPrincipal,
    id: string,
    dto: UpdateWebhookEndpointDto,
  ): Promise<WebhookEndpointView> {
    await this.get(org, id);
    if (dto.url !== undefined) this.checkUrl(dto.url);
    await this.prisma.webhookEndpoint.updateMany({
      where: { id, organizationId: org.organizationId, tier: org.tier },
      data: {
        ...(dto.url !== undefined ? { url: dto.url } : {}),
        ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
        ...(dto.events !== undefined ? { events: [...new Set(dto.events)] } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });
    return this.get(org, id);
  }

  async remove(org: OrgPrincipal, id: string): Promise<void> {
    await this.get(org, id);
    await this.prisma.webhookEndpoint.deleteMany({
      where: { id, organizationId: org.organizationId, tier: org.tier },
    });
  }

  async deliveries(
    org: OrgPrincipal,
    id: string,
    query: QueryDeliveriesDto,
  ): Promise<Page<WebhookDeliveryView>> {
    await this.get(org, id);
    const where = { endpointId: id };
    const [rows, total] = await Promise.all([
      this.prisma.webhookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        include: { event: { select: { type: true, payload: true } } },
      }),
      this.prisma.webhookDelivery.count({ where }),
    ]);
    return page(
      rows.map((r) => ({
        id: r.id,
        eventId: r.eventId,
        type: r.event.type,
        status: r.status,
        attempts: r.attempts,
        nextAttemptAt: r.nextAttemptAt,
        lastStatus: r.lastStatus,
        lastError: r.lastError,
        deliveredAt: r.deliveredAt,
        createdAt: r.createdAt,
        payload: r.event.payload as Record<string, unknown>,
      })),
      total,
      query,
    );
  }
}
