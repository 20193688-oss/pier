import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { SessionPrincipal } from '@/auth/auth.types';
import { DeploymentsService } from '@/chain/deployments.service';
import { MarketReader } from '@/chain/market-reader.service';
import type { Tier } from '@/chain/networks';
import type { BuiltTransaction } from '@/chain/tx-builder.service';
import { ApiError, ErrorCode } from '@/common/api-error';
import { page, type Page } from '@/common/pagination';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { isUuid } from '@/p2p/domain/order-ref';
import { P2P_LIVE_STATUSES } from '@/p2p/domain/order-status';
import { readQrPayment } from '@/p2p/domain/qr-pay';
import { buildOrderAction, type P2pTransactionAction } from '@/p2p/domain/transaction-actions';
import type { AppOrderDto, AppQuoteDto, AppTransactionDto } from '@/p2p/dto/app.dto';
import type { CreateQuoteDto, QueryOrdersDto, ReportPaidDto } from '@/p2p/dto/order.dto';
import type { QuoteView } from '@/p2p/entities/offer.entity';
import type { CreatedOrderView, OrderView } from '@/p2p/entities/order.entity';
import { OrdersService } from '@/p2p/orders.service';
import { APP_ORGANIZATION_ID } from '@/p2p/p2p-events';
import { QuotesService } from '@/p2p/quotes.service';
import { TransactionsService } from '@/p2p/transactions.service';
import { P2P_ORDER_SELECT, type P2pOrderRow } from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * The public app: people sign in with their wallet (SEP-10) and trade or pay
 * for themselves. Their orders belong to the built-in app organization and
 * are bound to their wallet: a purchase delivers to it, a sale or a QR
 * payment is signed by it, and a wallet only ever reads and acts on its own
 * orders.
 */
@Injectable()
export class AppOrdersService implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly reader: MarketReader,
    private readonly quotes: QuotesService,
    private readonly orders: OrdersService,
    private readonly transactions: TransactionsService,
  ) {}

  /** The app's built-in organization exists before any request. */
  async onModuleInit(): Promise<void> {
    await this.prisma.organization.upsert({
      where: { id: APP_ORGANIZATION_ID },
      create: { id: APP_ORGANIZATION_ID, name: `${this.config.brandName} app`, system: true },
      update: {},
    });
  }

  /** The app's tier, when the market runs there. */
  tier(): Tier {
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
    const base = {
      organizationId: APP_ORGANIZATION_ID,
      tier: this.tier(),
      integratorFeeBps: integratorAddress ? integratorFeeBps : 0,
      integratorAddress,
      endUserAddress: session.address,
    };
    if (dto.kind === 'QR_PAY') {
      if (dto.qr === undefined) throw ApiError.validation(['qr is required on a QR payment']);
      if (dto.tokenAmount !== undefined || dto.currency || dto.rail || dto.side) {
        throw ApiError.validation([
          'a QR payment takes qr (and fiatAmount for a QR without amount), never side, currency, rail or tokenAmount',
        ]);
      }
      const read = readQrPayment(dto.qr, dto.fiatAmount);
      if (!read.ok) throw ApiError.badRequest(ErrorCode.QrInvalid, read.error);
      return this.quotes.quote({
        ...base,
        dto: {
          side: 'SELL',
          network: dto.network,
          token: dto.token,
          currency: read.currency,
          rail: read.rail,
          fiatAmount: read.fiatAmount,
        },
        qr: { hash: read.hash, summary: read.summary },
      });
    }
    const side = dto.side ?? dto.kind;
    if (!side || (dto.kind && dto.side && dto.kind !== dto.side)) {
      throw ApiError.validation(['side must be BUY or SELL (or kind QR_PAY with qr)']);
    }
    if (dto.qr !== undefined) throw ApiError.validation(['qr is only for kind QR_PAY']);
    if (!dto.currency || !dto.rail) {
      throw ApiError.validation(['currency and rail are required on a trade']);
    }
    const trade: Omit<CreateQuoteDto, 'integratorFeeBps' | 'integratorAccountId'> = {
      side,
      network: dto.network,
      token: dto.token,
      currency: dto.currency,
      rail: dto.rail,
      fiatAmount: dto.fiatAmount,
      tokenAmount: dto.tokenAmount,
    };
    return this.quotes.quote({ ...base, dto: trade });
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
    const { qr, kind, ...rest } = dto;
    return this.orders.createFor(
      { organizationId: APP_ORGANIZATION_ID, tier, endUserAddress: session.address },
      {
        ...rest,
        kind: kind === 'QR_PAY' ? undefined : kind,
        // The signed-in wallet receives a purchase and signs a sale; never another.
        recipient: session.address,
        seller: session.address,
      },
      kind === 'QR_PAY' || qr !== undefined ? { qr: qr ?? '' } : {},
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
  async own(session: SessionPrincipal, id: string): Promise<P2pOrderRow> {
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

  /** A purchase's buyer-side acts, sent by the matcher (the person needs no fees). */
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
  ): Promise<BuiltTransaction> {
    const row = await this.own(session, id);
    const built = buildOrderAction(
      dto.action as Exclude<
        P2pTransactionAction,
        'deposit' | 'withdraw' | 'setOperator' | 'setMatcher'
      >,
      { contract: row.contract, from: session.address, order: row, now: new Date() },
    );
    if (!built.ok) throw ApiError.badRequest(ErrorCode.InvalidState, built.error);
    const d = await this.reader.requireLive(row.tier as Tier, row.network);
    return this.transactions.prepared(d, session.address, built.value);
  }
}
