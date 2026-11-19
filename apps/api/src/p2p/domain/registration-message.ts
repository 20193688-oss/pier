/**
 * The text a wallet signs (EIP-191 `personal_sign`) to register with an
 * organization. It names everything the signature authorises: the address,
 * the organization and tier it registers under, a single-use nonce and an
 * expiry. The personal-sign prefix already makes it impossible to replay as a
 * transaction, and nothing else in the service asks a wallet to sign a text
 * starting with this title, so it cannot be replayed as another consent (a
 * SIWE sign-in message has a different, fixed shape).
 */

export const REGISTRATION_TITLE = 'pedospe';

export interface RegistrationFields {
  address: string;
  organizationId: string;
  tier: string;
  nonce: string;
  expiresAt: Date;
}

export function registrationMessage(fields: RegistrationFields): string {
  return [
    REGISTRATION_TITLE,
    `Register wallet: ${fields.address}`,
    `Organization: ${fields.organizationId}`,
    `Tier: ${fields.tier}`,
    `Nonce: ${fields.nonce}`,
    `Expires: ${fields.expiresAt.toISOString()}`,
  ].join('\n');
}
