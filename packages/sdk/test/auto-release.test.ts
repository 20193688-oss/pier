import { Keypair, TransactionBuilder, type Transaction as StellarTx } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { handleTransfer, type BotContext } from '@/bot/auto-release';
import { parseTransferLine, readBotConfig } from '@/bot/config';
import { createReleaseSender, releaseProblem, type ReleaseSender } from '@/bot/release';
import { createPedospeClient } from '@/client';
import type { Transaction, TransferMatch } from '@/types';
import { MARKET, MERCHANT, PASSPHRASE, releaseXdr, transferMatch } from '@test/fixtures';

const API_KEY = 'pk_test_3kQ9x7Lm2Vb8';
const OTHER_CONTRACT = 'CAKGHC55HFGIGFDRKKLH7MYLVXE5ELAO57VE2VUCDXBWDVFNDIXXZTJ7';

describe('readBotConfig', () => {
  const env = {
    PEDOSPE_API_URL: 'https://api.pedospe.test',
    PEDOSPE_API_KEY: API_KEY,
    BOT_SECRET: MERCHANT.secret(),
  };

  it('reads the settings with their defaults', () => {
    expect(readBotConfig(env)).toEqual({
      apiUrl: env.PEDOSPE_API_URL,
      apiKey: API_KEY,
      secret: MERCHANT.secret(),
      minScore: 3,
      dryRun: false,
      marketContract: null,
    });
  });

  it('reads MIN_SCORE, DRY_RUN and MARKET_CONTRACT', () => {
    const config = readBotConfig({
      PEDOSPE_API_URL: env.PEDOSPE_API_URL,
      PEDOSPE_API_KEY: API_KEY,
      MIN_SCORE: '2',
      DRY_RUN: 'true',
      MARKET_CONTRACT: MARKET,
    });
    expect(config).toMatchObject({
      minScore: 2,
      dryRun: true,
      secret: null,
      marketContract: MARKET,
    });
  });

  it('requires the merchant’s secret unless it is a dry run', () => {
    expect(() =>
      readBotConfig({ PEDOSPE_API_URL: env.PEDOSPE_API_URL, PEDOSPE_API_KEY: API_KEY }),
    ).toThrow(/BOT_SECRET is required/);
  });

  it('lists every problem without echoing secret values', () => {
    let message = '';
    try {
      readBotConfig({
        PEDOSPE_API_URL: 'nope',
        PEDOSPE_API_KEY: 'sk_live_leaked',
        BOT_SECRET: 'Sdeadbeef-secret',
        MIN_SCORE: '5',
        MARKET_CONTRACT: '0x1234',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of [
      'PEDOSPE_API_URL',
      'PEDOSPE_API_KEY',
      'BOT_SECRET',
      'MIN_SCORE',
      'MARKET_CONTRACT',
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
  const options = { signer: MERCHANT.publicKey(), passphrase: PASSPHRASE };

  it('accepts exactly release(<the bot>, <on-chain id>) on the order contract, from the bot', () => {
    expect(releaseProblem(transferMatch('7', 3), options)).toBeNull();
    expect(
      releaseProblem(transferMatch('7', 3), { ...options, marketContract: MARKET }),
    ).toBeNull();
  });

  function tamper(transaction: Partial<Transaction>): TransferMatch {
    const match = transferMatch('7', 3);
    return { ...match, transaction: { ...match.transaction, ...transaction } };
  }

  it('refuses any other call, source, contract or network', () => {
    expect(releaseProblem(tamper({ xdr: releaseXdr('8') }), options)).toMatch(/release\(/);
    expect(releaseProblem(tamper({ xdr: releaseXdr('7', { fn: 'withdraw' }) }), options)).toMatch(
      /not release/,
    );
    const stranger = Keypair.random().publicKey();
    expect(releaseProblem(tamper({ xdr: releaseXdr('7', { caller: stranger }) }), options)).toMatch(
      /not release/,
    );
    expect(releaseProblem(tamper({ xdr: releaseXdr('7', { source: stranger }) }), options)).toMatch(
      /source/,
    );
    expect(
      releaseProblem(tamper({ xdr: releaseXdr('7', { contract: OTHER_CONTRACT }) }), options),
    ).toMatch(/not the order's contract/);
    expect(releaseProblem(tamper({ network: 'mainnet' }), options)).toMatch(/mainnet/);
    expect(releaseProblem(tamper({ xdr: 'not xdr' }), options)).toMatch(/envelope/);
    expect(
      releaseProblem(transferMatch('7', 3), { ...options, marketContract: OTHER_CONTRACT }),
    ).toMatch(/MARKET_CONTRACT/);
    expect(releaseProblem(transferMatch('7', 3, { onchainId: null }), options)).toMatch(
      /on-chain id/,
    );
  });
});

describe('createReleaseSender', () => {
  it('signs with the merchant’s key and submits through /v1/p2p/submit, then polls', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const client = createPedospeClient({
      baseUrl: 'https://api.pedospe.test',
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
    const client = createPedospeClient({
      baseUrl: 'https://api.pedospe.test',
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
      marketContract: null,
      passphrases: { testnet: PASSPHRASE },
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
    expect(bodies).toEqual([transfer]);
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
