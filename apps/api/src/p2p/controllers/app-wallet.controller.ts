import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { OrgPrincipal, SessionPrincipal } from '@/auth/auth.types';
import { CurrentOrg, CurrentSession, OrgAuth, SessionAuth } from '@/auth/decorators';
import { ApiErrors } from '@/common/openapi';
import { RateLimit } from '@/common/rate-limit';
import { AppChargesService } from '@/p2p/app-charges.service';
import { AppOrdersService } from '@/p2p/app-orders.service';
import { AppWalletService } from '@/p2p/app-wallet.service';
import {
  ActivateDto,
  ActivityQueryDto,
  CreateTransferDto,
  NetworkQueryDto,
  PayChargeDto,
  SubmitDto,
  UpdateProfileDto,
} from '@/p2p/dto/app-wallet.dto';
import {
  ActivationView,
  ActivityView,
  AppChargeView,
  BalancesView,
  CreatedChargePaymentView,
  CreatedTransferView,
  HandleView,
  ProfileView,
  SubmissionView,
  TransferView,
} from '@/p2p/entities/app-wallet.entity';
import { tierOf } from '@/p2p/tier';
import { DeploymentsService } from '@/chain/deployments.service';
import { SubmissionsService } from '@/p2p/submissions.service';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The payments app's wallet routes: a signed-in account acting for itself. */
@ApiTags('App')
@Controller('v1/app')
@SessionAuth()
export class AppWalletController {
  constructor(
    private readonly wallet: AppWalletService,
    private readonly charges: AppChargesService,
    private readonly submissions: SubmissionsService,
    private readonly appOrders: AppOrdersService,
  ) {}

  @Get('profile')
  @ApiOperation({ summary: 'Your account and @handle' })
  @ApiOkResponse({ type: ProfileView })
  profile(@CurrentSession() session: SessionPrincipal) {
    return this.wallet.profile(session);
  }

  @Put('profile')
  @RateLimit({ name: 'app:profile', limit: 10, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Claim or change your @handle',
    description:
      'Normalised to lower case; unique; reserved words refused. `409 handle_taken` when someone has it.',
  })
  @ApiOkResponse({ type: ProfileView })
  @ApiErrors(400, 409, 429)
  setProfile(@CurrentSession() session: SessionPrincipal, @Body() dto: UpdateProfileDto) {
    return this.wallet.setHandle(session, dto.handle);
  }

  @Get('handles/:handle')
  @RateLimit({ name: 'app:handle', limit: 60, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Who an @handle is',
    description: 'One handle at a time (there is no listing route). Rate-limited.',
  })
  @ApiOkResponse({ type: HandleView })
  @ApiErrors(404, 429)
  handle(@Param('handle') handle: string) {
    return this.wallet.resolveHandle(handle);
  }

  @Get('balances')
  @RateLimit({ name: 'app:balances', limit: 60, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Your balances',
    description:
      'Whether the account exists, its lumens, and each listed token with its trustline state.',
  })
  @ApiOkResponse({ type: BalancesView })
  @ApiErrors(400, 429, 503)
  balances(@CurrentSession() session: SessionPrincipal, @Query() query: NetworkQueryDto) {
    return this.wallet.balances(session, query.network);
  }

  @Post('activate')
  @HttpCode(200)
  @RateLimit({ name: 'app:activate', limit: 5, windowMs: HOUR })
  @ApiOperation({
    summary: 'Sponsored activation',
    description:
      'Creates the account when it is missing and opens the token’s trustline, the sponsor paying the reserves (CAP-33: begin_sponsoring_future_reserves, create_account with 0 XLM, change_trust, end_sponsoring_future_reserves). `transaction: null` when there is nothing to do. Submit it with `POST /v1/app/submit`, which adds the sponsor’s signature; limited per account and per IP, within the sponsor’s budget.',
  })
  @ApiOkResponse({ type: ActivationView })
  @ApiErrors(400, 429, 503)
  activate(@CurrentSession() session: SessionPrincipal, @Body() dto: ActivateDto) {
    return this.wallet.activate(session, dto);
  }

  @Post('transfers')
  @RateLimit({ name: 'app:transfer', limit: 30, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Send tokens',
    description:
      'To a G, M or C address or an @handle. A G or M recipient gets a classic `payment`, a C recipient a SAC `transfer`; the note becomes a text memo (classic payments only). Refused: a recipient that cannot receive (`recipient_cannot_receive`), yourself, more than your balance (`insufficient_balance`).',
  })
  @ApiCreatedResponse({ type: CreatedTransferView })
  @ApiErrors(400, 404, 429, 503)
  transfer(@CurrentSession() session: SessionPrincipal, @Body() dto: CreateTransferDto) {
    return this.wallet.createTransfer(session, dto);
  }

  @Get('transfers/:id')
  @ApiOperation({ summary: 'One of your transfers (sent or received)' })
  @ApiOkResponse({ type: TransferView })
  @ApiErrors(404)
  getTransfer(@CurrentSession() session: SessionPrincipal, @Param('id') id: string) {
    return this.wallet.getTransfer(session, id);
  }

