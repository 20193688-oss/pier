import { Keypair, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import { rpcFor } from '@/chain/market-deploy';
import {
  DEV_TOKEN_CODE,
  keypair,
  mintTusd,
  type DevAccounts,
  type DevChain,
  type DevMarket,
} from '@/dev/stellar-dev';

/**
 * Seeds a dev market THROUGH THE API, the way a real merchant, business and
 * person would set themselves up: SEP-10 sign-in, an organization each, a
 * test API key, accounts registered with SEP-10 proofs, payment methods,
 * offers (QR payments included), liquidity deposited and the matcher
 * authorised with transactions the API built, the dev keys signed and the API
 * submitted (sponsored), a charge, and the user's account activated by the
 * sponsor. Only minting TUSD to the user is the issuer's own payment.
 */

export interface SeedResult {
  merchant: { organizationId: string; apiKey: string; accountId: string; address: string };
  business: { organizationId: string; apiKey: string; accountId: string; address: string };
  user: { address: string };
  charge: { id: string; url: string };
}

/** A minimal client of the API for dev scripts and tests. */
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

async function organizationWithKey(api: DevApi, session: string, name: string) {
  const org = await api.call<{ id: string }>('POST', '/v1/organizations', session, { name });
  const key = await api.call<{ key: string }>(
    'POST',
    `/v1/organizations/${org.id}/api-keys`,
    session,
    { name: `${name} dev key`, tier: 'test', scopes: ['p2p:read', 'p2p:write'] },
  );
  return { organizationId: org.id, apiKey: key.key };
}

/** Units of one TUSD (7 decimals). */
const U = 10_000_000n;

export async function seedDevMarket(input: {
  apiUrl: string;
  webOrigin: string;
  chain: DevChain;
  market: DevMarket;
  accounts: DevAccounts;
  log?: (m: string) => void;
}): Promise<SeedResult> {
  const log = input.log ?? (() => undefined);
  const { chain, accounts } = input;
  const api = new DevApi(input.apiUrl, input.webOrigin);
  const network = chain.network;
  const token = DEV_TOKEN_CODE;

  // --- the merchant: sells and buys tokens against ARS and BRL, and pays QRs --
  const merchantKey = keypair(accounts.merchant);
  const merchantSession = await signIn(api, merchantKey);
  const merchant = await organizationWithKey(api, merchantSession, 'Dev Merchant');
  const merchantAccount = await registerAccount(api, merchant.apiKey, merchantKey, 'Pampa Cambio');
  await api.call('POST', '/v1/p2p/payment-methods', merchant.apiKey, {
    accountId: merchantAccount.id,
    currency: 'ARS',
    rail: 'ar_bank_transfer',
    holderName: 'Pampa Cambio SRL',
    details: { cbu: '2850590940090418135201', cuit: '20123456786' },
    label: 'Main ARS account',
  });
  await api.call('POST', '/v1/p2p/payment-methods', merchant.apiKey, {
    accountId: merchantAccount.id,
    currency: 'BRL',
    rail: 'br_pix',
    holderName: 'Pampa Cambio LTDA',
    details: { keyType: 'email', key: 'pix@pampacambio.example' },
    label: 'PIX',
  });
  const offers = [
    {
      side: 'SELL_TOKEN',
      currency: 'ARS',
      rails: ['ar_bank_transfer'],
      price: '1250',
      minFiat: '1000',
      maxFiat: '2000000',
    },
    {
      side: 'BUY_TOKEN',
      currency: 'ARS',
      rails: ['ar_bank_transfer'],
      price: '1180',
      minFiat: '1000',
      maxFiat: '2000000',
    },
    {
      side: 'BUY_TOKEN',
      currency: 'ARS',
      rails: ['ar_qr'],
      price: '1190',
      minFiat: '100',
      maxFiat: '500000',
    },
    {
      side: 'SELL_TOKEN',
      currency: 'BRL',
      rails: ['br_pix'],
      price: '5.6',
      minFiat: '10',
      maxFiat: '10000',
    },
    {
      side: 'BUY_TOKEN',
      currency: 'BRL',
      rails: ['br_pix'],
      price: '5.3',
      minFiat: '10',
      maxFiat: '10000',
    },
    {
      side: 'BUY_TOKEN',
      currency: 'BRL',
      rails: ['br_pix_qr'],
      price: '5.35',
      minFiat: '1',
      maxFiat: '5000',
    },
  ];
  for (const offer of offers) {
    await api.call('POST', '/v1/p2p/offers', merchant.apiKey, {
      accountId: merchantAccount.id,
      network,
      token,
      priceTtlSeconds: 24 * 60 * 60,
      ...offer,
    });
  }
  for (const [action, args] of [
    ['deposit', { token, amount: (100_000n * U).toString() }],
    ['setMatcher', { maxPerOrder: (5_000n * U).toString(), autoSettle: false }],
  ] as const) {
    const built = await api.call<{ xdr: string; network: string }>(
      'POST',
      '/v1/p2p/transactions',
      merchant.apiKey,
      { network, from: merchantAccount.id, action, args },
    );
    await signAndSubmit(api, merchant.apiKey, 'org', built, merchantKey, chain.passphrase);
  }
  log('merchant seeded: offers (ARS, BRL, QR), 100 000 TUSD deposited, matcher authorised');

  // --- the business: integrates buy/sell and collects with charges -----------
  const businessKey = keypair(accounts.business);
  const businessSession = await signIn(api, businessKey);
  const business = await organizationWithKey(api, businessSession, 'Dev Business');
  const businessAccount = await registerAccount(api, business.apiKey, businessKey, 'Dev Business');
  const charge = await api.call<{ id: string; url: string }>(
    'POST',
    '/v1/p2p/charges',
    business.apiKey,
    {
      network,
      token,
      currency: 'ARS',
      fiatAmount: '25000',
      recipient: businessAccount.id,
      payeeName: 'Dev Business',
      description: 'A test charge',
      multiUse: true,
      expiresAt: new Date(Date.now() + 29 * 24 * 3600 * 1000).toISOString(),
    },
  );
  log('business seeded with a charge');

  // --- the user: an account the sponsor creates, then dev dollars -------------
  const userKey = keypair(accounts.user);
  const userSession = await signIn(api, userKey);
  const activation = await api.call<{ transaction: { xdr: string; network: string } | null }>(
    'POST',
    '/v1/app/activate',
    userSession,
    { network, token },
  );
  if (activation.transaction) {
    await signAndSubmit(api, userSession, 'app', activation.transaction, userKey, chain.passphrase);
  }
  const server = await rpcFor(chain.rpcUrl, chain.passphrase);
  await mintTusd(server, chain, accounts.issuer, accounts.user.publicKey, 5_000n * U);
  log('user activated by the sponsor and given 5 000 TUSD');

  return {
    merchant: { ...merchant, accountId: merchantAccount.id, address: merchantKey.publicKey() },
    business: { ...business, accountId: businessAccount.id, address: businessKey.publicKey() },
    user: { address: userKey.publicKey() },
    charge: { id: charge.id, url: charge.url },
  };
}

/** Refreshes the dev merchant's prices (each has a lifetime) after a restart. */
export async function refreshDevPrices(
  apiUrl: string,
  webOrigin: string,
  merchantKey: string,
): Promise<number> {
  const api = new DevApi(apiUrl, webOrigin);
  const list = await api.call<{ data: { id: string; price: string }[] }>(
    'GET',
    '/v1/p2p/offers?take=100',
    merchantKey,
  );
  for (const offer of list.data) {
    await api.call('PATCH', `/v1/p2p/offers/${offer.id}`, merchantKey, { price: offer.price });
  }
  return list.data.length;
}
