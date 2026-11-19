import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiSchema,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import type { SessionPrincipal } from '@/auth/auth.types';
import { AdminAuth, CurrentSession, Public, SessionAuth } from '@/auth/decorators';
import { TIERS, type Tier } from '@/chain/networks';
import { ApiErrors } from '@/common/openapi';
import { RateLimit } from '@/common/rate-limit';
import { AdminService } from '@/p2p/admin.service';
import { AppOrdersService } from '@/p2p/app-orders.service';
import { AdminDisputesQueryDto, AdminMerchantDto, AdminResolutionDto } from '@/p2p/dto/admin.dto';
import { AppOrderDto, AppQuoteDto, AppTransactionDto } from '@/p2p/dto/app.dto';
import { QueryOrdersDto, ReportPaidDto } from '@/p2p/dto/order.dto';
import { MarketOverviewView } from '@/p2p/entities/market.entity';
import { QuoteView } from '@/p2p/entities/offer.entity';
import {
  CreatedOrderView,
  MerchantOrderListView,
  OrderListView,
  OrderView,
} from '@/p2p/entities/order.entity';
import { TransactionView } from '@/p2p/entities/transaction.entity';
import { MarketService } from '@/p2p/market.service';

const MINUTE = 60_000;

class MarketQueryDto {
  @ApiPropertyOptional({
    enum: TIERS,
    default: 'live',
    description: '`live` (mainnet) or `test` (test networks).',
  })
  @IsOptional()
  @IsIn(TIERS)
  tier?: Tier;
}

@ApiTags('Market')
@Controller('v1/market')
export class MarketController {
  constructor(private readonly market: MarketService) {}

  @Get()
  @Public()
  @RateLimit({ name: 'market', limit: 120, windowMs: MINUTE, per: 'ip' })
  @ApiOperation({
    summary: 'The market on a tier',
    description:
      'Networks with a verified deployment (contract, tokens, fee, pause state, explorer), currencies, rails and the fields each needs, order windows, the bond rate, and the matcher’s address (sellers authorise it with `setMatcher`). No credentials.',
  })
  @ApiOkResponse({ type: MarketOverviewView })
  @ApiErrors(400, 429)
  overview(@Query() query: MarketQueryDto) {
    return this.market.overview(query.tier ?? 'live');
  }
}

/** The public app's routes: a signed-in wallet trading for itself. */
@ApiTags('App')
@Controller('v1/app')
@SessionAuth()
export class AppController {
  constructor(private readonly app: AppOrdersService) {}

  @Post('quotes')
  @RateLimit({ name: 'app:quote', limit: 30, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Quote a trade for your wallet',
    description:
      'As `POST /v1/p2p/quotes`, on the app’s tier; a merchant at your own address is never matched.',
  })
  @ApiCreatedResponse({ type: QuoteView })
  @ApiErrors(400, 409, 429, 503)
  quote(@CurrentSession() session: SessionPrincipal, @Body() dto: AppQuoteDto) {
    return this.app.quote(session, dto);
  }

  @Post('orders')
  @RateLimit({ name: 'app:order', limit: 10, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Buy or sell from your quote',
    description:
      'BUY delivers to your wallet (pay the merchant’s account shown, then report it); SELL answers the two transactions your wallet signs. A few live orders per wallet at a time.',
  })
  @ApiCreatedResponse({ type: CreatedOrderView })
  @ApiErrors(400, 404, 409, 429, 503)
  create(@CurrentSession() session: SessionPrincipal, @Body() dto: AppOrderDto) {
    return this.app.create(session, dto);
  }

  @Get('orders')
  @ApiOperation({ summary: 'Your orders' })
  @ApiOkResponse({ type: OrderListView })
  @ApiErrors(400)
  list(@CurrentSession() session: SessionPrincipal, @Query() query: QueryOrdersDto) {
    return this.app.list(session, query);
  }

  @Get('orders/:id')
  @ApiOperation({
    summary: 'One of your orders',
    description: 'A live purchase carries the merchant’s account.',
  })
  @ApiOkResponse({ type: OrderView })
  @ApiErrors(404)
  get(@CurrentSession() session: SessionPrincipal, @Param('id') id: string) {
    return this.app.get(session, id);
  }

