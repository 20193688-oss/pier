/* The payments app's routes (docs/STELLAR.md 5.4 and 5.6): the signed-in wallet's profile and
   handle, its balances and activation, transfers, activity, paying a charge from the balance,
   and submitting what it signed. Every answer goes through a reader, so a screen gets one
   vocabulary (src/lib/app/types.ts) whatever the exact wire shape. */
import { ApiError, itemOf, request } from '@/lib/api/client';
import { ROUTES } from '@/lib/api/routes';
import { readSubmit, tx } from '@/lib/api/endpoints';
import { normalizeOrder, type Decimals } from '@/lib/p2p/normalize';
import { normalizeHandle } from '@pier/payment-qr';
import { body as checked } from '@/lib/api/spec';
import type {
  ActivityItem,
  ActivityPage,
  AppBalances,
  AppProfile,
  AppTransfer,
  ChargePayment,
  PayerCharge,
  SubmitResult,
} from '@/lib/app/types';
import type { P2pTransaction } from '@/lib/p2p/types';
import { isAccount, isDestination } from '@/lib/stellar/network';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : null;
const units = (v: unknown): string => {
  const s = str(v);
  return s && /^\d+$/.test(s) ? s : '0';
};
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const bad = () =>
  new ApiError(502, 'bad_response', 'The API answered something this page cannot read.');
const must = <T>(v: T | null): T => {
  if (v === null) throw bad();
  return v;
};

/* --- Readers (pure; tests/unit/app-api.test.ts) --- */

export function readProfile(raw: unknown): AppProfile | null {
  const o = itemOf(raw);
  if (!isObj(o) || !isAccount(o.address)) return null;
  const handle = typeof o.handle === 'string' ? normalizeHandle(o.handle) : null;
  return { address: o.address, handle };
}

export function readBalances(raw: unknown): AppBalances | null {
  const o = itemOf(raw);
  if (!isObj(o)) return null;
  const tokens = (Array.isArray(o.tokens) ? o.tokens : []).filter(isObj).map((t) => ({
    symbol: String(t.symbol ?? ''),
    contract: String(t.contract ?? ''),
    amount: units(t.amount),
    trustline: t.trustline === true,
    authorized: t.authorized !== false && t.trustline === true,
  }));
  return {
    network: String(o.network ?? ''),
    account: { exists: isObj(o.account) && o.account.exists === true },
    xlm: units(o.xlm),
    tokens,
  };
}

export function readTransfer(raw: unknown): AppTransfer | null {
  const o = itemOf(raw);
  if (!isObj(o) || typeof o.id !== 'string') return null;
  const status = ['PENDING', 'SUBMITTED', 'COMPLETED', 'FAILED'].includes(String(o.status))
    ? (o.status as AppTransfer['status'])
    : 'PENDING';
  return {
    id: o.id,
    network: String(o.network ?? ''),
    token: String(o.token ?? o.tokenSymbol ?? ''),
    amount: units(o.amount),
    from: String(o.from ?? ''),
    fromHandle: typeof o.fromHandle === 'string' ? o.fromHandle : null,
    to: String(o.to ?? ''),
    toHandle: typeof o.toHandle === 'string' ? o.toHandle : null,
    note: typeof o.note === 'string' && o.note ? o.note : null,
    direction: o.direction === 'in' ? 'in' : 'out',
    status,
    hash: typeof o.hash === 'string' && o.hash ? o.hash : null,
    createdAt: iso(o.createdAt) ?? '',
    completedAt: iso(o.completedAt),
  };
}

export function readActivity(raw: unknown, decimals: Decimals = null): ActivityPage {
  const o = isObj(raw) ? raw : {};
  const items: ActivityItem[] = [];
  for (const it of Array.isArray(o.items) ? o.items : []) {
    if (!isObj(it)) continue;
    const at = iso(it.at) ?? '';
    if (it.type === 'order' && isObj(it.order))
      items.push({ type: 'order', at, order: normalizeOrder(it.order, decimals) });
    else if (it.type === 'transfer') {
      const t = readTransfer(it.transfer);
      if (t) items.push({ type: 'transfer', at, transfer: t });
    }
  }
  return { items, nextCursor: typeof o.nextCursor === 'string' && o.nextCursor ? o.nextCursor : null };
}

export function readPayerCharge(raw: unknown): PayerCharge | null {
  const o = itemOf(raw);
  if (!isObj(o) || typeof o.id !== 'string') return null;
  const p = isObj(o.payWithBalance) ? o.payWithBalance : null;
  const status = ['open', 'paid', 'expired', 'cancelled'].includes(String(o.status))
    ? (o.status as PayerCharge['status'])
    : 'open';
  return {
    id: o.id,
    status,
    currency: String(o.currency ?? ''),
    fiatAmount: String(o.fiatAmount ?? ''),
    description: typeof o.description === 'string' ? o.description : null,
    merchantName: str(o.merchantName ?? o.payeeName),
    network: String(o.network ?? ''),
    token: String(o.tokenSymbol ?? o.token ?? ''),
    expiresAt: iso(o.expiresAt),
    payWithBalance:
      p &&
      /^\d+$/.test(String(p.amount ?? '')) &&
      BigInt(String(p.amount)) > 0n &&
      isDestination(p.recipient)
        ? {
            token: String(p.token ?? p.tokenSymbol ?? ''),
            tokenContract: typeof p.tokenContract === 'string' ? p.tokenContract : null,
            amount: String(p.amount),
            expiresAt: iso(p.expiresAt) ?? '',
            recipient: p.recipient,
          }
        : null,
  };
}

