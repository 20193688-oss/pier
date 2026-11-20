import { Body, Controller, Get, Header, HttpCode, Inject, Post, Query, Res } from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiProperty,
  ApiSchema,
  ApiTags,
} from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { SESSION_COOKIE, type SessionPrincipal } from '@/auth/auth.types';
import { CurrentSession, Public, SessionAuth } from '@/auth/decorators';
import { SessionsService } from '@/auth/sessions.service';
import { DeploymentsService } from '@/chain/deployments.service';
import { NETWORKS } from '@/chain/networks';
import { ApiErrors } from '@/common/openapi';
import { RateLimit } from '@/common/rate-limit';
import { ACCOUNT_ADDRESS_RE } from '@/common/stellar';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { PrismaService } from '@/prisma/prisma.service';

class ChallengeQueryDto {
  @ApiProperty({
    example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI',
    description: 'The account (G...) that signs in.',
  })
  @Matches(ACCOUNT_ADDRESS_RE, { message: 'account must be a Stellar account address (G...)' })
  account!: string;
}

@ApiSchema({
  name: 'AuthChallenge',
  description:
    'A SEP-10 challenge: a transaction the account signs (it is never submitted). The SEP-10 response shape.',
})
export class AuthChallengeView {
  @ApiProperty({ description: 'The challenge transaction envelope, base64 XDR.' })
  transaction!: string;

  @ApiProperty({
    example: 'Test SDF Network ; September 2015',
    description: 'The network passphrase the challenge is signed for.',
  })
  network_passphrase!: string;
}

@ApiSchema({ name: 'SignIn', description: 'A signed SEP-10 challenge.' })
class SignInDto {
  @ApiProperty({
    description: 'The challenge transaction, signed by the account’s signers, base64 XDR.',
  })
  @IsString()
  @MaxLength(8000)
  transaction!: string;
}

@ApiSchema({ name: 'SessionMembership' })
class MembershipView {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['owner', 'admin', 'member'] }) role!: string;
}

