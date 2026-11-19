import { custom } from 'viem';
import { describe, expect, it } from 'vitest';
import { handleTransfer, type BotContext } from '@/bot/auto-release';
import { parseTransferLine, readBotConfig } from '@/bot/config';
import {
  ChainMismatchError,
  createReleaseSender,
  releaseProblem,
  type ReleaseSender,
} from '@/bot/release';
import { createPedospeClient } from '@/client';
import type { Transaction, TransferMatch } from '@/types';
import { MARKET, releaseData, transferMatch } from '@test/fixtures';

// Anvil's well-known first development key: never a real secret.
const BOT_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const API_KEY = 'pk_test_3kQ9x7Lm2Vb8';

describe('readBotConfig', () => {
  const env = {
    PEDOSPE_API_URL: 'https://api.pedospe.test',
    PEDOSPE_API_KEY: API_KEY,
    BOT_PRIVATE_KEY: BOT_KEY,
    RPC_URL: 'https://rpc.example/v3/provider-key',
  };

  it('reads the settings with their defaults', () => {
    expect(readBotConfig(env)).toEqual({
      apiUrl: env.PEDOSPE_API_URL,
      apiKey: API_KEY,
      privateKey: BOT_KEY,
      rpcUrl: env.RPC_URL,
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
      privateKey: null,
      rpcUrl: null,
      marketContract: MARKET,
    });
  });

  it('requires a signing key and a node unless it is a dry run', () => {
    expect(() =>
      readBotConfig({ PEDOSPE_API_URL: env.PEDOSPE_API_URL, PEDOSPE_API_KEY: API_KEY }),
    ).toThrow(/BOT_PRIVATE_KEY is required[\s\S]*RPC_URL is required/);
  });

  it('lists every problem without echoing secret values', () => {
    let message = '';
    try {
      readBotConfig({
        PEDOSPE_API_URL: 'nope',
        PEDOSPE_API_KEY: 'sk_live_leaked',
        BOT_PRIVATE_KEY: '0xdeadbeef-secret',
        RPC_URL: env.RPC_URL,
        MIN_SCORE: '5',
        MARKET_CONTRACT: '0x1234',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of [
      'PEDOSPE_API_URL',
      'PEDOSPE_API_KEY',
      'BOT_PRIVATE_KEY',
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
  it('accepts exactly release(<on-chain id>) on the order contract with no value', () => {
    expect(releaseProblem(transferMatch('7', 3))).toBeNull();
    expect(releaseProblem(transferMatch('7', 3), { marketContract: MARKET })).toBeNull();
  });

  function tamper(transaction: Partial<Transaction>): TransferMatch {
    const match = transferMatch('7', 3);
    return { ...match, transaction: { ...match.transaction, ...transaction } };
  }

  it('refuses any other call', () => {
    expect(releaseProblem(tamper({ data: releaseData('8') }))).toMatch(/release\(7\)/);
    // transfer(address,uint256): the selector of a token transfer.
    expect(releaseProblem(tamper({ data: '0xa9059cbb' }))).toMatch(/calldata/);
    expect(releaseProblem(tamper({ to: '0x000000000000000000000000000000000000dEaD' }))).toMatch(
      /not the order's contract/,
    );
    expect(releaseProblem(tamper({ value: '1' }))).toMatch(/value/);
    expect(releaseProblem(tamper({ chainId: 1 }))).toMatch(/chain 1/);
    expect(releaseProblem(tamper({ to: 'not-an-address' }))).toMatch(/invalid/);
    expect(
      releaseProblem(transferMatch('7', 3), {
        marketContract: '0x000000000000000000000000000000000000dEaD',
      }),
    ).toMatch(/MARKET_CONTRACT/);
    expect(releaseProblem(transferMatch('7', 3, { onchainId: null }))).toMatch(/on-chain id/);
  });
});

describe('createReleaseSender', () => {
  it('refuses to send when the node is on another chain', async () => {
    const methods: string[] = [];
    const transport = custom({
      async request({ method }: { method: string }) {
        methods.push(method);
        if (method === 'eth_chainId') return '0x1';
        throw new Error(`unexpected ${method}`);
      },
    });
    const sender = createReleaseSender({
      privateKey: BOT_KEY,
      rpcUrl: 'http://127.0.0.1:8545',
      transport,
    });
    expect(sender.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    const { transaction } = transferMatch('7', 3);
    await expect(sender.send(transaction)).rejects.toBeInstanceOf(ChainMismatchError);
    expect(methods).toEqual(['eth_chainId']);
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
      released: new Set(),
    };
    return { ctx, bodies };
  }

  function recordingSender(status: 'success' | 'reverted' = 'success') {
    const sent: Transaction[] = [];
    const sender: ReleaseSender = {
      address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      async send(transaction) {
        sent.push(transaction);
        return { hash: '0xabc', status };
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
      hash: '0xabc',
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
    match.transaction.data = releaseData('99');
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
