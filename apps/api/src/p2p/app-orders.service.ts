import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { SessionPrincipal } from '@/auth/auth.types';
import { DeploymentsService } from '@/chain/deployments.service';
import type { Tier } from '@/chain/networks';
import { ApiError, ErrorCode } from '@/common/api-error';
import { page, type Page } from '@/common/pagination';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { isUuid } from '@/p2p/domain/order-ref';
import { P2P_LIVE_STATUSES } from '@/p2p/domain/order-status';
import { buildOrderAction, type P2pTransactionAction } from '@/p2p/domain/transaction-actions';
import type { AppOrderDto, AppQuoteDto, AppTransactionDto } from '@/p2p/dto/app.dto';
import type { QueryOrdersDto, ReportPaidDto } from '@/p2p/dto/order.dto';
import type { QuoteView } from '@/p2p/entities/offer.entity';
import type { CreatedOrderView, OrderView } from '@/p2p/entities/order.entity';
import type { TransactionView } from '@/p2p/entities/transaction.entity';
import { OrdersService } from '@/p2p/orders.service';
import { APP_ORGANIZATION_ID } from '@/p2p/p2p-events';
import { QuotesService } from '@/p2p/quotes.service';
import { P2P_ORDER_SELECT, type P2pOrderRow } from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * The public pedospe app: people sign in with their wallet (SIWE) and trade
 * for themselves. Their orders belong to the built-in app organization and
 * are bound to their wallet: a purchase delivers to it, a sale is signed by
 * it, and a wallet only ever reads and acts on its own orders.
 */
@Injectable()
export class AppOrdersService implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly quotes: QuotesService,
    private readonly orders: OrdersService,
  ) {}

  /** The app's built-in organization exists before any request. */
  async onModuleInit(): Promise<void> {
    await this.prisma.organization.upsert({
      where: { id: APP_ORGANIZATION_ID },
      create: { id: APP_ORGANIZATION_ID, name: 'pedospe app', system: true },
      update: {},
    });
  }

  private tier(): Tier {
    const tier = this.config.app.tier;
    if (this.deployments.deployments(tier).length === 0) {
      throw ApiError.badRequest(
        ErrorCode.NetworkUnsupported,
        'The market is not available in the app right now.',
      );
    }
    return tier;
  }

  quote(session: SessionPrincipal, dto: AppQuoteDto): Promise<QuoteView> {
    const { integratorAddress, integratorFeeBps } = this.config.app;
    return this.quotes.quote({
      organizationId: APP_ORGANIZATION_ID,
      tier: this.tier(),
      dto,
      integratorFeeBps: integratorAddress ? integratorFeeBps : 0,
      integratorAddress,
      endUserAddress: session.address,
    });
  }

  async create(session: SessionPrincipal, dto: AppOrderDto): Promise<CreatedOrderView> {
    const tier = this.tier();
    const live = await this.prisma.p2pOrder.count({
      where: {
        organizationId: APP_ORGANIZATION_ID,
        tier,
        endUserAddress: session.address,
        status: { in: [...P2P_LIVE_STATUSES] },
      },
    });
    if (live >= this.config.app.maxLiveOrdersPerWallet) {
      throw ApiError.conflict(
        ErrorCode.OperationInFlight,
        `You have ${live} orders under way: finish one before starting another.`,
      );
    }
    return this.orders.createFor(
      { organizationId: APP_ORGANIZATION_ID, tier, endUserAddress: session.address },
      {
        ...dto,
        // The signed-in wallet receives a purchase and signs a sale; never another.
        recipient: session.address,
        seller: session.address,
      },
    );
  }

  async list(session: SessionPrincipal, query: QueryOrdersDto): Promise<Page<OrderView>> {
    const where = {
      organizationId: APP_ORGANIZATION_ID,
      tier: this.config.app.tier,
      endUserAddress: session.address,
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.p2pOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_ORDER_SELECT,
      }),
      this.prisma.p2pOrder.count({ where }),
    ]);
    return page(await Promise.all(rows.map((r) => this.orders.clientView(r, false))), total, query);
  }

  /** The wallet's own order, or the 404 of a missing one. */
  private async own(session: SessionPrincipal, id: string): Promise<P2pOrderRow> {
    const row = isUuid(id)
      ? await this.prisma.p2pOrder.findFirst({
          where: {
            id,
            organizationId: APP_ORGANIZATION_ID,
            tier: this.config.app.tier,
            endUserAddress: session.address,
          },
          select: P2P_ORDER_SELECT,
        })
      : null;
    if (!row) throw ApiError.notFound(`Order ${id} not found`);
    return row;
  }

  async get(session: SessionPrincipal, id: string): Promise<OrderView> {
    return this.orders.clientView(await this.own(session, id), true);
  }

  /** A purchase's buyer-side acts, sent by the matcher (the person needs no gas). */
  async act(
    session: SessionPrincipal,
    id: string,
    action: 'paid' | 'cancel' | 'dispute',
    dto?: ReportPaidDto,
  ): Promise<OrderView> {
    const row = await this.own(session, id);
    return this.orders.clientView(
      await this.orders.sendBuyerAct(row, action, dto?.reference),
      true,
    );
  }

  /** A transaction for the person's own wallet on their order (release, cancel, dispute a sale...). */
  async transaction(
    session: SessionPrincipal,
    id: string,
    dto: AppTransactionDto,
  ): Promise<TransactionView> {
    const row = await this.own(session, id);
    const built = buildOrderAction(
      dto.action as Exclude<
        P2pTransactionAction,
        'approve' | 'deposit' | 'withdraw' | 'setOperator' | 'setMatcher'
      >,
      {
        contract: row.contract,
        from: session.address,
        order: row,
        now: new Date(),
      },
    );
    if (!built.ok) throw ApiError.badRequest(ErrorCode.InvalidState, built.error);
    return { chainId: this.orders.chainIdOf(row), value: '0', ...built.value };
  }
}
