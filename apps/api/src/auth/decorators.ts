import {
  applyDecorators,
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiHeader } from '@nestjs/swagger';
import { ApiError } from '@/common/api-error';
import { ApiErrors } from '@/common/openapi';
import type { AuthedRequest, OrgPrincipal, Scope, SessionPrincipal } from '@/auth/auth.types';

/**
 * Every route declares who may call it; the global `AuthGuard` refuses a
 * route that declares nothing (a forgotten decorator is a 403, never an open
 * route).
 */
export type AuthPolicy =
  { kind: 'public' } | { kind: 'session' } | { kind: 'org'; scope: Scope } | { kind: 'admin' };

export const AUTH_POLICY = 'pier:auth-policy';

/** No credentials: the market overview, sign-in, and the hosted charge's payer routes. */
export const Public = () => SetMetadata(AUTH_POLICY, { kind: 'public' } satisfies AuthPolicy);

/** A signed-in wallet (SIWE session: cookie or `Bearer ps_sess_...`). */
export const SessionAuth = () =>
  applyDecorators(
    SetMetadata(AUTH_POLICY, { kind: 'session' } satisfies AuthPolicy),
    ApiCookieAuth('session'),
    ApiBearerAuth('bearer'),
    ApiErrors(401, 403),
  );

/**
 * An organization on one tier, with `scope`: an API key (`Bearer pk_live_...`
 * / `pk_test_...`, the key's tier) or a member's wallet session naming the
 * organization and tier in headers.
 */
export const OrgAuth = (scope: Scope) =>
  applyDecorators(
    SetMetadata(AUTH_POLICY, { kind: 'org', scope } satisfies AuthPolicy),
    ApiBearerAuth('bearer'),
    ApiCookieAuth('session'),
    ApiHeader({
      name: 'Pier-Organization',
      required: false,
      description: 'Wallet sessions only: the organization to act for (API keys carry theirs).',
    }),
    ApiHeader({
      name: 'Pier-Tier',
      required: false,
      enum: ['live', 'test'],
      description: 'Wallet sessions only: the tier to act on (default `test`).',
    }),
    ApiErrors(401, 403),
  );

/** A platform operator: a wallet session whose address is in `ADMIN_ADDRESSES`. */
export const AdminAuth = () =>
  applyDecorators(
    SetMetadata(AUTH_POLICY, { kind: 'admin' } satisfies AuthPolicy),
    ApiCookieAuth('session'),
    ApiBearerAuth('bearer'),
    ApiErrors(401, 403),
  );

export const CurrentSession = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): SessionPrincipal => {
    const session = ctx.switchToHttp().getRequest<AuthedRequest>().auth?.session;
    if (!session) throw ApiError.unauthorized();
    return session;
  },
);

export const CurrentOrg = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): OrgPrincipal => {
    const org = ctx.switchToHttp().getRequest<AuthedRequest>().auth?.org;
    if (!org) throw ApiError.unauthorized();
    return org;
  },
);
