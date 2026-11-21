import { TransactionBuilder, type Keypair, type Transaction } from '@stellar/stellar-sdk';

/**
 * A minimal client of the API for the dev stack, its seed and the e2e tests:
 * plain HTTP calls, SEP-10 sign-in, account registration and "sign what the
 * API built, submit it through the API" (sponsored). Dev keys only.
 */

export class DevApi {
  constructor(
    readonly base: string,
    private readonly origin: string,
  ) {}

  async call<T>(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: this.origin,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Every item of a paged list route (`take` / `skip`, `{ data, total }`). */
  async all<T>(path: string, token: string): Promise<T[]> {
    const items: T[] = [];
    const join = path.includes('?') ? '&' : '?';
    for (let skip = 0; ; skip += 100) {
      const page = await this.call<{ data: T[]; total: number }>(
        'GET',
        `${path}${join}take=100&skip=${skip}`,
        token,
      );
      items.push(...page.data);
      if (page.data.length < 100 || items.length >= page.total) return items;
    }
  }
}

/** Signs an XDR envelope with `signer` for `passphrase`. */
export function signXdr(xdr: string, passphrase: string, signer: Keypair): string {
  const tx = TransactionBuilder.fromXDR(xdr, passphrase) as Transaction;
  tx.sign(signer);
  return tx.toXDR();
}

/** Signs an account in with SEP-10; answers its session token. */
export async function signIn(api: DevApi, signer: Keypair): Promise<string> {
  const challenge = await api.call<{ transaction: string; network_passphrase: string }>(
    'GET',
    `/v1/auth/challenge?account=${signer.publicKey()}`,
    null,
  );
  const session = await api.call<{ token: string }>('POST', '/v1/auth/verify', null, {
    transaction: signXdr(challenge.transaction, challenge.network_passphrase, signer),
  });
  return session.token;
}

/** Registers an account for an organization with its SEP-10-shaped proof. */
export async function registerAccount(
  api: DevApi,
  key: string,
  signer: Keypair,
  displayName: string,
): Promise<{ id: string; address: string }> {
  const challenge = await api.call<{ transaction: string; network_passphrase: string }>(
    'POST',
    '/v1/p2p/accounts/challenge',
    key,
    { address: signer.publicKey() },
  );
  return api.call<{ id: string; address: string }>('POST', '/v1/p2p/accounts', key, {
    transaction: signXdr(challenge.transaction, challenge.network_passphrase, signer),
    displayName,
    label: `${displayName} dev account`,
  });
}

export interface Submission {
  hash: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  error: string | null;
}

/**
 * Signs a transaction the API built and submits it through the API (`app`:
 * a session's `/v1/app/submit`; `org`: an API key's `/v1/p2p/submit`), then
 * waits until it is applied; throws unless it succeeded.
 */
export async function signAndSubmit(
  api: DevApi,
  token: string,
  channel: 'app' | 'org',
  built: { xdr: string; network: string },
  signer: Keypair,
  passphrase: string,
): Promise<Submission> {
  const base = channel === 'app' ? '/v1/app' : '/v1/p2p';
  let sub = await api.call<Submission>('POST', `${base}/submit`, token, {
    xdr: signXdr(built.xdr, passphrase, signer),
    network: built.network,
  });
  for (let i = 0; i < 60 && sub.status === 'PENDING'; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    sub = await api.call<Submission>('GET', `${base}/submissions/${sub.hash}`, token);
  }
  if (sub.status !== 'SUCCESS') {
    throw new Error(`submission ${sub.hash} ${sub.status}: ${sub.error ?? 'no result'}`);
  }
  return sub;
}

/** Creates an organization for a signed-in wallet and a `pk_test_` key (read and write) for it. */
export async function organizationWithKey(
  api: DevApi,
  session: string,
  name: string,
): Promise<{ organizationId: string; apiKey: string }> {
  const org = await api.call<{ id: string }>('POST', '/v1/organizations', session, { name });
  const key = await api.call<{ key: string }>(
    'POST',
    `/v1/organizations/${org.id}/api-keys`,
    session,
    { name: `${name} dev key`, tier: 'test', scopes: ['p2p:read', 'p2p:write'] },
  );
  return { organizationId: org.id, apiKey: key.key };
}
