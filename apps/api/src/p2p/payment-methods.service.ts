import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { OrgPrincipal } from '@/auth/auth.types';
import { DeploymentsService } from '@/chain/deployments.service';
import { ApiError } from '@/common/api-error';
import { DataCipher } from '@/common/data-cipher';
import { page, type Page } from '@/common/pagination';
import { AccountsService } from '@/p2p/accounts.service';
import { isP2pRailId, isPersonName, validateRailDetails } from '@/p2p/domain/rails';
import type {
  CreatePaymentMethodDto,
  QueryPaymentMethodsDto,
  UpdatePaymentMethodDto,
} from '@/p2p/dto/payment-method.dto';
import type { PaymentMethodView } from '@/p2p/entities/account.entity';
import type { PaymentDetailsView } from '@/p2p/entities/order.entity';
import { tierOf } from '@/p2p/tier';
import {
  P2P_PAYMENT_METHOD_SELECT,
  toPaymentMethodView,
  type P2pPaymentMethodRow,
} from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Where an account receives local money. The details are checked per rail
 * (checksums included) and sealed at rest; the owner reads them back, and the
 * counterparty of a live order reads the ONE method that order names, through
 * {@link paymentDetailsOf}.
 */
@Injectable()
export class PaymentMethodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly cipher: DataCipher,
    private readonly deployments: DeploymentsService,
  ) {}

  private view(row: P2pPaymentMethodRow): PaymentMethodView {
    return toPaymentMethodView(row, {
      details: this.cipher.open('payment-method.details', row.id, row.details),
      holderName: this.cipher.open('payment-method.holder', row.id, row.holderName),
    });
  }

  private checked(rail: string, currency: string, details: unknown) {
    if (!isP2pRailId(rail)) {
      throw ApiError.validation([`rail ${rail} is not a rail`]);
    }
    const check = validateRailDetails(rail, currency, details);
    if (!check.ok) {
      throw ApiError.validation(check.errors);
    }
    return check.details;
  }

  private holder(name: string): string {
    const trimmed = name.trim();
    if (!isPersonName(trimmed)) {
      throw ApiError.validation(['holderName must be a person’s or a company’s name']);
    }
    return trimmed;
  }

  async create(org: OrgPrincipal, dto: CreatePaymentMethodDto): Promise<PaymentMethodView> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const account = await this.accounts.owned(organizationId, tier, dto.accountId);
    const details = this.checked(dto.rail, dto.currency, dto.details);
    const holderName = this.holder(dto.holderName);
    // The id is made here so the seal can bind to it.
    const id = randomUUID();
    const row = await this.prisma.p2pPaymentMethod.create({
      data: {
        id,
        accountId: account.id,
        organizationId,
        tier,
        currency: dto.currency,
        rail: dto.rail,
        details: this.cipher.seal('payment-method.details', id, details),
        holderName: this.cipher.seal('payment-method.holder', id, holderName),
        label: dto.label?.trim() || null,
      },
      select: P2P_PAYMENT_METHOD_SELECT,
    });
    return this.view(row);
  }

  async list(org: OrgPrincipal, query: QueryPaymentMethodsDto): Promise<Page<PaymentMethodView>> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const where = {
      organizationId,
      tier,
      ...(query.accountId ? { accountId: query.accountId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.p2pPaymentMethod.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_PAYMENT_METHOD_SELECT,
      }),
      this.prisma.p2pPaymentMethod.count({ where }),
    ]);
    return page(
      rows.map((r) => this.view(r)),
      total,
      query,
    );
  }

  private async owned(organizationId: string, tier: string, id: string) {
    const row = await this.prisma.p2pPaymentMethod.findFirst({
      where: { id, organizationId, tier },
      select: P2P_PAYMENT_METHOD_SELECT,
    });
    if (!row) throw ApiError.notFound(`P2P payment method ${id} not found`);
    return row;
  }

  async update(
    org: OrgPrincipal,
    id: string,
    dto: UpdatePaymentMethodDto,
  ): Promise<PaymentMethodView> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const row = await this.owned(organizationId, tier, id);
    const data: Record<string, unknown> = {};
    if (dto.details !== undefined) {
      data.details = this.cipher.seal(
        'payment-method.details',
        row.id,
        this.checked(row.rail, row.currency, dto.details),
      );
    }
    if (dto.holderName !== undefined) {
      data.holderName = this.cipher.seal(
        'payment-method.holder',
        row.id,
        this.holder(dto.holderName),
      );
    }
    if (dto.label !== undefined) data.label = dto.label.trim() || null;
    if (dto.active !== undefined) data.active = dto.active;
    await this.prisma.p2pPaymentMethod.updateMany({
      where: { id: row.id, organizationId, tier },
      data,
    });
    return this.view(await this.owned(organizationId, tier, id));
  }

  async remove(org: OrgPrincipal, id: string): Promise<void> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const row = await this.owned(organizationId, tier, id);
    await this.prisma.p2pPaymentMethod.deleteMany({
      where: { id: row.id, organizationId, tier },
    });
  }

  /** An account's active method for a rail and currency, for matching a purchase. */
  async activeFor(
    accountId: string,
    rail: string,
    currency: string,
  ): Promise<{ id: string } | null> {
    return this.prisma.p2pPaymentMethod.findFirst({
      where: { accountId, rail, currency, active: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
  }

  /** Accounts among `accountIds` holding an active method for the rail and currency. */
  async accountsWithMethod(
    accountIds: string[],
    rail: string,
    currency: string,
  ): Promise<Set<string>> {
    if (accountIds.length === 0) return new Set();
    const rows = await this.prisma.p2pPaymentMethod.findMany({
      where: { accountId: { in: accountIds }, rail, currency, active: true },
      select: { accountId: true },
    });
    return new Set(rows.map((r) => r.accountId));
  }

  /**
   * The details an order shows its payer: the ONE method the order names.
   * Callers decide whether the reader is entitled (the counterparty of a live
   * order); this only opens it. Null when the method was deleted.
   */
  async paymentDetailsOf(methodId: string | null): Promise<PaymentDetailsView | null> {
    if (!methodId) return null;
    const row = await this.prisma.p2pPaymentMethod.findUnique({
      where: { id: methodId },
      select: P2P_PAYMENT_METHOD_SELECT,
    });
    if (!row) return null;
    const view = this.view(row);
    return {
      rail: view.rail,
      holderName: view.holderName,
      details: view.details,
    };
  }
}
