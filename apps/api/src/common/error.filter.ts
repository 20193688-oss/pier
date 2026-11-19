import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError, ErrorCode, type ErrorBody } from '@/common/api-error';

const HTTP_CODES: Record<number, ErrorCode> = {
  400: ErrorCode.ValidationFailed,
  401: ErrorCode.Unauthorized,
  403: ErrorCode.Forbidden,
  404: ErrorCode.NotFound,
  409: ErrorCode.Conflict,
  413: ErrorCode.ValidationFailed,
  429: ErrorCode.RateLimited,
};

/**
 * Every error leaves in one shape, `{ error: { code, message, details? } }`.
 * An `ApiError` is answered as it is; Nest's own exceptions (an unknown route,
 * a body too large, malformed JSON) get their status and a matching code;
 * anything else is a 500 that says nothing about the inside.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    let status: number;
    let body: ErrorBody;
    if (exception instanceof ApiError) {
      status = exception.status;
      body = exception.body();
      if (exception.retryAfterSeconds)
        res.setHeader('Retry-After', String(exception.retryAfterSeconds));
      if (exception.operatorDetail) {
        this.logger.error(`${req.method} ${req.path}: ${exception.operatorDetail}`);
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const code =
        HTTP_CODES[status] ?? (status >= 500 ? ErrorCode.Internal : ErrorCode.ValidationFailed);
      const message =
        status === 404
          ? `No route ${req.method} ${req.path}.`
          : status >= 500
            ? 'Something went wrong on our side.'
            : exception.message;
      body = { error: { code, message } };
    } else {
      status = 500;
      body = { error: { code: ErrorCode.Internal, message: 'Something went wrong on our side.' } };
      const err = exception as Error;
      this.logger.error(`${req.method} ${req.path}: ${err?.stack ?? String(exception)}`);
    }
    if (!res.headersSent) res.status(status).json(body);
  }
}
