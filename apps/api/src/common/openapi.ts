import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiResponse, ApiSchema } from '@nestjs/swagger';
import { ErrorCode } from '@/common/api-error';

@ApiSchema({ name: 'ErrorDetail', description: 'What went wrong.' })
export class ErrorDetailView {
  @ApiProperty({ enum: Object.values(ErrorCode), example: 'validation_failed' })
  code!: string;

  @ApiProperty({ example: 'The request is not valid.' })
  message!: string;

  @ApiPropertyOptional({ type: [String], example: ['fiatAmount must be a positive decimal'] })
  details?: string[];
}

@ApiSchema({ name: 'Error', description: 'Every error the API answers has this shape.' })
export class ErrorView {
  @ApiProperty({ type: ErrorDetailView })
  error!: ErrorDetailView;
}

const DESCRIPTIONS: Record<number, string> = {
  400: '`validation_failed`, or a domain refusal (`invalid_state`, `no_match` on a quote, `network_unsupported`, `asset_unsupported`, `quote_expired`, `challenge_invalid`, `signature_invalid`).',
  401: '`unauthorized`: no credentials, or an unknown, revoked or expired key or session.',
  403: '`forbidden`: the credentials may not do this (scope, role, tier, cross-site write).',
  404: '`not_found`: nothing of yours with that id on this tier.',
  409: '`conflict`, `no_match`, `idempotency_conflict`, `operation_in_flight`, `already_done` (the order already shows that action; `details` names its status), `account_taken`, `charge_closed`, `last_owner`.',
  429: '`rate_limited`: retry after the `Retry-After` header.',
  503: '`service_unavailable`: the market is not available on that network right now.',
};

/** Documents the error responses a route can answer, all in the one error shape. */
export function ApiErrors(...statuses: number[]) {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({ status, type: ErrorView, description: DESCRIPTIONS[status] ?? 'An error.' }),
    ),
  );
}
