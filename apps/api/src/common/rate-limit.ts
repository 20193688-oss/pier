import {
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { AuthedRequest } from '@/auth/auth.types';
import { ApiError } from '@/common/api-error';

/**
 * A fixed-window limit on one route: `limit` requests per `windowMs`, counted
 * per caller (its organization and tier, else its wallet, else its address)
 * or per client address (`per: 'ip'`). In memory: one replica's view; behind
 * several replicas each counts its own share.
 */
export interface RateLimitPolicy {
  name: string;
  limit: number;
  windowMs: number;
  per?: 'caller' | 'ip';
}

export const RATE_LIMIT = 'pedospe:rate-limit';
export const RateLimit = (policy: RateLimitPolicy) => SetMetadata(RATE_LIMIT, policy);

@Injectable()
export class RateLimiter implements OnModuleDestroy {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly sweeper = setInterval(() => this.sweep(), 60_000);

  constructor() {
    this.sweeper.unref();
  }

  /** Counts one hit; answers the seconds to wait when the limit is spent. */
  hit(key: string, limit: number, windowMs: number): number | null {
    const now = Date.now();
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return null;
    }
    current.count += 1;
    if (current.count <= limit) return null;
    return Math.max(1, Math.ceil((current.resetAt - now) / 1000));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const policy = this.reflector.get<RateLimitPolicy | undefined>(RATE_LIMIT, ctx.getHandler());
    if (!policy) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const auth = req.auth;
    const caller =
      policy.per === 'ip'
        ? undefined
        : auth?.org
          ? `org:${auth.org.organizationId}:${auth.org.tier}`
          : auth?.session
            ? `wallet:${auth.session.address}`
            : undefined;
    const key = `${policy.name}:${caller ?? `ip:${req.ip ?? 'unknown'}`}`;
    const wait = this.limiter.hit(key, policy.limit, policy.windowMs);
    if (wait === null) return true;
    ctx.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(wait));
    throw ApiError.rateLimited(wait);
  }
}
