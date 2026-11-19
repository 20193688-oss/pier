/**
 * The API's one error shape: `{ error: { code, message, details? } }`. Every
 * refusal is an `ApiError` with a stable snake_case `code` clients branch on;
 * the message is for people. `details` lists field problems on a 400.
 */

export const ErrorCode = {
  ValidationFailed: 'validation_failed',
  Unauthorized: 'unauthorized',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  Conflict: 'conflict',
  RateLimited: 'rate_limited',
  Internal: 'internal_error',
  Unavailable: 'service_unavailable',
  NetworkUnsupported: 'network_unsupported',
  AssetUnsupported: 'asset_unsupported',
  NoMatch: 'no_match',
  QuoteNotFound: 'quote_not_found',
  QuoteExpired: 'quote_expired',
  InvalidState: 'invalid_state',
  IdempotencyConflict: 'idempotency_conflict',
  OperationInFlight: 'operation_in_flight',
  ChallengeInvalid: 'challenge_invalid',
  SignatureInvalid: 'signature_invalid',
  AccountTaken: 'account_taken',
  ChargeClosed: 'charge_closed',
  LastOwner: 'last_owner',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: string[] };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: string[],
    /** Seconds a 429 or 503 asks the client to wait. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  body(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && this.details.length > 0 ? { details: this.details } : {}),
      },
    };
  }

  static validation(details: string[]): ApiError {
    return new ApiError(400, ErrorCode.ValidationFailed, 'The request is not valid.', details);
  }

  static badRequest(code: ErrorCode, message: string, details?: string[]): ApiError {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(message = 'Sign in or send an API key.'): ApiError {
    return new ApiError(401, ErrorCode.Unauthorized, message);
  }

  static forbidden(message = 'You may not do this.'): ApiError {
    return new ApiError(403, ErrorCode.Forbidden, message);
  }

  static notFound(message: string, code: ErrorCode = ErrorCode.NotFound): ApiError {
    return new ApiError(404, code, message);
  }

  static conflict(code: ErrorCode, message: string): ApiError {
    return new ApiError(409, code, message);
  }

  static rateLimited(retryAfterSeconds: number): ApiError {
    return new ApiError(
      429,
      ErrorCode.RateLimited,
      `Too many requests. Retry in ${retryAfterSeconds}s.`,
      undefined,
      retryAfterSeconds,
    );
  }

  /**
   * A deployment problem the client cannot fix: a neutral message for them,
   * the operator's detail for the log (`operatorDetail`, never sent).
   */
  static unavailable(message: string, operatorDetail?: string): ApiError {
    const error = new ApiError(503, ErrorCode.Unavailable, message);
    if (operatorDetail) error.operatorDetail = operatorDetail;
    return error;
  }

  operatorDetail?: string;
}
