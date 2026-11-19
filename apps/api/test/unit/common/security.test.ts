import { describe, expect, it } from 'vitest';
import { clientSubject } from '@/common/client-ip';
import { DataCipher } from '@/common/data-cipher';
import { ConfigError, loadConfig, parseKey, type AppConfig } from '@/config/env';
import { destinationProblem, isPublicAddress } from '@/webhooks/ssrf';
import { signatureHeader, verifySignatureHeader } from '@/webhooks/webhook-signature';

const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  DATA_ENCRYPTION_KEY: 'ab'.repeat(32),
};
const MATCHER = `0x${'59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'}`;

function problems(env: Record<string, string>): string[] {
  try {
    loadConfig({ ...BASE, ...env });
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
}

describe('configuration', () => {
  it('boots with the minimum and defaults the rest', () => {
    const config = loadConfig(BASE);
    expect(config.port).toBe(4000);
    expect(config.cookieSecure).toBe(false);
    expect(config.p2p.matcherPrivateKey).toBeNull();
    expect(config.app.tier).toBe('live');
  });

  it('refuses dev-only switches and the local chain in production', () => {
    const found = problems({
      NODE_ENV: 'production',
      DEV_TOOLS: 'true',
      WEBHOOKS_ALLOW_INSECURE: 'true',
      P2P_CONTRACTS_TEST: JSON.stringify({ local: '0x5FbDB2315678afecb367f032d93F642f64180aa3' }),
      P2P_LOCAL_TOKENS: JSON.stringify([
        { symbol: 'tUSD', address: '0x5FbDB2315678afecb367f032d93F642f64180aa3', decimals: 6 },
      ]),
      P2P_MATCHER_PRIVATE_KEY: MATCHER,
    });
    expect(found).toEqual(
      expect.arrayContaining([
        'DEV_TOOLS: refused in production',
        'WEBHOOKS_ALLOW_INSECURE: refused in production',
        'P2P_CONTRACTS_TEST: the local dev chain is refused in production',
      ]),
    );
  });

  it('needs a matcher key once a contract is configured, a node on mainnet, and known networks', () => {
    expect(
      problems({
        P2P_CONTRACTS_LIVE: JSON.stringify({ base: '0x5FbDB2315678afecb367f032d93F642f64180aa3' }),
      }),
    ).toEqual(
      expect.arrayContaining([
        'P2P_RPC_URLS_LIVE: base needs a node (no public default on live)',
        'P2P_MATCHER_PRIVATE_KEY: required once a P2P contract is configured',
      ]),
    );
    expect(
      problems({
        P2P_CONTRACTS_TEST: JSON.stringify({
          solana: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        }),
        P2P_MATCHER_PRIVATE_KEY: MATCHER,
      }),
    ).toContain('P2P_CONTRACTS_TEST: solana is not a network id');
  });

  it('refuses a matcher key equal to the data key, and the matcher among the dev keys', () => {
    expect(problems({ P2P_MATCHER_PRIVATE_KEY: `0x${'ab'.repeat(32)}` })).toContain(
      'P2P_MATCHER_PRIVATE_KEY: must not equal DATA_ENCRYPTION_KEY',
    );
    expect(
      problems({ P2P_MATCHER_PRIVATE_KEY: MATCHER, DEV_TOOLS: 'true', DEV_WALLET_KEYS: MATCHER }),
    ).toContain('DEV_WALLET_KEYS: must not include the matcher key');
  });

  it('reads a 32-byte key as hex or base64, and nothing shorter', () => {
    expect(parseKey('ab'.repeat(32))?.length).toBe(32);
    expect(parseKey(`0x${'ab'.repeat(32)}`)?.length).toBe(32);
    expect(parseKey(Buffer.alloc(32, 7).toString('base64'))?.length).toBe(32);
    expect(parseKey('ab'.repeat(16))).toBeNull();
    expect(problems({ DATA_ENCRYPTION_KEY: 'short' })).toHaveLength(1);
  });
});

describe('data at rest', () => {
  const cipher = new DataCipher({ dataEncryptionKey: Buffer.alloc(32, 1) } as AppConfig);

  it('seals and opens a value bound to its row and field', () => {
    const sealed = cipher.seal('order.payer', 'row-1', { name: 'Ana' });
    expect(sealed).toMatch(/^v1:[0-9a-f]{8}:/);
    expect(sealed).not.toContain('Ana');
    expect(cipher.open('order.payer', 'row-1', sealed)).toEqual({ name: 'Ana' });
  });

  it('refuses a value moved to another row or field, or tampered with', () => {
    const sealed = cipher.seal('order.payer', 'row-1', { name: 'Ana' });
    expect(() => cipher.open('order.payer', 'row-2', sealed)).toThrow();
    expect(() => cipher.open('order.beneficiary', 'row-1', sealed)).toThrow();
    const parts = sealed.split(':');
    parts[3] = `${parts[3].slice(0, -2)}AA`;
    expect(() => cipher.open('order.payer', 'row-1', parts.join(':'))).toThrow();
    expect(() => cipher.open('order.payer', 'row-1', 'plain text')).toThrow();
  });

  it('refuses a value sealed under another key', () => {
    const other = new DataCipher({ dataEncryptionKey: Buffer.alloc(32, 2) } as AppConfig);
    expect(() =>
      cipher.open('order.payer', 'row-1', other.seal('order.payer', 'row-1', 1)),
    ).toThrow(/another key/);
  });
});

describe('webhook destinations (SSRF)', () => {
  it('knows public from private, loopback, link-local and mapped addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
      expect(isPublicAddress(ip)).toBe(true);
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '64:ff9b::7f00:1',
      'not-an-ip',
    ]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });

  it('refuses http, credentials, private literals and local names unless allowed in development', () => {
    const strict = { allowInsecure: false };
    expect(destinationProblem('https://hooks.example.com/x', strict)).toBeNull();
    expect(destinationProblem('http://hooks.example.com/x', strict)).toBe('url must use https');
    expect(destinationProblem('https://u:p@hooks.example.com/x', strict)).toBe(
      'url must not carry credentials',
    );
    expect(destinationProblem('https://127.0.0.1/x', strict)).toBe(
      'url must point to a public address',
    );
    expect(destinationProblem('https://[::1]/x', strict)).toBe(
      'url must point to a public address',
    );
    expect(destinationProblem('https://localhost/x', strict)).toBe(
      'url must point to a public host',
    );
    expect(destinationProblem('https://metadata.internal/x', strict)).toBe(
      'url must point to a public host',
    );
    expect(destinationProblem('ftp://x', strict)).toBe('url must use https');
    expect(destinationProblem('http://127.0.0.1:8080/x', { allowInsecure: true })).toBeNull();
  });
});