@ApiSchema({ name: 'Session', description: 'The signed-in account.' })
class SessionView {
  @ApiProperty({ example: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI' })
  address!: string;
  @ApiProperty() expiresAt!: Date;
  @ApiProperty({ description: 'Whether the account may use `/v1/admin/*`.' }) isAdmin!: boolean;
  @ApiProperty({ type: [MembershipView] }) organizations!: MembershipView[];
}

@ApiSchema({ name: 'SessionToken', description: 'A new session.' })
class SessionTokenView {
  @ApiProperty({
    example: 'ps_sess_x2...',
    description:
      'Shown once (SEP-10’s `token`). Browsers use the HttpOnly cookie set with it; other clients send it as `Authorization: Bearer`.',
  })
  token!: string;

  @ApiProperty({ type: SessionView })
  session!: SessionView;
}

/** Sign-in with SEP-10: challenge, verify, the session, sign-out. */
@ApiTags('Auth')
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('challenge')
  @Public()
  @RateLimit({ name: 'auth:challenge', limit: 30, windowMs: 60_000, per: 'ip' })
  @ApiOperation({
    summary: 'Get a sign-in challenge',
    description:
      'A SEP-10 challenge for the account: signed by this service’s SEP-10 key, with a single-use nonce, the `web_auth_domain` entry and 5-minute time bounds.',
  })
  @ApiOkResponse({ type: AuthChallengeView })
  @ApiErrors(400, 429, 503)
  async challenge(@Query() query: ChallengeQueryDto): Promise<AuthChallengeView> {
    const { transaction, network_passphrase } = await this.sessions.challenge(query.account);
    return { transaction, network_passphrase };
  }

  @Post('verify')
  @Public()
  @HttpCode(200)
  @RateLimit({ name: 'auth:verify', limit: 20, windowMs: 60_000, per: 'ip' })
  @ApiOperation({
    summary: 'Sign in with a signed challenge',
    description:
      'Verifies the challenge (server signature, time bounds, domains, nonce) and the account’s signatures (its medium threshold, or the master key of an account not created yet), spends the nonce and opens a session: an HttpOnly cookie, and the token in the body for other clients.',
  })
  @ApiOkResponse({ type: SessionTokenView })
  @ApiErrors(400, 429, 503)
  async verify(
    @Body() dto: SignInDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionTokenView> {
    return this.open(dto.transaction, res);
  }

  @Get('sep10')
  @Public()
  @RateLimit({ name: 'auth:challenge', limit: 30, windowMs: 60_000, per: 'ip' })
  @ApiOperation({
    summary: 'SEP-10 endpoint: get a challenge',
    description:
      'The `WEB_AUTH_ENDPOINT` of `/.well-known/stellar.toml`, for SEP-10 clients: the same as `GET /v1/auth/challenge`.',
  })
  @ApiOkResponse({ type: AuthChallengeView })
  @ApiErrors(400, 429, 503)
  sep10Challenge(@Query() query: ChallengeQueryDto): Promise<AuthChallengeView> {
    return this.challenge(query);
  }

  @Post('sep10')
  @Public()
  @HttpCode(200)
  @RateLimit({ name: 'auth:verify', limit: 20, windowMs: 60_000, per: 'ip' })
  @ApiOperation({
    summary: 'SEP-10 endpoint: verify a signed challenge',
    description:
      'The `WEB_AUTH_ENDPOINT` of `/.well-known/stellar.toml`, for SEP-10 clients: the same as `POST /v1/auth/verify`.',
  })
  @ApiOkResponse({ type: SessionTokenView })
  @ApiErrors(400, 429, 503)
  sep10Verify(
    @Body() dto: SignInDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionTokenView> {
    return this.open(dto.transaction, res);
  }

  private async open(transaction: string, res: Response): Promise<SessionTokenView> {
    const signed = await this.sessions.signIn(transaction);
    res.cookie(SESSION_COOKIE, signed.token, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      expires: signed.expiresAt,
    });
    return {
      token: signed.token,
      session: await this.view(
        signed.address,
        signed.expiresAt,
        this.config.adminAddresses.includes(signed.address),
      ),
    };
  }

  private async view(address: string, expiresAt: Date, isAdmin: boolean): Promise<SessionView> {
    const memberships = await this.prisma.member.findMany({
      where: { address, organization: { system: false } },
      orderBy: { createdAt: 'asc' },
      select: { role: true, organization: { select: { id: true, name: true } } },
    });
    return {
      address,
      expiresAt,
      isAdmin,
      organizations: memberships.map((m) => ({ ...m.organization, role: m.role })),
    };
  }

  @Get('session')
  @SessionAuth()
  @ApiOperation({
    summary: 'The signed-in account',
    description: 'Its address, its organizations and roles, and whether it is a platform operator.',
  })
  @ApiOkResponse({ type: SessionView })
  session(@CurrentSession() session: SessionPrincipal): Promise<SessionView> {
    return this.view(session.address, session.expiresAt, session.isAdmin);
  }

  @Post('logout')
  @SessionAuth()
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out', description: 'Ends this session and clears its cookie.' })
  @ApiNoContentResponse()
  async logout(
    @CurrentSession() session: SessionPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.revoke(session.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }
}

/** The SEP-1 file wallets read to find the SEP-10 endpoint and key. */
@ApiTags('Auth')
@Controller('.well-known')
export class WellKnownController {
  constructor(
    private readonly deployments: DeploymentsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('stellar.toml')
  @Public()
  @Header('content-type', 'text/plain; charset=utf-8')
  @Header('access-control-allow-origin', '*')
  @RateLimit({ name: 'stellar-toml', limit: 120, windowMs: 60_000, per: 'ip' })
  @ApiOperation({
    summary: 'stellar.toml (SEP-1)',
    description:
      'Names the SEP-10 endpoint (`WEB_AUTH_ENDPOINT`), the key that signs challenges (`SIGNING_KEY`) and the network (`NETWORK_PASSPHRASE`). Served at the web host, which proxies `/.well-known` here.',
  })
  @ApiProduces('text/plain')
  @ApiOkResponse({ schema: { type: 'string' } })
  stellarToml(): string {
    const { homeDomain, network } = this.config.sep10;
    const origin =
      this.config.webOrigins.find((o) => URL.canParse(o) && new URL(o).host === homeDomain) ??
      `https://${homeDomain}`;
    const key = this.deployments.sep10Address();
    const lines = [
      `# ${this.config.brandName}`,
      `NETWORK_PASSPHRASE = ${JSON.stringify(NETWORKS[network].passphrase)}`,
      `WEB_AUTH_ENDPOINT = ${JSON.stringify(`${origin}/v1/auth/sep10`)}`,
      ...(key ? [`SIGNING_KEY = ${JSON.stringify(key)}`] : []),
    ];
    return `${lines.join('\n')}\n`;
  }
}
