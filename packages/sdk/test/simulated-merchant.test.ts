import { describe, expect, it } from 'vitest';
import { orderActionProblem, releaseProblem, type ReleaseSender } from '@/bot/release';
import { RECEIPT_MESSAGE } from '@/bot/receipt';
import {
  answerChats,
  chatReply,
  nextStep,
  readSimulatedMerchantConfig,
  replyStep,
  tick,
  type SimulatedMerchantContext,
} from '@/bot/simulated-merchant';
import { createMidpointClient } from '@/client';
import type { MerchantOrder, OrderMessage, Transaction } from '@/types';
import { MARKET, MERCHANT, releaseXdr, transferMatch } from '@test/fixtures';

const API_KEY = 'pk_test_3kQ9x7Lm2Vb8';
const DELAYS = { paySeconds: 5, releaseSeconds: 5 };
// Now: the API-built envelopes in these tests expire 5 minutes from the real clock.
const T0 = Date.now();

/** A merchant's order as the API lists it. */
function order(onchainId: string, overrides: Partial<MerchantOrder> = {}): MerchantOrder {
  return transferMatch(onchainId, 3, overrides).order;
}

const sale = (id: string, status: string) =>
  order(id, {
    kind: 'SELL',
    merchantSide: 'buyer',
    status: status as MerchantOrder['status'],
    buyerAddress: MERCHANT.publicKey(),
    sellerAddress: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ',
  });

describe('nextStep', () => {
  it('accepts a sale or a QR payment at once', () => {
    expect(nextStep(sale('1', 'awaiting_acceptance'), T0, T0, DELAYS)).toEqual({
      kind: 'act',
      action: 'accept',
      fn: 'accept',
    });
    const qr = order('2', { kind: 'QR_PAY', merchantSide: 'buyer', status: 'awaiting_acceptance' });
    expect(nextStep(qr, T0, T0, DELAYS)).toMatchObject({ action: 'accept' });
  });

  it('marks an accepted sale paid after the pay delay', () => {
    const accepted = sale('1', 'awaiting_payment');
    expect(nextStep(accepted, T0 + 4_000, T0, DELAYS)).toEqual({ kind: 'wait', until: T0 + 5_000 });
    expect(nextStep(accepted, T0 + 5_000, T0, DELAYS)).toEqual({
      kind: 'act',
      action: 'markPaid',
      fn: 'mark_paid',
    });
  });

  it('releases a purchase the payer reported paid, after the release delay', () => {
    const paid = order('3', { status: 'paid', paidAt: new Date(T0).toISOString() });
    expect(nextStep(paid, T0 + 1_000, T0 + 1_000, DELAYS)).toEqual({
      kind: 'wait',
      until: T0 + 5_000,
    });
    expect(nextStep(paid, T0 + 5_000, T0 + 1_000, DELAYS)).toMatchObject({ action: 'release' });
  });

  it('never releases an unpaid purchase, and waits for the on-chain id', () => {
    expect(nextStep(order('4', { status: 'awaiting_payment' }), T0, T0, DELAYS)).toEqual({
      kind: 'none',
    });
    expect(nextStep(sale('5', 'paid'), T0 + 60_000, T0, DELAYS)).toEqual({ kind: 'none' });
    const unindexed = { ...sale('6', 'awaiting_acceptance'), onchainId: null };
    expect(nextStep(unindexed, T0, T0, DELAYS)).toEqual({ kind: 'none' });
  });
});

describe('orderActionProblem', () => {
  const check = {
    signer: MERCHANT.publicKey(),
    network: 'testnet',
    tier: 'test' as const,
    marketContracts: { testnet: MARKET },
    maxFeeStroops: 1_000_000,
  };
  const subject = (fn: string) => ({
    order: { network: 'testnet', onchainId: '7' },
    transaction: {
      ...transferMatch('7', 3).transaction,
      xdr: releaseXdr('7', { fn, auth: 'self' }),
    },
  });

  it('takes exactly the expected merchant call', () => {
    expect(orderActionProblem(subject('accept'), 'accept', check)).toBeNull();
    expect(orderActionProblem(subject('mark_paid'), 'mark_paid', check)).toBeNull();
    expect(orderActionProblem(subject('release'), 'release', check)).toBeNull();
  });

  it('refuses another call than the one the step expects', () => {
    expect(orderActionProblem(subject('release'), 'accept', check)).toMatch(/not accept/);
    expect(orderActionProblem(subject('cancel'), 'mark_paid', check)).toMatch(/not mark_paid/);
    expect(releaseProblem(transferMatch('7', 3), check)).toBeNull();
  });
});

