import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { DEV_CHAIN_ID } from '@/chain/networks';
import { devSend, devWallet, type DevWallet, type LocalDeployment } from '@/dev/local-chain';

/**
 * Seeds a local market THROUGH THE API, the way a real merchant and a real
 * business would set themselves up: SIWE sign-in, an organization each, a
 * test API key, wallets registered with their signature, payment methods,
 * offers, liquidity deposited and the matcher authorised with transactions
 * the API built and the dev wallets signed, and a charge.
 */

export interface SeedResult {
  merchant: { organizationId: string; apiKey: string; accountId: string; address: string };
  business: { organizationId: string; apiKey: string; accountId: string; address: string };
  charge: { id: string; url: string };
}

class Api {
  constructor(
    private readonly base: string,
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

/** Signs in a wallet with SIWE; answers its session token. */
export async function signIn(api: Api, wallet: DevWallet, domain: string): Promise<string> {
  const { nonce } = await api.call<{ nonce: string }>('POST', '/v1/auth/nonce', null);
  const message = createSiweMessage({
    domain,
    address: wallet.address,
    statement: 'Sign in to pedospe.',
    uri: `http://${domain}`,
    version: '1',
    chainId: DEV_CHAIN_ID,
    nonce,
    issuedAt: new Date(),
  });
  const signature = await privateKeyToAccount(wallet.privateKey).signMessage({ message });
  const session = await api.call<{ token: string }>('POST', '/v1/auth/verify', null, {
    message,
    signature,
  });
  return session.token;
}

async function registerWallet(api: Api, key: string, wallet: DevWallet, displayName: string) {
  const { message } = await api.call<{ message: string }>(
    'POST',
    '/v1/p2p/accounts/challenge',
    key,
    {
      address: wallet.address,
    },
  );
  const signature = await privateKeyToAccount(wallet.privateKey).signMessage({ message });
  return api.call<{ id: string; address: string }>('POST', '/v1/p2p/accounts', key, {
    address: wallet.address,
    signature,
    displayName,
    label: `${displayName} dev wallet`,
  });
}

async function organizationWithKey(api: Api, session: string, name: string) {
  const org = await api.call<{ id: string }>('POST', '/v1/organizations', session, { name });
  const key = await api.call<{ key: string }>(
    'POST',
    `/v1/organizations/${org.id}/api-keys`,
    session,
    {
      name: `${name} dev key`,
      tier: 'test',
      scopes: ['p2p:read', 'p2p:write'],
    },
  );
  return { organizationId: org.id, apiKey: key.key };
}

async function signBuilt(
  api: Api,
  rpcUrl: string,
  key: string,
  wallet: DevWallet,
  body: unknown,
): Promise<void> {
  const tx = await api.call<{ to: Hex; data: Hex }>('POST', '/v1/p2p/transactions', key, body);
  await devSend(rpcUrl, wallet.privateKey, tx);
}

export async function seedDevMarket(input: {
  apiUrl: string;
  rpcUrl: string;
  siweDomain: string;
  webOrigin: string;
  checkoutUrl: string;
  deployment: LocalDeployment;
}): Promise<SeedResult> {
  const api = new Api(input.apiUrl, input.webOrigin);
  const token = input.deployment.tokenSymbol;
  const U = 10n ** BigInt(input.deployment.tokenDecimals);

  // --- the merchant: sells and buys tokens against ARS and BRL ---------------
  const merchantWallet = devWallet('merchant');
  const merchantSession = await signIn(api, merchantWallet, input.siweDomain);
  const merchant = await organizationWithKey(api, merchantSession, 'Dev Merchant');
  const merchantAccount = await registerWallet(
    api,
    merchant.apiKey,
    merchantWallet,
    'Pampa Cambio',
  );
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
  ];
  for (const offer of offers) {
    await api.call('POST', '/v1/p2p/offers', merchant.apiKey, {
      accountId: merchantAccount.id,
      network: 'local',
      token,
      priceTtlSeconds: 24 * 60 * 60,
      ...offer,
    });
  }
  const liquidity = 100_000n * U;
  const base = { network: 'local', from: merchantAccount.id };
  await signBuilt(api, input.rpcUrl, merchant.apiKey, merchantWallet, {
    ...base,
    action: 'approve',
    args: { token, amount: liquidity.toString() },
  });
  await signBuilt(api, input.rpcUrl, merchant.apiKey, merchantWallet, {
    ...base,
    action: 'deposit',
    args: { token, amount: liquidity.toString() },
  });
  await signBuilt(api, input.rpcUrl, merchant.apiKey, merchantWallet, {
    ...base,
    action: 'setMatcher',
    args: { maxPerOrder: (5_000n * U).toString(), autoSettle: false },
  });

  // --- the business: integrates buy/sell and collects with charges -----------
  const businessWallet = devWallet('business');
  const businessSession = await signIn(api, businessWallet, input.siweDomain);
  const business = await organizationWithKey(api, businessSession, 'Dev Business');
  const businessAccount = await registerWallet(
    api,
    business.apiKey,
    businessWallet,
    'Dev Business',
  );
  const charge = await api.call<{ id: string; url: string }>(
    'POST',
    '/v1/p2p/charges',
    business.apiKey,
    {
      network: 'local',
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

  return {
    merchant: { ...merchant, accountId: merchantAccount.id, address: merchantWallet.address },
    business: { ...business, accountId: businessAccount.id, address: businessWallet.address },
    charge: { id: charge.id, url: charge.url },
  };
}

/** Refreshes the dev merchant's prices (each has a lifetime) after a restart. */
export async function refreshDevPrices(
  apiUrl: string,
  webOrigin: string,
  merchantKey: string,
): Promise<number> {
  const api = new Api(apiUrl, webOrigin);
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

export { Api as DevApi };
