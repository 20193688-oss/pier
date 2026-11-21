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
import { CreateOrderMessageDto } from '@/p2p/dto/order-message.dto';
import { BuildTransactionDto, TransferMatchesDto } from '@/p2p/dto/transaction.dto';
import { OfferListView, OfferView, QuoteView } from '@/p2p/entities/offer.entity';
import {
  OrderMessageAttachmentView,
  OrderMessageListView,
  OrderMessageView,
} from '@/p2p/entities/order-message.entity';
import {
  CreatedOrderView,
  MerchantOrderListView,
  MerchantOrderView,
  OrderListView,
  OrderView,
  TransferMatchListView,
} from '@/p2p/entities/order.entity';
import { TransactionView } from '@/p2p/entities/transaction.entity';
import { ORDER_CHAT_SEND_PER_MINUTE } from '@/p2p/domain/order-chat';
import { OffersService } from '@/p2p/offers.service';
import { OrderMessagesService } from '@/p2p/order-messages.service';
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
    private readonly chat: OrderMessagesService,
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
      'The person sent the transfer: the matcher marks the order paid for them (they need no gas). Idempotent: once the order shows it, it answers the order as it is.',
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
      'The matcher cancels for the buyer; a payout is cancelled here only before its merchant accepts it. Idempotent: once the order shows it, it answers the order as it is.',
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
    description:
      'The merchant did not release a payment the person made: the arbiter decides. Idempotent: once the order shows it, it answers the order as it is.',
  })
  @ApiOkResponse({ type: OrderView })
  @ApiErrors(400, 404, 429)
  dispute(@CurrentOrg() org: OrgPrincipal, @Param('id') id: string) {
    return this.orders.act(org, id, 'dispute');
  }

  @Get('orders/:id/messages')
  @OrgAuth('p2p:read')
  @ApiOperation({
    summary: 'Your order’s chat with its merchant',
    description:
      'Oldest first, the latest 200. A message with an attachment is a transfer receipt; fetch its file from `…/messages/{messageId}/attachment`.',
  })
  @ApiOkResponse({ type: OrderMessageListView })
  @ApiErrors(400, 404)
  async messages(@CurrentOrg() org: OrgPrincipal, @Param('id') id: string) {
    return this.chat.list(await this.orders.clientOwned(org, id));
  }

  @Post('orders/:id/messages')
  @OrgAuth('p2p:write')
  @RateLimit({ name: 'p2p:message', limit: ORDER_CHAT_SEND_PER_MINUTE, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Write to your order’s merchant',
    description:
      'A text (trimmed, 1 to 1000 characters), an attachment (an image or a PDF of at most 2 MiB, base64, whose leading bytes match its type), or both. The other side’s organization gets a `P2P_ORDER_MESSAGE` event.',
  })
  @ApiCreatedResponse({ type: OrderMessageView })
  @ApiErrors(400, 404, 429)
  async sendMessage(
    @CurrentOrg() org: OrgPrincipal,
    @Param('id') id: string,
    @Body() dto: CreateOrderMessageDto,
  ) {
    const order = await this.orders.clientOwned(org, id);
    return this.chat.send(
      order,
      { from: 'creator', organizationId: org.organizationId, address: org.address ?? null },
      dto,
    );
  }

  @Get('orders/:id/messages/:messageId/attachment')
  @OrgAuth('p2p:read')
  @ApiOperation({
    summary: 'A file sent on your order’s chat',
    description: 'Its bytes in base64.',
  })
  @ApiOkResponse({ type: OrderMessageAttachmentView })
  @ApiErrors(400, 404)
  async attachment(
    @CurrentOrg() org: OrgPrincipal,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ) {
    return this.chat.attachment(await this.orders.clientOwned(org, id), messageId);
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

  @Get('merchant/orders/:id/messages')
  @OrgAuth('p2p:read')
  @ApiOperation({
    summary: 'The chat with the side that created an order you take',
    description:
      'Oldest first, the latest 200. A message with an attachment is a transfer receipt; fetch its file from `…/messages/{messageId}/attachment`.',
  })
  @ApiOkResponse({ type: OrderMessageListView })
  @ApiErrors(400, 404)
  async merchantMessages(@CurrentOrg() org: OrgPrincipal, @Param('id') id: string) {
    return this.chat.list(await this.orders.merchantOwned(org, id));
  }

  @Post('merchant/orders/:id/messages')
  @OrgAuth('p2p:write')
  @RateLimit({ name: 'p2p:message', limit: ORDER_CHAT_SEND_PER_MINUTE, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Write to the side that created an order you take',
    description:
      'A text (trimmed, 1 to 1000 characters), an attachment (an image or a PDF of at most 2 MiB, base64, whose leading bytes match its type), or both. The other side’s organization gets a `P2P_ORDER_MESSAGE` event. Send the transfer receipt here once you paid a sale, a QR payment or a payout.',
  })
  @ApiCreatedResponse({ type: OrderMessageView })
  @ApiErrors(400, 404, 429)
  async merchantSendMessage(
    @CurrentOrg() org: OrgPrincipal,
    @Param('id') id: string,
    @Body() dto: CreateOrderMessageDto,
  ) {
    const order = await this.orders.merchantOwned(org, id);
    return this.chat.send(
      order,
      { from: 'merchant', organizationId: org.organizationId, address: org.address ?? null },
      dto,
    );
  }

  @Get('merchant/orders/:id/messages/:messageId/attachment')
  @OrgAuth('p2p:read')
  @ApiOperation({
    summary: 'A file sent on the chat of an order you take',
    description: 'Its bytes in base64.',
  })
  @ApiOkResponse({ type: OrderMessageAttachmentView })
  @ApiErrors(400, 404)
  async merchantAttachment(
    @CurrentOrg() org: OrgPrincipal,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ) {
    return this.chat.attachment(await this.orders.merchantOwned(org, id), messageId);
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
      'Unsigned calldata for one of your accounts (or a sale’s seller): approve, deposit, withdraw, setOperator, setMatcher, accept, markPaid, release, cancel, dispute. Each is checked against the order or account it names; the contract still decides. An order action the order already shows answers 409 `already_done` (nothing to sign).',
  })
  @ApiOkResponse({ type: TransactionView })
  @ApiErrors(400, 404, 409, 503)
  build(@CurrentOrg() org: OrgPrincipal, @Body() dto: BuildTransactionDto) {
    return this.transactions.build(org, dto);
  }
}
