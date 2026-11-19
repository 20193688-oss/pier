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
import { RateLimit } from '@/common/rate-limit';
import { CreateOfferDto, QueryOffersDto, UpdateOfferDto } from '@/p2p/dto/offer.dto';
import { CreateOrderDto, CreateQuoteDto, QueryOrdersDto, ReportPaidDto } from '@/p2p/dto/order.dto';
import { BuildTransactionDto, TransferMatchesDto } from '@/p2p/dto/transaction.dto';
import { OfferListView, OfferView, QuoteView } from '@/p2p/entities/offer.entity';
import {
  CreatedOrderView,
  MerchantOrderListView,
  MerchantOrderView,
  OrderListView,
  OrderView,
  TransferMatchListView,
} from '@/p2p/entities/order.entity';
import { TransactionView } from '@/p2p/entities/transaction.entity';
import { OffersService } from '@/p2p/offers.service';
import { OrdersService } from '@/p2p/orders.service';
import { QuotesService } from '@/p2p/quotes.service';
import { TransactionsService } from '@/p2p/transactions.service';
import { TransferMatchesService } from '@/p2p/transfer-matches.service';

const MINUTE = 60_000;

@ApiTags('Offers')
@Controller('v1/p2p/offers')
export class OffersController {
  constructor(private readonly offers: OffersService) {}

  @Post()
  @OrgAuth('p2p:write')
  @ApiOperation({
    summary: 'Publish an offer',
    description:
      'A merchant’s standing price and limits on one network, token, currency and rails. SELL_TOKEN: you sell tokens (people buy); BUY_TOKEN: you buy them. A price older than `priceTtlSeconds` is not matched: bots refresh it.',
  })
  @ApiCreatedResponse({ type: OfferView })
  @ApiErrors(400, 404)
  create(@CurrentOrg() org: OrgPrincipal, @Body() dto: CreateOfferDto) {
    return this.offers.create(org, dto);
  }

  @Get()
  @OrgAuth('p2p:read')
  @ApiOperation({ summary: 'Your offers on this tier' })
  @ApiOkResponse({ type: OfferListView })
  @ApiErrors(400)
  list(@CurrentOrg() org: OrgPrincipal, @Query() query: QueryOffersDto) {
    return this.offers.list(org, query);
  }

  @Patch(':id')
  @OrgAuth('p2p:write')
  @ApiOperation({
    summary: 'Update an offer',
    description: 'A new `price` also refreshes its timestamp: this is what a price bot calls.',
  })
  @ApiOkResponse({ type: OfferView })
  @ApiErrors(400, 404)
  update(@CurrentOrg() org: OrgPrincipal, @Param('id') id: string, @Body() dto: UpdateOfferDto) {
    return this.offers.update(org, id, dto);
  }

  @Delete(':id')
  @OrgAuth('p2p:write')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an offer' })
  @ApiNoContentResponse()
  @ApiErrors(400, 404)
  remove(@CurrentOrg() org: OrgPrincipal, @Param('id') id: string): Promise<void> {
    return this.offers.remove(org, id);
  }
}

@ApiTags('Orders')
@Controller('v1/p2p')
export class OrdersController {
  constructor(
    private readonly quotes: QuotesService,
    private readonly orders: OrdersService,
    private readonly transactions: TransactionsService,
    private readonly matches: TransferMatchesService,
  ) {}

  @Post('quotes')
  @OrgAuth('p2p:write')
  @RateLimit({ name: 'p2p:quote', limit: 60, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Quote a trade',
    description:
      'Prices a trade and picks the merchant (the person never picks one): the best price for the person among merchants that can fill it right now. Held for 60 seconds. `409 no_match` when nobody can.',
  })
  @ApiCreatedResponse({ type: QuoteView })
  @ApiErrors(400, 404, 409, 429, 503)
  quote(@CurrentOrg() org: OrgPrincipal, @Body() dto: CreateQuoteDto) {
    return this.quotes.create(org, dto);
  }

  @Post('orders')
  @OrgAuth('p2p:write')
  @RateLimit({ name: 'p2p:order', limit: 30, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Create an order from a quote',
    description:
      'BUY: the matcher opens it on the merchant’s balance; the answer carries the merchant’s payment details and the deadline. SELL: the answer carries the two transactions the seller’s wallet signs (`approve`, then `openWithDeposit`). One order per quote; a retry with the same wallet answers the same order.',
  })
  @ApiCreatedResponse({ type: CreatedOrderView })
  @ApiErrors(400, 404, 409, 429, 503)
  create(@CurrentOrg() org: OrgPrincipal, @Body() dto: CreateOrderDto) {
    return this.orders.create(org, dto);
  }

