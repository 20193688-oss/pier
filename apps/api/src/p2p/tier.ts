import type { OrgPrincipal } from '@/auth/auth.types';
import type { DeploymentsService } from '@/chain/deployments.service';
import type { Tier } from '@/chain/networks';
import { ApiError, ErrorCode } from '@/common/api-error';

/**
 * The caller's tier, when the market runs there: every organization route of
 * the market starts here, so a tier with no deployment answers
 * `400 network_unsupported` everywhere.
 */
export function tierOf(org: OrgPrincipal, deployments: DeploymentsService): Tier {
  if (deployments.deployments(org.tier).length === 0) {
    throw ApiError.badRequest(
      ErrorCode.NetworkUnsupported,
      `The market is not available on the ${org.tier} tier yet.`,
    );
  }
  return org.tier;
}
