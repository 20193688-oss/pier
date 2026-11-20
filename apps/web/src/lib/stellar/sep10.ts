/* The trusted values a SEP-10 challenge is checked against (src/lib/stellar/challenge.ts), and the
   one check both sign-in and the dashboard's wallet proofs run before a wallet signs:

   - home domain: VITE_SEP10_HOME_DOMAIN, else this page's host (the API's SEP10_HOME_DOMAIN is the
     web host);
   - web auth domain: VITE_SEP10_WEB_AUTH_DOMAIN, else the home domain;
   - signing key: SIGNING_KEY of this origin's /.well-known/stellar.toml, fetched from this origin
     (the dev server proxies /.well-known to the API, as it does /v1), read once per tab. */
import { request } from '@/lib/api/client';
import { checkChallenge, signingKeyOf } from '@/lib/stellar/challenge';
import { KNOWN_PASSPHRASES } from '@/lib/stellar/network';
import { WalletError } from '@/lib/wallet/types';

export interface Sep10Domains {
  homeDomain: string;
  webAuthDomain: string;
}

/** This app's SEP-10 domains, from its configuration (never from an API answer). */
export function sep10Domains(): Sep10Domains {
  const host = typeof location === 'undefined' ? '' : location.host;
  const homeDomain = String(import.meta.env.VITE_SEP10_HOME_DOMAIN ?? '').trim() || host;
  const webAuthDomain = String(import.meta.env.VITE_SEP10_WEB_AUTH_DOMAIN ?? '').trim() || homeDomain;
  return { homeDomain, webAuthDomain };
}

let signingKey: Promise<string> | null = null;

/** SIGNING_KEY of this origin's stellar.toml. */
export function originSigningKey(): Promise<string> {
  signingKey ??= request<string>({
    method: 'GET',
    path: '/.well-known/stellar.toml',
    text: true,
    sameOrigin: true,
  })
    .then((toml) => {
      const key = typeof toml === 'string' ? signingKeyOf(toml) : null;
      if (!key) throw new WalletError('mismatch', 'challenge:signing-key');
      return key;
    })
    .catch((e) => {
      signingKey = null;
      throw e instanceof WalletError ? e : new WalletError('mismatch', 'challenge:signing-key');
    });
  return signingKey;
}

/** Forget the signing key read for this tab (tests; a rotated key). */
export function forgetSigningKey() {
  signingKey = null;
}

/** Throws unless `account` may sign `challengeXdr` (a WalletError whose message starts with
    `challenge:`); resolves with the domains to pass to the wallet. */
export async function assertChallenge(
  challengeXdr: string,
  networkPassphrase: string,
  account: string,
): Promise<Sep10Domains> {
  const domains = sep10Domains();
  const key = await originSigningKey();
  const problem = checkChallenge(challengeXdr, {
    account,
    networkPassphrase,
    allowedPassphrases: KNOWN_PASSPHRASES,
    signingKey: key,
    ...domains,
  });
  if (problem) throw new WalletError('mismatch', `challenge:${problem}`);
  return domains;
}