  @Get('orders')
  @OrgAuth('p2p:read')
  @ApiOperation({ summary: 'Orders you created on this tier' })
  @ApiOkResponse({ type: OrderListView })
  @ApiErrors(400)
  list(@CurrentOrg() org: OrgPrincipal, @Query() query: QueryOrdersDto) {
    return this.orders.list(org, query);
  }

  @Get('orders/:id')
  @OrgAuth('p2p:read')
  @ApiOperation({
    summary: 'One order you created',
    description: 'A live purchase also carries the merchant’s payment details.',
  })
  @ApiOkResponse({ type: OrderView })
  @ApiErrors(400, 404)
  get(@CurrentOrg() org: OrgPrincipal, @Param('id') id: string) {
    return this.orders.get(org, id);
  }

  @Post('orders/:id/paid')
  @OrgAuth('p2p:write')
  @HttpCode(200)
  @RateLimit({ name: 'p2p:order-action', limit: 60, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Report a purchase paid',
    description:
      'The person sent the transfer: the matcher marks the order paid for them (they need no gas).',
  })
  @ApiOkResponse({ type: OrderView })
  @ApiErrors(400, 404, 429)
  paid(@CurrentOrg() org: OrgPrincipal, @Param('id') id: string, @Body() dto: ReportPaidDto) {
    return this.orders.act(org, id, 'paid', dto);
  }

  @Post('orders/:id/cancel')
  @OrgAuth('p2p:write')
  @HttpCode(200)
  @RateLimit({ name: 'p2p:order-action', limit: 60, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Cancel a purchase before paying',
    description:
      'The matcher cancels for the buyer; a payout is cancelled here only before its merchant accepts it.',
  })
  @ApiOkResponse({ type: OrderView })
  @ApiErrors(400, 404, 429)
  cancel(@CurrentOrg() org: OrgPrincipal, @Param('id') id: string) {
    return this.orders.act(org, id, 'cancel');
  }

  @Post('orders/:id/dispute')
  @OrgAuth('p2p:write')
  @HttpCode(200)
  @RateLimit({ name: 'p2p:order-action', limit: 60, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Dispute a paid purchase',
    description: 'The merchant did not release a payment the person made: the arbiter decides.',
  })
  @ApiOkResponse({ type: OrderView })
  @ApiErrors(400, 404, 429)
  dispute(@CurrentOrg() org: OrgPrincipal, @Param('id') id: string) {
    return this.orders.act(org, id, 'dispute');
  }

  @Get('merchant/orders')
  @OrgAuth('p2p:read')
  @ApiOperation({
    summary: 'Orders your merchant accounts take part in',
    description:
      'The payer’s identity (purchases) or the beneficiary’s account (sales, payouts) while the order is live.',
  })
  @ApiOkResponse({ type: MerchantOrderListView })
  @ApiErrors(400)
  merchantList(@CurrentOrg() org: OrgPrincipal, @Query() query: QueryOrdersDto) {
    return this.orders.merchantList(org, query);
  }

  @Get('merchant/orders/:id')
  @OrgAuth('p2p:read')
  @ApiOperation({ summary: 'One order your merchant account takes part in' })
  @ApiOkResponse({ type: MerchantOrderView })
  @ApiErrors(400, 404)
  merchantGet(@CurrentOrg() org: OrgPrincipal, @Param('id') id: string) {
    return this.orders.merchantGet(org, id);
  }

  @Post('merchant/transfer-matches')
  @OrgAuth('p2p:read')
  @HttpCode(200)
  @RateLimit({ name: 'p2p:transfer-matches', limit: 120, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Match an incoming bank transfer to your orders',
    description:
      'Your bot forwards a bank notification; the answer lists the live purchases and charges it most likely settles (exact amount and currency, scored on the payer’s name and document), each with its `release` transaction ready to sign. It moves nothing.',
  })
  @ApiOkResponse({ type: TransferMatchListView })
  @ApiErrors(400, 429)
  transferMatches(@CurrentOrg() org: OrgPrincipal, @Body() dto: TransferMatchesDto) {
    return this.matches.match(org, dto);
  }

  @Post('transactions')
  @OrgAuth('p2p:read')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Build a transaction for your wallet',
    description:
      'Unsigned calldata for one of your accounts (or a sale’s seller): approve, deposit, withdraw, setOperator, setMatcher, accept, markPaid, release, cancel, dispute. Each is checked against the order or account it names; the contract still decides.',
  })
  @ApiOkResponse({ type: TransactionView })
  @ApiErrors(400, 404, 503)
  build(@CurrentOrg() org: OrgPrincipal, @Body() dto: BuildTransactionDto) {
    return this.transactions.build(org, dto);
  }
}
