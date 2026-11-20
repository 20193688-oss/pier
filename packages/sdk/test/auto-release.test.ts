import { Keypair, TransactionBuilder, type Transaction as StellarTx } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { handleTransfer, type BotContext } from '@/bot/auto-release';
import { parseTransferLine, readBotConfig } from '@/bot/config';
import {
  createReleaseSender,
  releaseProblem,
  type ReleaseCheck,
  type ReleaseSender,
} from '@/bot/release';
import { createMidpointClient } from '@/client';
import type { Transaction, TransferMatch } from '@/types';
import {
  MARKET,
  MERCHANT,
  PASSPHRASE,
  releaseXdr,
  transferMatch,
  type ReleaseOptions,
} from '@test/fixtures';

const API_KEY = 'pk_test_3kQ9x7Lm2Vb8';
const OTHER_CONTRACT = 'CAKGHC55HFGIGFDRKKLH7MYLVXE5ELAO57VE2VUCDXBWDVFNDIXXZTJ7';

describe('readBotConfig', () => {
  const env = {
    MIDPOINT_API_URL: 'https://api.midpoint.test',
    MIDPOINT_API_KEY: API_KEY,
    BOT_SECRET: MERCHANT.secret(),
    MARKET_CONTRACT: MARKET,
  };

  it('reads the settings with their defaults; a bare contract is the tier’s network', () => {
    expect(readBotConfig(env)).toEqual({
      apiUrl: env.MIDPOINT_API_URL,
      apiKey: API_KEY,
      secret: MERCHANT.secret(),
      minScore: 3,
      dryRun: false,
      tier: 'test',
      marketContracts: { testnet: MARKET },
      maxFeeStroops: 1_000_000,
    });
  });

  it('reads MIN_SCORE, DRY_RUN, MAX_FEE_STROOPS and per-network contracts', () => {
    const config = readBotConfig({
      MIDPOINT_API_URL: env.MIDPOINT_API_URL,
      MIDPOINT_API_KEY: API_KEY,
      MIN_SCORE: '2',
      DRY_RUN: 'true',
      MAX_FEE_STROOPS: '500000',
      MARKET_CONTRACT: `testnet=${MARKET},local=${OTHER_CONTRACT}`,
    });
    expect(config).toMatchObject({
      minScore: 2,
      dryRun: true,
      secret: null,
      maxFeeStroops: 500_000,
      marketContracts: { testnet: MARKET, local: OTHER_CONTRACT },
    });
  });

  it('requires the secret (unless a dry run) and the market contract', () => {
    expect(() =>
      readBotConfig({ MIDPOINT_API_URL: env.MIDPOINT_API_URL, MIDPOINT_API_KEY: API_KEY }),
    ).toThrow(/BOT_SECRET is required[\s\S]*MARKET_CONTRACT is required/);
  });

  it('refuses mainnet with a test key, and testnet with a live key', () => {
    expect(() => readBotConfig({ ...env, MARKET_CONTRACT: `mainnet=${MARKET}` })).toThrow(
      /test API key never signs/,
    );
    expect(() =>
      readBotConfig({
        ...env,
        MIDPOINT_API_KEY: 'pk_live_x',
        MARKET_CONTRACT: `testnet=${MARKET}`,
      }),
    ).toThrow(/live API key never signs/);
    expect(
      readBotConfig({ ...env, MIDPOINT_API_KEY: 'pk_live_x', MARKET_CONTRACT: MARKET })
        .marketContracts,
    ).toEqual({ mainnet: MARKET });
  });

  it('lists every problem without echoing secret values', () => {
    let message = '';
    try {
      readBotConfig({
        MIDPOINT_API_URL: 'nope',
        MIDPOINT_API_KEY: 'sk_live_leaked',
        BOT_SECRET: 'Sdeadbeef-secret',
        MIN_SCORE: '5',
        MARKET_CONTRACT: '0x1234',
        MAX_FEE_STROOPS: '1',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of [
      'MIDPOINT_API_URL',
      'MIDPOINT_API_KEY',
      'BOT_SECRET',
      'MIN_SCORE',
      'MARKET_CONTRACT',
      'MAX_FEE_STROOPS',
    ]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain('sk_live_leaked');
    expect(message).not.toContain('deadbeef');
    expect(() => readBotConfig({ ...env, DRY_RUN: 'maybe' })).toThrow(/DRY_RUN/);
  });
});

describe('parseTransferLine', () => {
  it('keeps the transfer fields and drops unknown keys', () => {
    const line = JSON.stringify({
      currency: 'ARS',
      amount: '125050.00',
      payerName: 'Juan Gómez',
      payerDocument: '20123456786',
      reference: 'TRX-88213',
      receivedAt: '2026-11-19T12:12:40.000Z',
      bankInternalId: 991,
    });
    expect(parseTransferLine(line)).toEqual({
      currency: 'ARS',
      amount: '125050.00',
      payerName: 'Juan Gómez',
      payerDocument: '20123456786',
      reference: 'TRX-88213',
      receivedAt: '2026-11-19T12:12:40.000Z',
    });
  });

  it('accepts a numeric amount and null optional fields', () => {
    expect(parseTransferLine('{"currency":"BRL","amount":250.5,"payerName":null}')).toEqual({
      currency: 'BRL',
      amount: '250.5',
    });
  });

  it('rejects lines that are not transfers', () => {
    for (const line of [
      'nope',
      '[]',
      '{"amount":"1"}',
      '{"currency":"ARS"}',
      '{"currency":"ARS","amount":"1","reference":7}',
    ]) {
      expect(() => parseTransferLine(line), line).toThrow();
    }
  });
});

describe('releaseProblem', () => {
  const check: ReleaseCheck = {
    signer: MERCHANT.publicKey(),
    network: 'testnet',
    tier: 'test',
    marketContracts: { testnet: MARKET },
    maxFeeStroops: 1_000_000,
  };
  const with_ = (options: ReleaseOptions, order: Parameters<typeof transferMatch>[2] = {}) => {
    const match = transferMatch('7', 3, order);
    return { ...match, transaction: { ...match.transaction, xdr: releaseXdr('7', options) } };
  };
  const problem = (match: TransferMatch, overrides: Partial<ReleaseCheck> = {}) =>
    releaseProblem(match, { ...check, ...overrides });

  it('accepts exactly release(<the bot>, <on-chain id>) on its own contract', () => {
    expect(problem(transferMatch('7', 3))).toBeNull();
    expect(problem(with_({ auth: 'self' }))).toBeNull();
  });

  it('pins the contract to the bot’s own configuration, never the order’s', () => {
    // The API says the order lives on its contract, and builds the call there: refused.
    expect(problem(with_({ contract: OTHER_CONTRACT }, { contract: OTHER_CONTRACT }))).toMatch(
      /not MARKET_CONTRACT/,
    );
    expect(problem(transferMatch('7', 3), { marketContracts: {} })).toMatch(/names no contract/);
  });

  it('refuses another function, caller, id, source or operation count', () => {
    expect(problem(with_({ fn: 'withdraw' }))).toMatch(/not release/);
    expect(problem(with_({ caller: Keypair.random().publicKey() }))).toMatch(/not release/);
    const otherId = transferMatch('7', 3);
    otherId.transaction.xdr = releaseXdr('8');
    expect(problem(otherId)).toMatch(/not release/);
    expect(problem(with_({ source: Keypair.random().publicKey() }))).toMatch(/source/);
    expect(problem(with_({ extraOp: true }))).toMatch(/exactly one operation/);
  });

  it('refuses an auth tree other than one source-account entry for the same call', () => {
    expect(problem(with_({ auth: 'sub' }))).toMatch(/sub-invocations/);
    expect(problem(with_({ auth: 'two' }))).toMatch(/more than one/);
    expect(problem(with_({ auth: 'address' }))).toMatch(/source account/);
  });

  it('refuses a fee above the cap, a far or missing deadline, preconditions and a memo', () => {
    expect(problem(with_({ fee: '2000000' }))).toMatch(/above the cap/);
    expect(problem(with_({ timeoutSeconds: 3600 }))).toMatch(/expire within/);
    expect(problem(with_({ timeoutSeconds: 0 }))).toMatch(/expire within/);
    expect(problem(with_({ minSequence: '1' }))).toMatch(/preconditions/);
    expect(problem(with_({ memo: 'x' }))).toMatch(/memo/);
  });

  it('pins the passphrase and the network, and keeps a test key off mainnet', () => {
    expect(problem(transferMatch('7', 3), { network: 'futurenet' })).toMatch(/does not sign/);
    expect(problem(transferMatch('7', 3), { network: 'mainnet' })).toMatch(/never signs/);
    const elsewhere = transferMatch('7', 3);
    elsewhere.transaction = { ...elsewhere.transaction, network: 'local' };
    expect(problem(elsewhere)).toMatch(/not on testnet/);
    expect(
      problem({
        ...transferMatch('7', 3),
        transaction: { ...transferMatch('7', 3).transaction, xdr: 'nope' },
      }),
    ).toMatch(/not an envelope/);
    expect(problem(transferMatch('7', 3, { onchainId: null }))).toMatch(/on-chain id/);
  });
});

describe('createReleaseSender', () => {
  it('signs with the merchant’s key and submits through /v1/p2p/submit, then polls', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const client = createMidpointClient({
      baseUrl: 'https://api.midpoint.test',
      apiKey: API_KEY,
      fetch: async (request) => {
        const body = request.method === 'POST' ? await request.json() : null;
        calls.push({ url: `${request.method} ${new URL(request.url).pathname}`, body });
        const status = calls.length === 1 ? 'PENDING' : 'SUCCESS';
        return new Response(
          JSON.stringify({
            hash: 'ab'.repeat(32),
            network: 'testnet',
            status,
            error: null,
            feeBumpHash: null,
            ledger: 9,
            sponsored: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const sender = createReleaseSender({ secret: MERCHANT.secret(), client, pollMs: 1 });
    expect(sender.address).toBe(MERCHANT.publicKey());
    const { transaction } = transferMatch('7', 3);
    expect(await sender.send(transaction, PASSPHRASE)).toMatchObject({ status: 'success' });
    expect(calls.map((c) => c.url)).toEqual([
      'POST /v1/p2p/submit',
      `GET /v1/p2p/submissions/${'ab'.repeat(32)}`,
    ]);
    const submitted = calls[0].body as { xdr: string; network: string };
    expect(submitted.network).toBe('testnet');
    const signed = TransactionBuilder.fromXDR(submitted.xdr, PASSPHRASE) as StellarTx;
    expect(signed.signatures).toHaveLength(1);
    const { signature } = signed.signatures[0] as unknown as {
      signature: { value?: Uint8Array } & Uint8Array;
    };
    expect(
      MERCHANT.verify(Buffer.from(signed.hash()), Buffer.from(signature.value ?? signature)),
    ).toBe(true);
  });
});

describe('handleTransfer', () => {
  function context(matches: TransferMatch[], sender: ReleaseSender | null) {
    const bodies: unknown[] = [];
    const client = createMidpointClient({
      baseUrl: 'https://api.midpoint.test',
      apiKey: API_KEY,
      fetch: async (request) => {
        bodies.push(await request.json());
        return new Response(JSON.stringify({ data: matches }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const ctx: BotContext = {
      client,
      minScore: 3,
      sender,
      tier: 'test',
      marketContracts: { testnet: MARKET },
      maxFeeStroops: 1_000_000,
      released: new Set(),
    };
    return { ctx, bodies };
  }

  function recordingSender(status: 'success' | 'reverted' = 'success') {
    const sent: Transaction[] = [];
    const sender: ReleaseSender = {
      address: MERCHANT.publicKey(),
      async send(transaction) {
        sent.push(transaction);
        return { hash: 'abc', status };
      },
    };
    return { sender, sent };
  }

  const transfer = { currency: 'ARS' as const, amount: '125050.00', payerName: 'Juan Gómez' };

  it('forwards the transfer and releases the single full match', async () => {
    const { sender, sent } = recordingSender();
    const match = transferMatch('7', 3);
    const { ctx, bodies } = context([match, transferMatch('8', 1)], sender);

    expect(await handleTransfer(transfer, ctx)).toEqual({
      status: 'released',
      orderId: 'order-7',
      hash: 'abc',
    });
    expect(bodies).toEqual([{ ...transfer, signer: MERCHANT.publicKey() }]);
    expect(sent).toEqual([match.transaction]);
    expect(ctx.released.has('order-7')).toBe(true);
  });

  it('does not release the same order twice in a run', async () => {
    const { sender, sent } = recordingSender();
    const { ctx } = context([transferMatch('7', 3)], sender);
    await handleTransfer(transfer, ctx);
    expect(await handleTransfer(transfer, ctx)).toMatchObject({
      status: 'skipped',
      reason: 'no_matches',
    });
    expect(sent).toHaveLength(1);
  });

  it('skips an ambiguous transfer without signing', async () => {
    const { sender, sent } = recordingSender();
    const { ctx } = context([transferMatch('7', 3), transferMatch('8', 3)], sender);
    expect(await handleTransfer(transfer, ctx)).toEqual({
      status: 'skipped',
      reason: 'ambiguous',
      bestScore: 3,
      candidates: ['order-7', 'order-8'],
    });
    expect(sent).toHaveLength(0);
  });

  it('refuses a transaction that is not the release', async () => {
    const { sender, sent } = recordingSender();
    const match = transferMatch('7', 3);
    match.transaction.xdr = releaseXdr('99');
    const { ctx } = context([match], sender);
    expect(await handleTransfer(transfer, ctx)).toMatchObject({
      status: 'refused',
      orderId: 'order-7',
    });
    expect(sent).toHaveLength(0);
  });

  it('only decides in a dry run', async () => {
    const { ctx } = context([transferMatch('7', 3)], null);
    expect(await handleTransfer(transfer, ctx)).toEqual({
      status: 'dry_run',
      orderId: 'order-7',
      score: 3,
      description: 'Release order 7: pays its buyer 99.5 USDC',
    });
  });

  it('reports a reverted release and keeps the order eligible', async () => {
    const { sender } = recordingSender('reverted');
    const { ctx } = context([transferMatch('7', 3)], sender);
    expect(await handleTransfer(transfer, ctx)).toMatchObject({ status: 'reverted' });
    expect(ctx.released.size).toBe(0);
  });
});
