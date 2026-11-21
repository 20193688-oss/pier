import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeysService } from '@/auth/api-keys.service';
import {
  ORGANIZATION_HEADER,
  ROLE_SCOPES,
  SESSION_COOKIE,
  SESSION_TOKEN_PREFIX,
  TIER_HEADER,
  tierOfApiKey,
  type AuthedRequest,
  type MemberRole,
  type SessionPrincipal,
} from '@/auth/auth.types';
import { AUTH_POLICY, type AuthPolicy } from '@/auth/decorators';
import { SessionsService } from '@/auth/sessions.service';
import { isTier } from '@/chain/networks';
import { ApiError, ErrorCode } from '@/common/api-error';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { PrismaService } from '@/prisma/prisma.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function header(req: AuthedRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The one authentication gate. Each route's policy (`@Public`,
 * `@SessionAuth`, `@OrgAuth(scope)`, `@AdminAuth`) says who may call it; a
 * route with none is refused. API keys reach only organization routes;
 * a cookie-authenticated write must come from an allowed origin (CSRF).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
    private readonly apiKeys: ApiKeysService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<AuthPolicy | undefined>(AUTH_POLICY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!policy) throw ApiError.forbidden('This route declares no access policy.');
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    req.auth = {};
    if (policy.kind === 'public') return true;

    const authorization = header(req, 'authorization');
    const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (authorization && !bearer)
      throw ApiError.unauthorized('Send credentials as `Authorization: Bearer <token>`.');

    if (bearer && tierOfApiKey(bearer)) {
      const org = await this.apiKeys.resolve(bearer);
      if (!org) throw ApiError.unauthorized('This API key is not valid or was revoked.');
      if (policy.kind !== 'org') {
        throw ApiError.forbidden('This route takes a wallet session, not an API key.');
      }
      if (!org.scopes.includes(policy.scope)) {
        throw ApiError.forbidden(`This API key lacks the ${policy.scope} scope.`);
      }
      req.auth.org = org;
      return true;
    }

    if (bearer && !bearer.startsWith(SESSION_TOKEN_PREFIX)) {
      throw ApiError.unauthorized('This token is not an API key or a session token.');
    }
    const cookies = (req as { cookies?: Record<string, string> }).cookies;
    const token = bearer ?? cookies?.[SESSION_COOKIE];
    if (!token) throw ApiError.unauthorized();
    const resolved = await this.sessions.resolve(token);
    if (!resolved) throw ApiError.unauthorized('Your session ended: sign in again.');
    const viaCookie = !bearer;
    if (viaCookie && !SAFE_METHODS.has(req.method)) {
      const origin = header(req, 'origin');
      if (!origin || !this.config.webOrigins.includes(origin)) {
        throw ApiError.forbidden('Cross-site requests with the session cookie are refused.');
      }
    }
    const session: SessionPrincipal = {
      ...resolved,
      viaCookie,
      isAdmin: this.config.adminAddresses.includes(resolved.address),
    };
    req.auth.session = session;

    switch (policy.kind) {
      case 'session':
        return true;
      case 'admin':
        if (!session.isAdmin) throw ApiError.forbidden('This route is for platform operators.');
        return true;
      case 'org':
        break;
    }

    const organizationId = header(req, ORGANIZATION_HEADER);
    if (!organizationId) {
      throw ApiError.badRequest(
        ErrorCode.ValidationFailed,
        'Name the organization to act for in the Pier-Organization header.',
      );
    }
    const tier = header(req, TIER_HEADER) ?? 'test';
    if (!isTier(tier)) {
      throw ApiError.badRequest(ErrorCode.ValidationFailed, 'Pier-Tier must be live or test.');
    }
    const member = await this.prisma.member.findFirst({
      where: { organizationId, address: session.address, organization: { system: false } },
      select: { role: true },
    });
    if (!member) throw ApiError.forbidden('You are not a member of this organization.');
    const role = member.role as MemberRole;
    const scopes = ROLE_SCOPES[role] ?? [];
    if (!scopes.includes(policy.scope)) {
      throw ApiError.forbidden(`Your role (${role}) does not grant ${policy.scope}.`);
    }
    req.auth.org = {
      kind: 'member',
      organizationId,
      tier,
      scopes,
      address: session.address,
      role,
    };
    return true;
  }
}
