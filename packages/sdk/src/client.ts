import createClient, { type Client } from 'openapi-fetch';
import type { paths } from '@/generated/schema';
import type { ErrorCode, Tier } from '@/types';

/** A typed `openapi-fetch` client for every route of the API contract. */
export type MidpointClient = Client<paths>;

/** The header a wallet session names the organization it acts for in. */
export const ORGANIZATION_HEADER = 'Midpoint-Organization';
/** The header a wallet session names the tier (`live` or `test`) it acts on in. */
export const TIER_HEADER = 'Midpoint-Tier';

export interface MidpointClientOptions {
  /** The API origin, e.g. `https://api.midpoint.money` (the contract's paths start with `/v1`). */
  baseUrl: string;
  /** An API key (`pk_live_...` or `pk_test_...`): it acts for one organization on one tier. */
  apiKey?: string;
  /** A wallet session token (`ps_sess_...`) from `POST /v1/auth/verify`. */
  sessionToken?: string;
  /** Sessions only: the organization to act for (sent as `Midpoint-Organization`). */
  organizationId?: string;
  /** Sessions only: the tier to act on (sent as `Midpoint-Tier`; the API defaults to `test`). */
  tier?: Tier;
  /** A custom `fetch` (tests, proxies, retries). Defaults to `globalThis.fetch`. */
  fetch?: (request: Request) => Promise<Response>;
}

const API_KEY = /^pk_(?:live|test)_\S+$/;
const SESSION_TOKEN = /^ps_sess_\S+$/;

/**
 * Creates a client for the Midpoint API. Pass an API key for server-to-server
 * calls, or a session token (with the organization and tier to act for) on
 * behalf of a signed-in wallet. With neither, only the public routes work
 * (`/v1/market`, sign-in and the hosted charge's payer routes).
 *
 * ```ts
 * const client = createMidpointClient({ baseUrl, apiKey: process.env.MIDPOINT_API_KEY });
 * const market = await unwrap(client.GET('/v1/market'));
 * ```
 */
export function createMidpointClient(options: MidpointClientOptions): MidpointClient {
  const { baseUrl, apiKey, sessionToken, organizationId, tier } = options;
  if (!URL.canParse(baseUrl)) {
    throw new TypeError(`baseUrl must be an absolute URL, got "${baseUrl}".`);
  }
  if (apiKey !== undefined && sessionToken !== undefined) {
    throw new TypeError('Pass either apiKey or sessionToken, not both.');
  }
  if (apiKey !== undefined && !API_KEY.test(apiKey)) {
    throw new TypeError('apiKey must be a Midpoint API key (pk_live_... or pk_test_...).');
  }
  if (sessionToken !== undefined && !SESSION_TOKEN.test(sessionToken)) {
    throw new TypeError('sessionToken must be a Midpoint session token (ps_sess_...).');
  }
  if (apiKey !== undefined && (organizationId !== undefined || tier !== undefined)) {
    throw new TypeError(
      'organizationId and tier are for sessions: an API key already carries its organization and tier.',
    );
  }
  if (tier !== undefined && tier !== 'live' && tier !== 'test') {
    throw new TypeError(`tier must be "live" or "test", got "${String(tier)}".`);
  }

  const headers: Record<string, string> = {};
  const credential = apiKey ?? sessionToken;
  if (credential !== undefined) headers.Authorization = `Bearer ${credential}`;
  if (organizationId !== undefined) headers[ORGANIZATION_HEADER] = organizationId;
  if (tier !== undefined) headers[TIER_HEADER] = tier;

  return createClient<paths>({ baseUrl, headers, fetch: options.fetch });
}

/** The code a `MidpointError` carries when the API answered without its error body. */
export const UNEXPECTED_RESPONSE = 'unexpected_response';

/** An API error: the HTTP status and the API's `{ code, message, details? }`. */
export class MidpointError extends Error {
  override readonly name = 'MidpointError';
  readonly status: number;
  readonly code: ErrorCode | typeof UNEXPECTED_RESPONSE;
  readonly details?: string[];

  constructor(init: {
    status: number;
    code: ErrorCode | typeof UNEXPECTED_RESPONSE;
    message: string;
    details?: string[];
  }) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    if (init.details !== undefined) this.details = init.details;
  }

  /** Builds the error from a failed response's status and (parsed) body. */
  static fromResponse(status: number, body: unknown): MidpointError {
    if (isApiErrorBody(body)) {
      const { code, message, details } = body.error;
      return new MidpointError({ status, code, message, details });
    }
    return new MidpointError({
      status,
      code: UNEXPECTED_RESPONSE,
      message: `The API answered HTTP ${status} without an error body.`,
    });
  }
}

function isApiErrorBody(
  body: unknown,
): body is { error: { code: ErrorCode; message: string; details?: string[] } } {
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  const { code, message, details } = error as Record<string, unknown>;
  return (
    typeof code === 'string' &&
    typeof message === 'string' &&
    (details === undefined ||
      (Array.isArray(details) && details.every((d) => typeof d === 'string')))
  );
}

/** What every `openapi-fetch` call resolves to. */
interface FetchResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

/** The success body of a call, or `undefined` for routes that answer 204. */
export type Unwrapped<R extends FetchResult> = [Exclude<R['data'], undefined>] extends [never]
  ? undefined
  : Exclude<R['data'], undefined>;

/**
 * Returns a call's success body, or throws a `MidpointError` with the API's
 * error code when the response is not 2xx. Takes the call itself or its
 * awaited result:
 *
 * ```ts
 * const order = await unwrap(client.GET('/v1/p2p/orders/{id}', { params: { path: { id } } }));
 * ```
 */
export async function unwrap<R extends FetchResult>(
  result: R | PromiseLike<R>,
): Promise<Unwrapped<R>> {
  const { data, error, response } = await result;
  if (!response.ok) throw MidpointError.fromResponse(response.status, error);
  return data as Unwrapped<R>;
}