  @Post('orders/:id/paid')
  @HttpCode(200)
  @RateLimit({ name: 'app:action', limit: 30, windowMs: MINUTE })
  @ApiOperation({
    summary: 'I sent the transfer',
    description: 'For a purchase: the matcher marks it paid for you.',
  })
  @ApiOkResponse({ type: OrderView })
  @ApiErrors(400, 404, 429)
  paid(
    @CurrentSession() session: SessionPrincipal,
    @Param('id') id: string,
    @Body() dto: ReportPaidDto,
  ) {
    return this.app.act(session, id, 'paid', dto);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  @RateLimit({ name: 'app:action', limit: 30, windowMs: MINUTE })
  @ApiOperation({ summary: 'Cancel a purchase before paying' })
  @ApiOkResponse({ type: OrderView })
  @ApiErrors(400, 404, 429)
  cancel(@CurrentSession() session: SessionPrincipal, @Param('id') id: string) {
    return this.app.act(session, id, 'cancel');
  }

  @Post('orders/:id/dispute')
  @HttpCode(200)
  @RateLimit({ name: 'app:action', limit: 30, windowMs: MINUTE })
  @ApiOperation({ summary: 'Dispute a paid purchase the merchant did not release' })
  @ApiOkResponse({ type: OrderView })
  @ApiErrors(400, 404, 429)
  dispute(@CurrentSession() session: SessionPrincipal, @Param('id') id: string) {
    return this.app.act(session, id, 'dispute');
  }

  @Post('orders/:id/transactions')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Build a transaction for your wallet on your order',
    description:
      'Mostly a sale’s `release` once the merchant paid you; also `dispute` and `cancel`.',
  })
  @ApiOkResponse({ type: TransactionView })
  @ApiErrors(400, 404)
  transaction(
    @CurrentSession() session: SessionPrincipal,
    @Param('id') id: string,
    @Body() dto: AppTransactionDto,
  ) {
    return this.app.transaction(session, id, dto);
  }
}

@ApiSchema({ name: 'AdminResolution', description: 'The arbiter’s unsigned resolve transaction.' })
class AdminResolutionView {
  @ApiProperty() orderId!: string;
  @ApiProperty({ description: 'The arbiter the contract names now: the wallet that must sign.' })
  arbiter!: string;
  @ApiProperty({ type: TransactionView }) transaction!: TransactionView;
}

@ApiSchema({ name: 'AdminMerchant' })
class AdminMerchantView {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: TIERS }) tier!: string;
  @ApiProperty() address!: string;
  @ApiPropertyOptional({ nullable: true, type: String }) displayName!: string | null;
  @ApiProperty({ enum: ['ACTIVE', 'PAUSED', 'SUSPENDED'] }) merchantStatus!: string;
}

/** The platform console: platform operators (`ADMIN_ADDRESSES`) only. */
@ApiTags('Admin')
@Controller('v1/admin/p2p')
@AdminAuth()
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('disputes')
  @ApiOperation({ summary: 'Orders waiting for the arbiter', description: 'Oldest first.' })
  @ApiOkResponse({ type: MerchantOrderListView })
  disputes(@Query() query: AdminDisputesQueryDto) {
    return this.admin.disputes(query);
  }

  @Get('orders/:id')
  @ApiOperation({
    summary: 'One order in full',
    description:
      'Both parties’ details (the evidence) and the matcher’s transactions. Every read is audited.',
  })
  @ApiOkResponse({
    type: OrderView,
    description: 'The order, plus `payer`, `beneficiary` and `matcherTransactions`.',
  })
  @ApiErrors(404)
  order(@CurrentSession() session: SessionPrincipal, @Param('id') id: string) {
    return this.admin.order(id, session.address);
  }

  @Post('orders/:id/resolution')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Build the arbiter’s resolve transaction',
    description:
      'Unsigned `resolve(id, toBuyer, bondToSeller)` for the arbiter’s own wallet (a multisig) to sign: this server never holds the arbiter key.',
  })
  @ApiOkResponse({ type: AdminResolutionView })
  @ApiErrors(400, 404)
  resolution(
    @CurrentSession() session: SessionPrincipal,
    @Param('id') id: string,
    @Body() dto: AdminResolutionDto,
  ) {
    return this.admin.resolution(id, dto, session.address);
  }

  @Patch('merchants/:accountId')
  @ApiOperation({
    summary: 'Suspend or reinstate a merchant',
    description: 'SUSPENDED stops it from being matched.',
  })
  @ApiOkResponse({ type: AdminMerchantView })
  @ApiErrors(400, 404)
  merchant(
    @CurrentSession() session: SessionPrincipal,
    @Param('accountId') accountId: string,
    @Body() dto: AdminMerchantDto,
  ) {
    return this.admin.setMerchantStatus(accountId, dto.merchantStatus, session.address);
  }
}
