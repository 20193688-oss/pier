/* The API's account-side resources (sessions, organizations, members, API keys, webhooks) as the
   screens read them, and their tolerant readers: a missing optional field becomes null, a
   malformed required one becomes an empty value the screen can show. Pure;
   tests/unit/api-types.test.ts. */

import type { Tier } from '@/lib/api/client';

export type Role = 'owner' | 'admin' | 'member';
export const ROLES: readonly Role[] = ['owner', 'admin', 'member'];

export interface OrgMembership {
  id: string;
  name: string;
  role: Role;
}

export interface Session {
  address: string;
  expiresAt: string | null;
  organizations: OrgMembership[];
}

export interface Organization {
  id: string;
  name: string;
  role: Role;
  createdAt: string;
}

export interface Member {
  id: string;
  address: string;
  role: Role;
  label: string | null;
  addedAt: string;
}

export type KeyTier = Tier;
export const API_SCOPES = ['p2p:read', 'p2p:write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKey {
  id: string;
  name: string;
  /* The key's visible start (`pk_test_9f2c`), never the key. */
  prefix: string;
  tier: KeyTier;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** A key as its creation answers it: the only time the full key is shown. */
export interface CreatedApiKey extends ApiKey {
  key: string;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  createdAt: string;
}

export interface CreatedWebhookEndpoint extends WebhookEndpoint {
  /* The signing secret, shown once (`whsec_...`). */
  secret: string;
}

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface WebhookDelivery {
  id: string;
  event: string;
  status: DeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  createdAt: string;
  nextAttemptAt: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const s = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
const sOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const role = (v: unknown): Role => (v === 'owner' || v === 'admin' ? v : 'member');

export function normalizeSession(raw: unknown): Session | null {
  if (!isObj(raw)) return null;
  const root = isObj(raw.session) ? raw.session : raw;
  const address = s(root.address);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const orgs = Array.isArray(root.organizations)
    ? root.organizations
    : Array.isArray(raw.organizations)
      ? raw.organizations
      : [];
  return {
    address,
    expiresAt: sOrNull(root.expiresAt),
    organizations: orgs.filter(isObj).map((o) => ({
      id: s(o.id),
      name: s(o.name),
      role: role(o.role),
    })),
  };
}

export function normalizeOrganization(raw: unknown): Organization {
  const o = isObj(raw) ? raw : {};
  return { id: s(o.id), name: s(o.name), role: role(o.role), createdAt: s(o.createdAt) };
}

export function normalizeMember(raw: unknown): Member {
  const o = isObj(raw) ? raw : {};
  return {
    id: s(o.id ?? o.address),
    address: s(o.address),
    role: role(o.role),
    label: sOrNull(o.label),
    addedAt: s(o.addedAt ?? o.createdAt),
  };
}

/** The tier a key works in: its `tier` field, else its prefix. */
export function keyTier(o: { tier?: unknown; prefix?: unknown; key?: unknown }): KeyTier {
  if (o.tier === 'live' || o.tier === 'mainnet') return 'live';
  if (o.tier === 'test' || o.tier === 'testnet') return 'test';
  const p = s(o.prefix) || s(o.key);
  return p.startsWith('pk_live_') ? 'live' : 'test';
}

export function normalizeApiKey(raw: unknown): ApiKey {
  const o = isObj(raw) ? raw : {};
  return {
    id: s(o.id),
    name: s(o.name),
    prefix: s(o.prefix),
    tier: keyTier(o),
    scopes: Array.isArray(o.scopes) ? o.scopes.map((x) => s(x)).filter(Boolean) : [],
    createdAt: s(o.createdAt),
    lastUsedAt: sOrNull(o.lastUsedAt),
    revokedAt: sOrNull(o.revokedAt),
  };
}

export function normalizeCreatedApiKey(raw: unknown): CreatedApiKey | null {
  const o = isObj(raw)
    ? isObj(raw.apiKey)
      ? { ...raw.apiKey, key: raw.key ?? raw.apiKey.key }
      : raw
    : null;
  if (!o || typeof o.key !== 'string' || !/^pk_(live|test)_[A-Za-z0-9_-]{8,}$/.test(o.key))
    return null;
  const k = normalizeApiKey(o);
  return { ...k, prefix: k.prefix || o.key.slice(0, 12), key: o.key };
}

export function normalizeWebhook(raw: unknown): WebhookEndpoint {
  const o = isObj(raw) ? raw : {};
  return {
    id: s(o.id),
    url: s(o.url),
    description: sOrNull(o.description),
    events: Array.isArray(o.events) ? o.events.map((x) => s(x)).filter(Boolean) : [],
    active: o.active !== false && o.enabled !== false,
    createdAt: s(o.createdAt),
  };
}

export function normalizeCreatedWebhook(raw: unknown): CreatedWebhookEndpoint | null {
  const o = isObj(raw) ? raw : null;
  const secret = o ? s(o.secret ?? o.signingSecret) : '';
  if (!o || !secret) return null;
  return { ...normalizeWebhook(o), secret };
}

export function normalizeDelivery(raw: unknown): WebhookDelivery {
  const o = isObj(raw) ? raw : {};
  const st =
    o.status === 'delivered' || o.status === 'succeeded'
      ? 'delivered'
      : o.status === 'failed'
        ? 'failed'
        : 'pending';
  return {
    id: s(o.id),
    event: s(o.event ?? o.type),
    status: st,
    attempts: Number(o.attempts ?? 0) || 0,
    responseStatus:
      typeof o.responseStatus === 'number'
        ? o.responseStatus
        : typeof o.lastStatus === 'number'
          ? o.lastStatus
          : null,
    createdAt: s(o.createdAt),
    nextAttemptAt: sOrNull(o.nextAttemptAt),
  };
}
