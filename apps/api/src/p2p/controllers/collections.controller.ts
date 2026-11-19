import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { OrgPrincipal } from '@/auth/auth.types';
import { CurrentOrg, OrgAuth, Public } from '@/auth/decorators';
import { ApiErrors } from '@/common/openapi';
import { RateLimit } from '@/common/rate-limit';
import { ChargesService } from '@/p2p/charges.service';
import { CheckoutService } from '@/p2p/checkout.service';
import {
  CreateChargeDto,
  CreateCheckoutOrderDto,
  CreatePayoutDto,
  QueryChargesDto,
  QueryPayoutsDto,
} from '@/p2p/dto/charge.dto';
import { ReportPaidDto } from '@/p2p/dto/order.dto';
import {
  ChargeListView,
  ChargeView,
  CheckoutChargeView,
  CheckoutCreatedOrderView,
  CheckoutOrderView,
  PayoutBatchListView,
  PayoutBatchView,
} from '@/p2p/entities/charge.entity';
import { PayoutsService } from '@/p2p/payouts.service';

const MINUTE = 60_000;
const PAYER_TOKEN_HEADER = 'x-payer-token';

@ApiTags('Charges')
@Controller('v1/p2p/charges')
export class ChargesController {
  constructor(private readonly charges: ChargesService) {}

  @Post()
  @OrgAuth('p2p:write')
  @ApiOperation({
    summary: 'Create a charge',
    description:
      'An amount of local money your customer pays on the hosted page; it arrives as tokens in one of your registered wallets. Share `url`.',
  })
  @ApiCreatedResponse({ type: ChargeView })
  @ApiErrors(400, 404, 503)
  create(@CurrentOrg() org: OrgPrincipal, @Body() dto: CreateChargeDto) {
    return this.charges.create(org, dto);
  }

  @Get()
  @OrgAuth('p2p:read')
  @ApiOperation({ summary: 'Your charges on this tier' })
  @ApiOkResponse({ type: ChargeListView })
  @ApiErrors(400)
  list(@CurrentOrg() org: OrgPrincipal, @Query() query: QueryChargesDto) {
    return this.charges.list(org, query);
  }

  @Get(':id')
  @OrgAuth('p2p:read')
  @ApiOperation({ summary: 'One charge' })
  @ApiOkResponse({ type: ChargeView })
  @ApiErrors(400, 404)
  get(@CurrentOrg() org: OrgPrincipal, @Param('id') id: string) {
    return this.charges.get(org, id);
  }

  @Delete(':id')
  @OrgAuth('p2p:write')
  @ApiOperation({
    summary: 'Cancel a charge',
    description: 'Stops new payments; an order already under way goes on.',
  })
  @ApiOkResponse({ type: ChargeView })
  @ApiErrors(400, 404, 409)
  cancel(@CurrentOrg() org: OrgPrincipal, @Param('id') id: string) {
    return this.charges.cancel(org, id);
  }
}

@ApiTags('Payouts')
@Controller('v1/p2p/payouts')
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Post()
  @OrgAuth('p2p:write')
  @RateLimit({ name: 'p2p:payout', limit: 5, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Send a payout batch',
    description:
      'Up to 100 payments in local money from your balance in the contract (deposit and `setMatcher` first). Each item is matched with a merchant that buys tokens and opened by the matcher; an item nobody can take is listed in `failedItems`.',
  })
  @ApiCreatedResponse({ type: PayoutBatchView })
  @ApiErrors(400, 404, 429, 503)
  create(@CurrentOrg() org: OrgPrincipal, @Body() dto: CreatePayoutDto) {
    return this.payouts.create(org, dto);
  }

  @Get()
  @OrgAuth('p2p:read')
  @ApiOperation({ summary: 'Your payout batches on this tier' })
  @ApiOkResponse({ type: PayoutBatchListView })
  @ApiErrors(400)
  list(@CurrentOrg() org: OrgPrincipal, @Query() query: QueryPayoutsDto) {
    return this.payouts.list(org, query);
  }

  @Get(':id')
  @OrgAuth('p2p:read')
  @ApiOperation({ summary: 'One payout batch, with its orders' })
  @ApiOkResponse({ type: PayoutBatchView })
  @ApiErrors(400, 404)
  get(@CurrentOrg() org: OrgPrincipal, @Param('id') id: string) {
    return this.payouts.get(org, id);
  }
}

