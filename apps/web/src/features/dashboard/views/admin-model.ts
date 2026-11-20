/* admin-model.ts: the pure rules behind the charges, payouts, webhooks and team views, kept out of
   the components so they can be tested: a charge's expiry, the figures of each list, a payout
   batch's progress, what a webhook URL and a member address must look like, and which roles a
   member may grant. Pure; tests/unit/admin.test.ts. */
import { isAccount } from '@/lib/stellar/network';
import type { Role } from '@/lib/api/types';
import type { P2pCharge, P2pPayoutBatch } from '@/lib/p2p/types';

export const CHARGE_EXPIRIES = ['1h', '24h', '7d', '30d', 'never'] as const;
export type ChargeExpiry = (typeof CHARGE_EXPIRIES)[number];

const EXPIRY_MS: Record<Exclude<ChargeExpiry, 'never'>, number> = {
  '1h': 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
};

/** The charge's `expiresAt` for a choice, or undefined for one that never expires. */
export function expiryIso(choice: ChargeExpiry, now = Date.now()): string | undefined {
  return choice === 'never' ? undefined : new Date(now + EXPIRY_MS[choice]).toISOString();
}

export function chargeFigures(charges: Pick<P2pCharge, 'status' | 'multiUse'>[]) {
  return {
    open: charges.filter((c) => c.status === 'open').length,
    paid: charges.filter((c) => c.status === 'paid').length,
    reusable: charges.filter((c) => c.status === 'open' && c.multiUse).length,
    expired: charges.filter((c) => c.status === 'expired').length,
  };
}

/** A batch's progress: payouts completed, the batch's size, and those the merchant marked paid
    (waiting for the client's release). */
export function batchProgress(batch: Pick<P2pPayoutBatch, 'items' | 'itemCount'>) {
  return {
    done: batch.items.filter((i) => i.status === 'completed' || i.status === 'resolved').length,
    total: Math.max(batch.itemCount, batch.items.length),
    toRelease: batch.items.filter((i) => i.status === 'paid').length,
    rejected: batch.items.filter((i) => i.status === 'rejected').length,
  };
}

export function payoutFigures(batches: Pick<P2pPayoutBatch, 'items' | 'itemCount'>[]) {
  const all = batches.map(batchProgress);
  return {
    batches: batches.length,
    items: all.reduce((n, b) => n + b.total, 0),
    completed: all.reduce((n, b) => n + b.done, 0),
    toRelease: all.reduce((n, b) => n + b.toRelease, 0),
  };
}

/** A webhook endpoint's URL: https, a host, no credentials in it, at most 2048 characters. */
export function isWebhookUrl(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** A member's wallet: a Stellar account (G...), written exactly (StrKeys have one spelling). */
export const isMemberAddress = (value: string) => isAccount(value.trim());

/** The roles a member with `mine` may give: owners any, admins admin and member, members none. */
export function grantableRoles(mine: Role): Role[] {
  if (mine === 'owner') return ['owner', 'admin', 'member'];
  if (mine === 'admin') return ['admin', 'member'];
  return [];
}