describe('webhook signatures', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'P2P_ORDER_PAID' });
  const t = 1_800_000_000;

  it('verifies its own signature within the tolerance', () => {
    const header = signatureHeader('whsec_a', body, t);
    expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(verifySignatureHeader(header, body, 'whsec_a', t + 100)).toBe(true);
  });

  it('refuses another body, another secret, a stale timestamp and a malformed header', () => {
    const header = signatureHeader('whsec_a', body, t);
    expect(verifySignatureHeader(header, `${body} `, 'whsec_a', t)).toBe(false);
    expect(verifySignatureHeader(header, body, 'whsec_b', t)).toBe(false);
    expect(verifySignatureHeader(header, body, 'whsec_a', t + 301)).toBe(false);
    expect(verifySignatureHeader('t=abc,v1=zz', body, 'whsec_a', t)).toBe(false);
    expect(verifySignatureHeader('', body, 'whsec_a', t)).toBe(false);
  });
});

describe('keyless client subjects', () => {
  it('keeps IPv4 addresses and groups IPv6 by /48', () => {
    expect(clientSubject('203.0.113.7')).toBe('v4:203.0.113.7');
    expect(clientSubject('::ffff:203.0.113.7')).toBe('v4:203.0.113.7');
    expect(clientSubject('2001:db8:abcd:1::5')).toBe('v6:2001:db8:abcd::/48');
    expect(clientSubject('2001:db8:abcd:ffff::9')).toBe(clientSubject('2001:db8:abcd:1::5'));
    expect(clientSubject('2001:db8::1')).toBe('v6:2001:db8:0::/48');
  });
});
