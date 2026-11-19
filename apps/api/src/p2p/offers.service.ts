import { Injectable } from '@nestjs/common';
import type { OrgPrincipal } from '@/auth/auth.types';
import { DeploymentsService } from '@/chain/deployments.service';
import type { Tier } from '@/chain/networks';
import { ApiError } from '@/common/api-error';
import { page, type Page } from '@/common/pagination';
import { AccountsService } from '@/p2p/accounts.service';
import {
  P2P_CURRENCIES,
  P2P_DEFAULT_PRICE_TTL_SECONDS,
  P2P_PRICE_DECIMALS,
  type P2pCurrency,
} from '@/p2p/domain/constants';
import { parseDecimalUnits } from '@/p2p/domain/pricing';
import { isP2pRailId, P2P_RAILS } from '@/p2p/domain/rails';
import type { CreateOfferDto, QueryOffersDto, UpdateOfferDto } from '@/p2p/dto/offer.dto';
import type { OfferView } from '@/p2p/entities/offer.entity';
import { tierOf } from '@/p2p/tier';
import { P2P_OFFER_SELECT, toOfferView, type P2pOfferRow } from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Merchants' standing prices. An offer is the merchant's word on a price and
 * its limits; whether it can be filled right now (liquidity, open orders,
 * a fresh price) is decided at match time, never here.
 */
@Injectable()
export class OffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly deployments: DeploymentsService,
  ) {}

  private symbolOf(tier: Tier, row: P2pOfferRow): string {
    const d = this.deployments.find(tier, row.network);
    return (
      d?.tokens.find((t) => t.address.toLowerCase() === row.token.toLowerCase())?.symbol ??
      row.token
    );
  }

  private view(tier: Tier, row: P2pOfferRow): OfferView {
    return toOfferView(row, this.symbolOf(tier, row), new Date());
  }

  /** Checks price and bounds together: a positive price, min ≤ max, both within the currency's decimals. */
  private checkTerms(
    currency: string,
    terms: { price: string; minFiat: string; maxFiat: string },
  ): void {
    const errors: string[] = [];
    const decimals = P2P_CURRENCIES[currency as P2pCurrency].decimals;
    const price = parseDecimalUnits(terms.price, P2P_PRICE_DECIMALS);
    const min = parseDecimalUnits(terms.minFiat, decimals);
    const max = parseDecimalUnits(terms.maxFiat, decimals);
    if (price === null || price <= 0n) errors.push('price must be greater than 0');
    if (min === null) errors.push(`minFiat takes at most ${decimals} decimals in ${currency}`);
    if (max === null) errors.push(`maxFiat takes at most ${decimals} decimals in ${currency}`);
    if (min !== null && max !== null && (min <= 0n || min > max)) {
      errors.push('minFiat must be greater than 0 and at most maxFiat');
    }
    if (errors.length) throw ApiError.validation(errors);
  }

  private checkRails(currency: string, rails: string[]): void {
    const wrong = rails.filter((r) => !isP2pRailId(r) || P2P_RAILS[r].currency !== currency);
    if (wrong.length) {
      throw ApiError.validation([`rails ${wrong.join(', ')} do not pay in ${currency}`]);
    }
  }

  async create(org: OrgPrincipal, dto: CreateOfferDto): Promise<OfferView> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const account = await this.accounts.owned(organizationId, tier, dto.accountId);
    if (!account.displayName) {
      throw ApiError.validation([
        'the account needs a displayName before it can publish an offer (PATCH /v1/p2p/accounts/{id})',
      ]);
    }
    const deployment = this.deployments.require(tier, dto.network);
    const token = this.deployments.token(deployment, dto.token);
    this.checkRails(dto.currency, dto.rails);
    this.checkTerms(dto.currency, dto);
    const row = await this.prisma.p2pOffer.create({
      data: {
        accountId: account.id,
        organizationId,
        tier,
        side: dto.side,
        network: deployment.network,
        token: token.address,
        currency: dto.currency,
        rails: [...new Set(dto.rails)],
        price: dto.price,
        priceUpdatedAt: new Date(),
        priceTtlSeconds: dto.priceTtlSeconds ?? P2P_DEFAULT_PRICE_TTL_SECONDS,
        minFiat: dto.minFiat,
        maxFiat: dto.maxFiat,
        active: dto.active ?? true,
      },
      select: P2P_OFFER_SELECT,
    });
    return this.view(tier, row);
  }

  async list(org: OrgPrincipal, query: QueryOffersDto): Promise<Page<OfferView>> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const where = {
      organizationId,
      tier,
      ...(query.accountId ? { accountId: query.accountId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.p2pOffer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_OFFER_SELECT,
      }),
      this.prisma.p2pOffer.count({ where }),
    ]);
    return page(
      rows.map((r) => this.view(tier, r)),
      total,
      query,
    );
  }

  private async owned(organizationId: string, tier: string, id: string) {
    const row = await this.prisma.p2pOffer.findFirst({
      where: { id, organizationId, tier },
      select: P2P_OFFER_SELECT,
    });
    if (!row) throw ApiError.notFound(`P2P offer ${id} not found`);
    return row;
  }

  async update(org: OrgPrincipal, id: string, dto: UpdateOfferDto): Promise<OfferView> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const row = await this.owned(organizationId, tier, id);
    if (dto.rails) this.checkRails(row.currency, dto.rails);
    this.checkTerms(row.currency, {
      price: dto.price ?? row.price,
      minFiat: dto.minFiat ?? row.minFiat,
      maxFiat: dto.maxFiat ?? row.maxFiat,
    });
    await this.prisma.p2pOffer.updateMany({
      where: { id: row.id, organizationId, tier },
      data: {
        ...(dto.price !== undefined ? { price: dto.price, priceUpdatedAt: new Date() } : {}),
        ...(dto.priceTtlSeconds !== undefined ? { priceTtlSeconds: dto.priceTtlSeconds } : {}),
        ...(dto.rails ? { rails: [...new Set(dto.rails)] } : {}),
        ...(dto.minFiat !== undefined ? { minFiat: dto.minFiat } : {}),
        ...(dto.maxFiat !== undefined ? { maxFiat: dto.maxFiat } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });
    return this.view(tier, await this.owned(organizationId, tier, id));
  }

  async remove(org: OrgPrincipal, id: string): Promise<void> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const row = await this.owned(organizationId, tier, id);
    await this.prisma.p2pOffer.deleteMany({
      where: { id: row.id, organizationId, tier },
    });
  }

  /** Whether the account publishes an active offer selling tokens (a liquidity merchant). */
  async sellsLiquidity(accountId: string): Promise<boolean> {
    return (
      (await this.prisma.p2pOffer.count({
        where: { accountId, side: 'SELL_TOKEN', active: true },
      })) > 0
    );
  }
}
