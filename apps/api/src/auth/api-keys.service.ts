import { Injectable } from '@nestjs/common';
import {
  API_KEY_PREFIXES,
  newSecret,
  sha256Hex,
  tierOfApiKey,
  type OrgPrincipal,
  type Scope,
} from '@/auth/auth.types';
import { ApiError } from '@/common/api-error';
import type { Tier } from '@/chain/networks';
import { PrismaService } from '@/prisma/prisma.service';

/** Characters of a key kept for display (`pk_test_` and four more). */
const DISPLAY_PREFIX_LENGTH = 12;
/** A key's `lastUsedAt` is written at most this often. */
const TOUCH_EVERY_MS = 60 * 1000;

export interface ApiKeyRow {
  id: string;
  name: string;
  tier: string;
  prefix: string;
  scopes: string[];
  createdBy: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const SELECT = {
  id: true,
  name: true,
  tier: true,
  prefix: true,
  scopes: true,
  createdBy: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

/**
 * API keys: `pk_live_...` (mainnet tier) or `pk_test_...` (test tier),
 * shown once and stored as a SHA-256 hash. The prefix decides the tier.
 */
@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    organizationId: string;
    tier: Tier;
    name: string;
    scopes: Scope[];
    createdBy: string;
  }): Promise<{ key: string; row: ApiKeyRow }> {
    const key = newSecret(API_KEY_PREFIXES[input.tier]);
    const row = await this.prisma.apiKey.create({
      data: {
        organizationId: input.organizationId,
        tier: input.tier,
        name: input.name,
        prefix: key.slice(0, DISPLAY_PREFIX_LENGTH),
        hash: sha256Hex(key),
        scopes: [...new Set(input.scopes)],
        createdBy: input.createdBy,
      },
      select: SELECT,
    });
    return { key, row };
  }

  list(organizationId: string): Promise<ApiKeyRow[]> {
    return this.prisma.apiKey.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      select: SELECT,
    });
  }

  async revoke(organizationId: string, id: string): Promise<void> {
    const done = await this.prisma.apiKey.updateMany({
      where: { id, organizationId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (done.count !== 1) throw ApiError.notFound(`API key ${id} not found`);
  }

  /** The organization and tier a live key acts for, or null. */
  async resolve(token: string): Promise<OrgPrincipal | null> {
    const tier = tierOfApiKey(token);
    if (!tier) return null;
    const row = await this.prisma.apiKey.findUnique({
      where: { hash: sha256Hex(token) },
      select: {
        id: true,
        organizationId: true,
        tier: true,
        scopes: true,
        revokedAt: true,
        lastUsedAt: true,
      },
    });
    if (!row || row.revokedAt || row.tier !== tier) return null;
    const now = Date.now();
    if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
      await this.prisma.apiKey.updateMany({
        where: { id: row.id },
        data: { lastUsedAt: new Date(now) },
      });
    }
    return {
      kind: 'apiKey',
      organizationId: row.organizationId,
      tier,
      scopes: row.scopes as Scope[],
      apiKeyId: row.id,
    };
  }
}
