/* The API client's transport: one function every call goes through.

   - Real mode: `fetch` to the API's origin (`VITE_API_BASE_URL`, default the web app's own origin,
     which the dev server proxies to the API), with the session cookie (`credentials: 'include'`).
     The browser never holds the session token itself: the cookie is HttpOnly.
   - Mock mode: the in-browser mock API (src/lib/mock) answers instead, with the same shapes.

   Every error answer is read as the API's one error shape `{ error: { code, message, details? } }`
   into an ApiError; a network failure is an ApiError with status 0. */

/** An organization's tier: `live` (mainnet networks) or `test` (test networks). */
export type Tier = 'live' | 'test';

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /* The answer is text (a stellar.toml), not JSON. */
  text?: boolean;
  /* Ask this page's own origin, never VITE_API_BASE_URL (this origin's /.well-known). */
  sameOrigin?: boolean;
}

export interface ApiResponse {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

export type Transport = (req: ApiRequest) => Promise<ApiResponse>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryAfter?: number;
  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

const BASE = String(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

export function buildUrl(path: string, query?: ApiRequest['query'], sameOrigin = false): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return `${sameOrigin ? '' : BASE}${path}${s ? `?${s}` : ''}`;
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export const fetchTransport: Transport = async (req) => {
  const res = await fetch(buildUrl(req.path, req.query, req.sameOrigin), {
    method: req.method,
    credentials: req.sameOrigin ? 'same-origin' : 'include',
    cache: 'no-store',
    headers: {
      Accept: req.text ? 'text/plain' : 'application/json',
      ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...req.headers,
    },
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
  });
  const text = await res.text();
  const json = req.text && res.ok ? text : parseJson(text);
  const headers: Record<string, string> = {};
  const retry = res.headers.get('retry-after');
  if (retry) headers['retry-after'] = retry;
  return { status: res.status, json, headers };
};

let transport: Transport = fetchTransport;

/** Swap the transport (mock mode installs its own at start-up; tests install fakes). */
export function setTransport(next: Transport) {
  transport = next;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The API's error shape `{ error: { code, message, details } }` (a flat `{ code, message }` is
    read too), as an ApiError. */
export function errorFrom(
  status: number,
  json: unknown,
  headers?: Record<string, string>,
): ApiError {
  const root = obj(json);
  const e = obj(root?.error) ?? root;
  const code = typeof e?.code === 'string' ? e.code : status === 0 ? 'network' : `http_${status}`;
  const message = typeof e?.message === 'string' ? e.message.slice(0, 300) : `HTTP ${status}`;
  const retry = Number(headers?.['retry-after']);
  return new ApiError(
    status,
    code,
    message,
    e?.details,
    Number.isFinite(retry) && retry > 0 ? retry : undefined,
  );
}

export async function request<T = unknown>(req: ApiRequest): Promise<T> {
  let res: ApiResponse;
  try {
    res = await transport(req);
  } catch {
    throw new ApiError(0, 'network', 'Network error');
  }
  if (res.status >= 200 && res.status < 300) return res.json as T;
  throw errorFrom(res.status, res.json, res.headers);
}

/** A list answer's items: a bare array, or `{ data: [...] }` / `{ items: [...] }`. */
export function listOf(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const o = obj(json);
  if (Array.isArray(o?.data)) return o.data as unknown[];
  if (Array.isArray(o?.items)) return o.items as unknown[];
  return [];
}

/** A single object answer, bare or wrapped as `{ data: {...} }`. */
export function itemOf(json: unknown): unknown {
  const o = obj(json);
  if (o && 'data' in o && obj(o.data) && !('id' in o)) return o.data;
  return json;
}
