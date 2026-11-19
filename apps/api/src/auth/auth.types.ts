import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import type { Tier } from '@/chain/networks';

/** What an API key (or a member's role) may do. */
export const SCOPES = ['p2p:read', 'p2p:write'] as const;
export type Scope = (typeof SCOPES)[number];

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** The scopes a member's role grants when it acts through a wallet session. */
export const ROLE_SCOPES: Record<MemberRole, Scope[]> = {
  owner: ['p2p:read', 'p2p:write'],
  admin: ['p2p:read', 'p2p:write'],
  member: ['p2p:read'],
};

/** A role's rank, to compare "at least admin". */
export const ROLE_RANK: Record<MemberRole, number> = { member: 1, admin: 2, owner: 3 };

export const API_KEY_PREFIXES: Record<Tier, string> = { live: 'pk_live_', test: 'pk_test_' };
export const SESSION_TOKEN_PREFIX = 'ps_sess_';
export const SESSION_COOKIE = 'pedospe_session';
/** Headers a wallet session names its organization and tier with on organization routes. */
export const ORGANIZATION_HEADER = 'pedospe-organization';
export const TIER_HEADER = 'pedospe-tier';

/** A signed-in wallet. */
export interface SessionPrincipal {
  sessionId: string;
  address: string;
  expiresAt: Date;
  isAdmin: boolean;
  /** Authenticated by the cookie (not a bearer token): writes need an allowed Origin. */
  viaCookie: boolean;
}

/** Who acts for an organization on one tier: an API key, or a member's session. */
export interface OrgPrincipal {
  kind: 'apiKey' | 'member';
  organizationId: string;
  tier: Tier;
  scopes: Scope[];
  apiKeyId?: string;
  /** The member's wallet (sessions only). */
  address?: string;
  role?: MemberRole;
}

export interface AuthState {
  session?: SessionPrincipal;
  org?: OrgPrincipal;
}

export interface AuthedRequest extends Request {
  auth?: AuthState;
}

/** A new secret: a prefix and 256 bits, base64url. */
export function newSecret(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The tier an API key's prefix names, or null when it is not an API key. */
export function tierOfApiKey(token: string): Tier | null {
  if (token.startsWith(API_KEY_PREFIXES.live)) return 'live';
  if (token.startsWith(API_KEY_PREFIXES.test)) return 'test';
  return null;
}