export function readChargePayment(raw: unknown): ChargePayment | null {
  const o = isObj(raw) ? raw : null;
  if (!o || typeof o.id !== 'string') return null;
  return {
    id: o.id,
    chargeId: String(o.chargeId ?? ''),
    network: String(o.network ?? ''),
    token: String(o.token ?? o.tokenSymbol ?? ''),
    amount: units(o.amount),
    hash: typeof o.hash === 'string' && o.hash ? o.hash : null,
    status: String(o.status ?? ''),
    expiresAt: iso(o.expiresAt),
  };
}

/* --- Calls --- */

export const app = {
  profile: async (): Promise<AppProfile> =>
    must(readProfile(await request({ method: 'GET', path: ROUTES.appProfile }))),
  /** Claim or change the handle; 409 `handle_taken` when someone has it. */
  claimHandle: async (handle: string): Promise<AppProfile> =>
    must(
      readProfile(
        await request({
          method: 'PUT',
          path: ROUTES.appProfile,
          body: checked('UpdateProfile', { handle }),
        }),
      ),
    ),
  /** Who `@handle` is, or null when nobody has it. */
  resolveHandle: async (handle: string): Promise<{ handle: string; address: string } | null> => {
    const h = normalizeHandle(handle);
    if (!h) return null;
    try {
      const o = itemOf(await request({ method: 'GET', path: ROUTES.appHandle(h) }));
      return isObj(o) && isAccount(o.address) ? { handle: h, address: o.address } : null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  balances: async (network: string): Promise<AppBalances> =>
    must(readBalances(await request({ method: 'GET', path: ROUTES.appBalances, query: { network } }))),
  /** The sponsored activation for `token`, or null when there is nothing to do. */
  activate: async (network: string, token: string): Promise<P2pTransaction | null> => {
    const o = itemOf(
      await request({
        method: 'POST',
        path: ROUTES.appActivate,
        body: checked('Activate', { network, token }),
      }),
    );
    if (isObj(o) && o.transaction === null) return null;
    return tx(o, 'activate');
  },
  transfer: async (body: {
    network: string;
    to: string;
    token: string;
    amount: string;
    note?: string;
  }): Promise<{ transfer: AppTransfer; transaction: P2pTransaction }> => {
    const o = itemOf(
      await request({
        method: 'POST',
        path: ROUTES.appTransfers,
        body: checked('CreateTransfer', body),
      }),
    );
    if (!isObj(o)) throw bad();
    return { transfer: must(readTransfer(o.transfer)), transaction: tx(o.transaction, 'payment') };
  },
  getTransfer: async (id: string): Promise<AppTransfer> =>
    must(readTransfer(await request({ method: 'GET', path: ROUTES.appTransfer(id) }))),
  activity: async (
    network: string,
    opts: { cursor?: string | null; limit?: number } = {},
    decimals: Decimals = null,
  ): Promise<ActivityPage> =>
    readActivity(
      await request({
        method: 'GET',
        path: ROUTES.appActivity,
        query: { network, cursor: opts.cursor ?? undefined, limit: opts.limit ?? 20 },
      }),
      decimals,
    ),
  charge: async (id: string): Promise<PayerCharge> =>
    must(readPayerCharge(await request({ method: 'GET', path: ROUTES.appCharge(id) }))),
  payCharge: async (
    id: string,
    body: { network: string; token: string },
  ): Promise<{ payment: ChargePayment; transaction: P2pTransaction }> => {
    const o = itemOf(
      await request({
        method: 'POST',
        path: ROUTES.appChargePayments(id),
        body: checked('PayCharge', body),
      }),
    );
    if (!isObj(o)) throw bad();
    return {
      payment: must(readChargePayment(o.payment)),
      transaction: tx(o.transaction, 'payment'),
    };
  },
  submit: async (xdr: string): Promise<SubmitResult> =>
    must(
      readSubmit(
        await request({ method: 'POST', path: ROUTES.appSubmit, body: checked('Submit', { xdr }) }),
      ),
    ),
  submission: async (hash: string): Promise<SubmitResult> =>
    must(readSubmit(await request({ method: 'GET', path: ROUTES.appSubmission(hash) }))),
};

/** The app's submit route, for SignFlow. */
export const appSubmitter = { submit: app.submit, poll: app.submission };