  @Get('activity')
  @RateLimit({ name: 'app:activity', limit: 60, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Your activity',
    description:
      'Orders and transfers, newest first, paged by `cursor`. Payments that reached you from outside the app appear as transfers with `fromHandle: null`; they are read from the token contracts’ `transfer` events (CAP-67) as far back as the RPC keeps them (about 7 days on SDF’s RPC).',
  })
  @ApiOkResponse({ type: ActivityView })
  @ApiErrors(400, 429, 503)
  activity(@CurrentSession() session: SessionPrincipal, @Query() query: ActivityQueryDto) {
    return this.wallet.activity(session, query);
  }

  @Get('charges/:id')
  @RateLimit({ name: 'app:charge', limit: 60, windowMs: MINUTE })
  @ApiOperation({
    summary: 'A charge, as its payer sees it',
    description:
      'With `payWithBalance`: the token amount the business would receive through the market now (the best quote), held for 60 s.',
  })
  @ApiOkResponse({ type: AppChargeView })
  @ApiErrors(404, 429)
  charge(@CurrentSession() session: SessionPrincipal, @Param('id') id: string) {
    return this.charges.get(session, id);
  }

  @Post('charges/:id/payments')
  @RateLimit({ name: 'app:charge-pay', limit: 10, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Pay a charge from your balance',
    description:
      'A token transfer to the charge’s receiving account, priced now and valid for 60 s. The charge is paid once the submitted transfer succeeds on-chain (`P2P_CHARGE_SUCCEEDED`, `paidWith: TOKEN`).',
  })
  @ApiCreatedResponse({ type: CreatedChargePaymentView })
  @ApiErrors(400, 404, 409, 429, 503)
  pay(
    @CurrentSession() session: SessionPrincipal,
    @Param('id') id: string,
    @Body() dto: PayChargeDto,
  ) {
    return this.charges.pay(session, id, dto);
  }

  @Post('submit')
  @HttpCode(200)
  @RateLimit({ name: 'app:submit', limit: 30, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Submit a signed transaction (gasless)',
    description:
      'The signed inner envelope this API built for your account: checked (network, source = your account, one allowed operation or the sponsored activation, time bounds, fee cap, rate limits, budget), fee-bumped by the sponsor when gasless is on, recorded, broadcast; waits up to about 15 s.',
  })
  @ApiOkResponse({ type: SubmissionView })
  @ApiErrors(400, 429, 503)
  submit(@CurrentSession() session: SessionPrincipal, @Body() dto: SubmitDto, @Req() req: Request) {
    return this.submissions.submit(
      { channel: 'app', tier: this.appOrders.tier(), address: session.address },
      dto,
      req.ip ?? 'unknown',
    );
  }

  @Get('submissions/:hash')
  @ApiOperation({ summary: 'One of your submissions, by its hash' })
  @ApiOkResponse({ type: SubmissionView })
  @ApiErrors(404)
  submission(@CurrentSession() session: SessionPrincipal, @Param('hash') hash: string) {
    return this.submissions.get(
      { channel: 'app', tier: this.appOrders.tier(), address: session.address },
      hash,
    );
  }
}

/** Gasless submission for an organization's accounts. */
@ApiTags('Orders')
@Controller('v1/p2p')
export class SubmitController {
  constructor(
    private readonly submissions: SubmissionsService,
    private readonly deployments: DeploymentsService,
  ) {}

  @Post('submit')
  @OrgAuth('p2p:write')
  @HttpCode(200)
  @RateLimit({ name: 'p2p:submit', limit: 60, windowMs: MINUTE })
  @ApiOperation({
    summary: 'Submit a signed transaction (gasless)',
    description:
      'A transaction this API built for one of your registered accounts (`POST /v1/p2p/transactions`, a sale’s `open_with_deposit`, a transfer match’s `release`), signed: checked as `POST /v1/app/submit` (source = an account of yours on this tier), fee-bumped when gasless is on, recorded, broadcast.',
  })
  @ApiOkResponse({ type: SubmissionView })
  @ApiErrors(400, 429, 503)
  submit(@CurrentOrg() org: OrgPrincipal, @Body() dto: SubmitDto, @Req() req: Request) {
    return this.submissions.submit(
      { channel: 'org', tier: tierOf(org, this.deployments), organizationId: org.organizationId },
      dto,
      req.ip ?? 'unknown',
    );
  }

  @Get('submissions/:hash')
  @OrgAuth('p2p:read')
  @ApiOperation({ summary: 'One of your organization’s submissions, by its hash' })
  @ApiOkResponse({ type: SubmissionView })
  @ApiErrors(400, 404)
  submission(@CurrentOrg() org: OrgPrincipal, @Param('hash') hash: string) {
    return this.submissions.get(
      { channel: 'org', tier: tierOf(org, this.deployments), organizationId: org.organizationId },
      hash,
    );
  }
}