/**
 * The payer's half of a charge, with no API key: the hosted page calls these.
 * Reading and starting a payment take the charge id; reading and reporting an
 * order take its payer token (`X-Payer-Token`, handed out once).
 */
@ApiTags('Checkout')
@Controller('v1/p2p-checkout')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  private noStore(res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
  }

  @Get('charges/:id')
  @Public()
  @RateLimit({ name: 'p2p-checkout:read', limit: 60, windowMs: MINUTE, per: 'ip' })
  @ApiOperation({
    summary: 'Read a charge to pay it',
    description:
      'What the payer page shows: amount, payee name, description, status and the rails merchants offer now.',
  })
  @ApiOkResponse({ type: CheckoutChargeView })
  @ApiErrors(404, 429)
  getCharge(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    this.noStore(res);
    return this.checkout.getCharge(id);
  }

  @Post('charges/:id/orders')
  @Public()
  @RateLimit({ name: 'p2p-checkout:order', limit: 5, windowMs: 10 * MINUTE, per: 'ip' })
  @ApiOperation({
    summary: 'Start paying a charge',
    description:
      'Opens a purchase of the charge’s exact amount on the payer’s rail. Answers the merchant’s account, the deadline and `payerToken` (shown once). One live order per charge unless it is multi-use, one per client, and a creation budget per charge (`429` with `Retry-After`).',
  })
  @ApiCreatedResponse({ type: CheckoutCreatedOrderView })
  @ApiErrors(400, 404, 409, 429, 503)
  createOrder(
    @Param('id') id: string,
    @Body() dto: CreateCheckoutOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.noStore(res);
    return this.checkout.createOrder(id, dto, req.ip ?? 'unknown');
  }

  @Get('orders/:id')
  @Public()
  @RateLimit({ name: 'p2p-checkout:read', limit: 60, windowMs: MINUTE, per: 'ip' })
  @ApiHeader({
    name: 'X-Payer-Token',
    required: true,
    description: 'The token the order was created with.',
  })
  @ApiOperation({
    summary: 'Read your payment',
    description: 'Its status, the merchant’s account and the deadline.',
  })
  @ApiOkResponse({ type: CheckoutOrderView })
  @ApiErrors(404, 429)
  getOrder(
    @Param('id') id: string,
    @Headers(PAYER_TOKEN_HEADER) token: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.noStore(res);
    return this.checkout.getOrder(id, token);
  }

  @Post('orders/:id/paid')
  @Public()
  @HttpCode(200)
  @RateLimit({ name: 'p2p-checkout:action', limit: 10, windowMs: 10 * MINUTE, per: 'ip' })
  @ApiHeader({ name: 'X-Payer-Token', required: true })
  @ApiOperation({
    summary: 'Report that you sent the transfer',
    description: 'The matcher marks the order paid for you.',
  })
  @ApiOkResponse({ type: CheckoutOrderView })
  @ApiErrors(400, 404, 429)
  paid(
    @Param('id') id: string,
    @Headers(PAYER_TOKEN_HEADER) token: string | undefined,
    @Body() dto: ReportPaidDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.noStore(res);
    return this.checkout.reportPaid(id, token, dto);
  }

  @Post('orders/:id/cancel')
  @Public()
  @HttpCode(200)
  @RateLimit({ name: 'p2p-checkout:action', limit: 10, windowMs: 10 * MINUTE, per: 'ip' })
  @ApiHeader({ name: 'X-Payer-Token', required: true })
  @ApiOperation({
    summary: 'Give up before paying',
    description: 'Frees the charge for another attempt.',
  })
  @ApiOkResponse({ type: CheckoutOrderView })
  @ApiErrors(400, 404, 429)
  cancel(
    @Param('id') id: string,
    @Headers(PAYER_TOKEN_HEADER) token: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.noStore(res);
    return this.checkout.cancel(id, token);
  }
}