describe('tick', () => {
  function harness(orders: MerchantOrder[], sendStatus: 'success' | 'reverted' = 'success') {
    const requests: string[] = [];
    const client = createMidpointClient({
      baseUrl: 'https://api.midpoint.test',
      apiKey: API_KEY,
      fetch: async (request) => {
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}${url.search}`);
        if (url.pathname === '/v1/p2p/merchant/orders') {
          const status = url.searchParams.get('status');
          const data = orders.filter((o) => o.status === status);
          return Response.json({ data, total: data.length, take: 100, skip: 0 });
        }
        const body = (await request.json()) as {
          action: string;
          args: { orderId: string };
        };
        const target = orders.find((o) => o.id === body.args.orderId) as MerchantOrder;
        const fn = body.action === 'markPaid' ? 'mark_paid' : body.action;
        const tx: Transaction = {
          network: 'testnet',
          action: fn,
          description: fn,
          xdr: releaseXdr(target.onchainId as string, { fn }),
          hash: 'cd'.repeat(32),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        };
        return Response.json(tx);
      },
    });
    const sent: Transaction[] = [];
    const sender: ReleaseSender = {
      address: MERCHANT.publicKey(),
      async send(transaction) {
        sent.push(transaction);
        return { hash: 'ef'.repeat(32), status: sendStatus, error: null };
      },
    };
    const lines: string[] = [];
    let clock = T0;
    const ctx: SimulatedMerchantContext = {
      client,
      sender,
      signer: MERCHANT.publicKey(),
      tier: 'test',
      marketContracts: { testnet: MARKET },
      maxFeeStroops: 1_000_000,
      delays: DELAYS,
      seen: new Map(),
      done: new Set(),
      retry: new Map(),
      log: (line) => lines.push(line),
      now: () => clock,
    };
    return { ctx, sent, lines, requests, advance: (ms: number) => (clock += ms) };
  }

  it('accepts, then marks paid later, and releases a paid purchase once', async () => {
    const orders = [
      sale('11', 'awaiting_acceptance'),
      order('12', { status: 'paid', paidAt: new Date(T0 - 60_000).toISOString() }),
    ];
    const h = harness(orders);
    expect(await tick(h.ctx)).toBe(2);
    expect(h.sent.map((t) => t.action)).toEqual(['accept', 'release']);
    expect(h.lines[0]).toMatch(/^accepted SELL order-11 \(100 USDC for 125050.00 ARS/);
    expect(h.lines[1]).toMatch(/^released BUY order-12/);
    // The index has not caught up yet: the same steps are never sent twice.
    expect(await tick(h.ctx)).toBe(0);
    // Now indexed as accepted: marked paid only after the pay delay.
    orders[0] = sale('11', 'awaiting_payment');
    expect(await tick(h.ctx)).toBe(0);
    h.advance(5_000);
    expect(await tick(h.ctx)).toBe(1);
    expect(h.sent.map((t) => t.action)).toEqual(['accept', 'release', 'mark_paid']);
    expect(h.requests.filter((r) => r.startsWith('POST'))).toHaveLength(3);
  });

  it('retries a reverted step later, and never signs what fails the check', async () => {
    const h = harness([sale('21', 'awaiting_acceptance')], 'reverted');
    await tick(h.ctx);
    expect(h.lines.at(-1)).toMatch(/accept SELL order-21 .* failed \(attempt 1\)/);
    expect(await tick(h.ctx)).toBe(0);
    h.advance(15_000);
    expect(await tick(h.ctx)).toBe(1);

    const other = harness([sale('22', 'awaiting_acceptance')]);
    other.ctx.marketContracts = {
      testnet: 'CAKGHC55HFGIGFDRKKLH7MYLVXE5ELAO57VE2VUCDXBWDVFNDIXXZTJ7',
    };
    await tick(other.ctx);
    expect(other.sent).toHaveLength(0);
    expect(other.lines.at(-1)).toMatch(
      /gave up on accept .* refused to sign: the transaction calls/,
    );
  });
});

describe('the bot on the order’s chat', () => {
  const message = (from: 'creator' | 'merchant', at: number, kind = 'text'): OrderMessage => ({
    id: `m-${from}-${at}`,
    orderId: 'order-1',
    from,
    kind: kind as OrderMessage['kind'],
    text: 'hola',
    attachment: null,
    createdAt: new Date(at).toISOString(),
  });

  it('answers the person’s first message once, a few seconds later', () => {
    expect(replyStep([], T0, 3_000)).toEqual({ kind: 'none' });
    expect(replyStep([message('merchant', T0, 'receipt')], T0, 3_000)).toEqual({ kind: 'none' });
    const asked = [message('creator', T0)];
    expect(replyStep(asked, T0 + 1_000, 3_000)).toEqual({ kind: 'wait', until: T0 + 3_000 });
    expect(replyStep(asked, T0 + 3_000, 3_000)).toEqual({ kind: 'reply' });
    // Whatever it sent before the person wrote (a receipt) is not the answer; a text after is.
    const before = [message('merchant', T0 - 5_000, 'receipt'), ...asked];
    expect(replyStep(before, T0 + 3_000, 3_000)).toEqual({ kind: 'reply' });
    const answered = [...asked, message('merchant', T0 + 3_000), message('creator', T0 + 9_000)];
    expect(replyStep(answered, T0 + 20_000, 3_000)).toEqual({ kind: 'answered' });
  });

  it('picks the line by the order’s state', () => {
    expect(chatReply({ merchantSide: 'seller', status: 'awaiting_payment' })).toMatch(
      /^Hola\. Cuando hagas la transferencia/,
    );
    for (const status of ['paid', 'completed', 'resolved'] as const) {
      expect(chatReply({ merchantSide: 'buyer', status })).toMatch(/^De nada\./);
    }
    expect(chatReply({ merchantSide: 'buyer', status: 'awaiting_payment' })).toMatch(
      /^Hola, ya estoy con tu orden/,
    );
    expect(chatReply({ merchantSide: 'seller', status: 'awaiting_acceptance' })).toMatch(
      /^Hola, ya estoy con tu orden/,
    );
  });

  /** A fake API with the merchant's orders, each with its chat, and what the bot posted. */
  function chatApi(orders: MerchantOrder[], messages: Record<string, OrderMessage[]>) {
    const posted: { path: string; body: { text?: string; attachment?: { data: string } } }[] = [];
    const client = createMidpointClient({
      baseUrl: 'https://api.midpoint.test',
      apiKey: API_KEY,
      fetch: async (request) => {
        const url = new URL(request.url);
        const chat = /^\/v1\/p2p\/merchant\/orders\/([^/]+)\/messages$/.exec(url.pathname);
        if (chat && request.method === 'GET') {
          return Response.json({ data: messages[chat[1]] ?? [] });
        }
        if (chat && request.method === 'POST') {
          const body = (await request.json()) as (typeof posted)[number]['body'];
          posted.push({ path: url.pathname, body });
          const sent = message('merchant', Date.now());
          (messages[chat[1]] ??= []).push(sent);
          return Response.json(sent, { status: 201 });
        }
        if (url.pathname === '/v1/p2p/merchant/orders') {
          const status = url.searchParams.get('status');
          const data = status ? orders.filter((o) => o.status === status) : orders;
          return Response.json({ data, total: data.length, take: 100, skip: 0 });
        }
        const body = (await request.json()) as { action: string; args: { orderId: string } };
        const target = orders.find((o) => o.id === body.args.orderId) as MerchantOrder;
        const fn = body.action === 'markPaid' ? 'mark_paid' : body.action;
        return Response.json({
          network: 'testnet',
          action: fn,
          description: fn,
          xdr: releaseXdr(target.onchainId as string, { fn }),
          hash: 'cd'.repeat(32),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        } satisfies Transaction);
      },
    });
    const lines: string[] = [];
    let clock = T0;
    const ctx: SimulatedMerchantContext = {
      client,
      sender: {
        address: MERCHANT.publicKey(),
        send: async () => ({ hash: 'ef'.repeat(32), status: 'success', error: null }),
      },
      signer: MERCHANT.publicKey(),
      tier: 'test',
      marketContracts: { testnet: MARKET },
      maxFeeStroops: 1_000_000,
      delays: { ...DELAYS, replySeconds: 3 },
      seen: new Map(),
      done: new Set(),
      retry: new Map(),
      name: 'Andes Cambio',
      receipts: new Map(),
      answered: new Set(),
      log: (line) => lines.push(line),
      now: () => clock,
    };
    return { ctx, posted, lines, advance: (ms: number) => (clock += ms) };
  }

  it('sends the receipt right after it marks a sale paid', async () => {
    const paying = {
      ...sale('41', 'awaiting_payment'),
      currency: 'BOB',
      fiatAmount: '118.26',
      rail: 'bo_bank_transfer',
      beneficiary: {
        holderName: 'Ana Quispe',
        document: '4567891',
        rail: 'bo_bank_transfer',
        details: { bank: 'Banco Unión', accountNumber: '1000012345678' },
      },
    } satisfies MerchantOrder;
    const api = chatApi([paying], {});
    // Seen accepted now; marked paid after the pay delay.
    await tick(api.ctx);
    expect(api.posted).toEqual([]);
    api.advance(5_000);
    await tick(api.ctx);
    expect(api.posted).toHaveLength(1);
    expect(api.posted[0].path).toBe('/v1/p2p/merchant/orders/order-41/messages');
    expect(api.posted[0].body.text).toBe(RECEIPT_MESSAGE);
    const pdf = Buffer.from(api.posted[0].body.attachment?.data ?? '', 'base64').toString('latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf).toContain('(Beneficiario: Ana Quispe) Tj');
    expect(pdf).toContain('(Monto: 118.26 BOB) Tj');
    expect(api.lines).toContain(
      'sent the receipt of SELL order-41 (100 USDC for 118.26 BOB on bo_bank_transfer)',
    );
    // Once: the next ticks send nothing more.
    await tick(api.ctx);
    expect(api.posted).toHaveLength(1);
  });

  it('never sends a receipt for a purchase it releases', async () => {
    const api = chatApi(
      [order('42', { status: 'paid', paidAt: new Date(T0 - 60_000).toISOString() })],
      {},
    );
    await tick(api.ctx);
    expect(api.posted).toEqual([]);
  });

  it('answers the person once, by the order’s state, and leaves an answered chat alone', async () => {
    const waiting = order('43', {
      status: 'awaiting_payment',
      chat: { count: 1, lastAt: new Date(T0).toISOString(), lastFrom: 'creator' },
    });
    const done = order('44', {
      status: 'completed',
      chat: { count: 3, lastAt: new Date(T0).toISOString(), lastFrom: 'creator' },
    });
    const quiet = order('45', { status: 'completed' });
    const api = chatApi([waiting, done, quiet], {
      'order-43': [message('creator', T0)],
      // Already answered before a restart: the person wrote again.
      'order-44': [
        message('creator', T0 - 9_000),
        message('merchant', T0 - 6_000),
        message('creator', T0),
      ],
    });
    expect(await answerChats(api.ctx)).toBe(0);
    api.advance(3_000);
    expect(await answerChats(api.ctx)).toBe(1);
    expect(api.posted).toEqual([
      {
        path: '/v1/p2p/merchant/orders/order-43/messages',
        body: {
          text: 'Hola. Cuando hagas la transferencia, avisame acá y adjuntá el comprobante.',
        },
      },
    ]);
    api.advance(60_000);
    expect(await answerChats(api.ctx)).toBe(0);
    expect(api.posted).toHaveLength(1);
  });
});

describe('readSimulatedMerchantConfig', () => {
  const env = {
    MIDPOINT_API_URL: 'http://localhost:4100',
    MIDPOINT_API_KEY: API_KEY,
    BOT_SECRET: MERCHANT.secret(),
    MARKET_CONTRACT: `testnet=${MARKET}`,
    BOT_NAME: 'Andes Cambio',
  };

  it('reads the reference bot’s settings and the delays', () => {
    expect(readSimulatedMerchantConfig({ ...env, PAY_DELAY_SECONDS: '8' })).toMatchObject({
      name: 'Andes Cambio',
      tier: 'test',
      marketContracts: { testnet: MARKET },
      delays: { paySeconds: 8, releaseSeconds: 5, replySeconds: 3 },
      pollSeconds: 3,
    });
  });

  it('refuses a live key, and bad delays', () => {
    expect(() =>
      readSimulatedMerchantConfig({
        ...env,
        MIDPOINT_API_KEY: 'pk_live_3kQ9x7Lm2Vb8',
        MARKET_CONTRACT: `mainnet=${MARKET}`,
      }),
    ).toThrow(/pk_test_/);
    expect(() => readSimulatedMerchantConfig({ ...env, POLL_SECONDS: '0' })).toThrow(
      /POLL_SECONDS/,
    );
    expect(() => readSimulatedMerchantConfig({ ...env, RELEASE_DELAY_SECONDS: 'x' })).toThrow(
      /RELEASE_DELAY_SECONDS/,
    );
  });
});
