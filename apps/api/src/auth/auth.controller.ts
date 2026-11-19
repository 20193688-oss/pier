import { Body, Controller, Get, HttpCode, Inject, Post, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiSchema,
  ApiTags,
  ApiNoContentResponse,
} from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { SESSION_COOKIE, type SessionPrincipal } from '@/auth/auth.types';
import { CurrentSession, Public, SessionAuth } from '@/auth/decorators';
import { SessionsService } from '@/auth/sessions.service';
import { ApiErrors } from '@/common/openapi';
import { RateLimit } from '@/common/rate-limit';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { PrismaService } from '@/prisma/prisma.service';

@ApiSchema({ name: 'SiweNonce', description: 'A single-use nonce for a SIWE message.' })
class NonceView {
  @ApiProperty({ example: '9f2c4e1ab37d5c08e6a1b2c3d4e5f607' })
  nonce!: string;
  @ApiProperty()
  expiresAt!: Date;
  @ApiProperty({
    example: 'localhost:3000',
    description: 'The `domain` the SIWE message must name (and its URI host).',
  })
  domain!: string;
}

@ApiSchema({ name: 'SignIn', description: 'A signed EIP-4361 message.' })
class SignInDto {
  @ApiProperty({ description: 'The SIWE message, byte for byte as signed.' })
  @IsString()
  @MaxLength(4000)
  message!: string;

  @ApiProperty({ example: `0x${'1b'.repeat(65)}`, description: '`personal_sign` of the message.' })
  @IsString()
  @MaxLength(400)
  signature!: string;
}

@ApiSchema({ name: 'SessionToken', description: 'A new session.' })
class SessionTokenView {
  @ApiProperty({
    example: 'ps_sess_x2...',
    description:
      'Shown once. Browsers use the HttpOnly cookie set with it; other clients send it as `Authorization: Bearer`.',
  })
  token!: string;
  @ApiProperty({ example: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' })
  address!: string;
  @ApiProperty()
  expiresAt!: Date;
}

@ApiSchema({ name: 'SessionMembership' })
class MembershipView {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['owner', 'admin', 'member'] }) role!: string;
}

@ApiSchema({ name: 'Session', description: 'The signed-in wallet.' })
class SessionView {
  @ApiProperty() address!: string;
  @ApiProperty() expiresAt!: Date;
  @ApiProperty({ description: 'Whether the wallet may use `/v1/admin/*`.' }) isAdmin!: boolean;
  @ApiProperty({ type: [MembershipView] }) organizations!: MembershipView[];
}

/** Sign-in with Ethereum: nonce, verify, the session, sign-out. */
@ApiTags('Auth')
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('nonce')
  @Public()
  @HttpCode(200)
  @RateLimit({ name: 'auth:nonce', limit: 30, windowMs: 60_000, per: 'ip' })
  @ApiOperation({
    summary: 'Get a sign-in nonce',
    description: 'A single-use nonce, valid for minutes, to put in an EIP-4361 (SIWE) message.',
  })
  @ApiOkResponse({ type: NonceView })
  @ApiErrors(429)
  nonce(): Promise<NonceView> {
    return this.sessions.issueNonce();
  }

  @Post('verify')
  @Public()
  @HttpCode(200)
  @RateLimit({ name: 'auth:verify', limit: 20, windowMs: 60_000, per: 'ip' })
  @ApiOperation({
    summary: 'Sign in with a signed SIWE message',
    description:
      'Verifies the message (domain, URI, nonce, times) and the wallet signature, spends the nonce and opens a session: an HttpOnly cookie, and the token in the body for non-browser clients.',
  })
  @ApiOkResponse({ type: SessionTokenView })
  @ApiErrors(400, 429)
  async verify(
    @Body() dto: SignInDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionTokenView> {
    const session = await this.sessions.signIn(dto.message, dto.signature);
    res.cookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
    });
    return session;
  }

  @Get('session')
  @SessionAuth()
  @ApiOperation({
    summary: 'The signed-in wallet',
    description: 'Its address, its organizations and roles, and whether it is a platform operator.',
  })
  @ApiOkResponse({ type: SessionView })
  async session(@CurrentSession() session: SessionPrincipal): Promise<SessionView> {
    const memberships = await this.prisma.member.findMany({
      where: { address: session.address, organization: { system: false } },
      orderBy: { createdAt: 'asc' },
      select: { role: true, organization: { select: { id: true, name: true } } },
    });
    return {
      address: session.address,
      expiresAt: session.expiresAt,
      isAdmin: session.isAdmin,
      organizations: memberships.map((m) => ({ ...m.organization, role: m.role })),
    };
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
