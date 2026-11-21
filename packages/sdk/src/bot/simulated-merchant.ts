/**
 * A SIMULATED merchant for test networks: it plays a merchant's side of every
 * order through the public API, as if its bank and its staff answered at once.
 * The dev stack (`npm run dev:stack`) runs one per test merchant; integrators
 * can run it against their own `pk_test_` merchant to try a whole flow alone.
 *
 * It never pays or receives real money, so it refuses live API keys and
 * mainnet: on a live market its "mark paid" would be a lie and its releases
 * would hand out tokens nobody paid for. A real merchant releases from its
 * bank feed instead (`auto-release.ts`).
 *
 * Every few seconds it lists its live orders (`GET /v1/p2p/merchant/orders`):
 *
 * - a sale, a QR payment or a payout waiting for it (it buys the tokens):
 *   it accepts at once, then marks it paid `PAY_DELAY_SECONDS` later (the
 *   simulated bank transfer, or the shop's QR paid);
 * - a purchase or a charge the payer marked paid (it sells the tokens): it
 *   releases it `RELEASE_DELAY_SECONDS` after the payment was reported (the
 *   simulated bank feed).
 *
 * On the order's chat (`/v1/p2p/merchant/orders/{id}/messages`): right after
 * it marks a sale or a QR payment paid it sends the person the transfer
 * receipt (a PDF it writes, `receipt.ts`); and the first time the person
 * writes on an order it answers once, `REPLY_DELAY_SECONDS` later, with one
 * line that fits the order's state. It finds new messages through the order
 * views' `chat` summary (its latest orders, every status), so it reads a
 * chat only when the person wrote last.
 *
 * Each step's transaction is built by the API (`POST /v1/p2p/transactions`)
 * and checked before the key signs it exactly like the reference bot checks a
 * release (`orderActionProblem`): ONE `accept` / `mark_paid` / `release`
 * (its account, the order's on-chain id) on the bot's OWN `MARKET_CONTRACT`,
 * with the passphrase pinned here, a near time bound, a capped fee and no
 * sub-invocations. It is then submitted through the API (`/v1/p2p/submit`,
 * fee-bumped by the sponsor) and followed until applied.
 *
 * Environment: `MIDPOINT_API_URL`, `MIDPOINT_API_KEY` (a `pk_test_` key),
 * `BOT_SECRET` (the merchant account's key, or an operator with the
 * permissions to accept and release), `MARKET_CONTRACT` (`testnet=C...` or
 * `local=C...`), and optionally `BOT_NAME` (for the log and the receipts),
 * `PAY_DELAY_SECONDS` (default 5), `RELEASE_DELAY_SECONDS` (default 5),
 * `REPLY_DELAY_SECONDS` (default 3), `POLL_SECONDS` (default 3),
 * `MAX_FEE_STROOPS`, `DRY_RUN`.
 *
 *     node packages/sdk/dist/bot/simulated-merchant.js
 *
 * One line per step on stdout; keys are never logged.
 */
import { readBotConfig, type BotConfig } from '@/bot/config';
import {
  BOT_NETWORKS,
  createReleaseSender,
  orderActionProblem,
  type MerchantOrderAction,
  type ReleaseSender,
} from '@/bot/release';
import { receiptMessage } from '@/bot/receipt';
import { listOrderMessages, sendOrderMessage } from '@/chat';
import { createMidpointClient, MidpointError, unwrap, type MidpointClient } from '@/client';
import type { MerchantOrder, OrderMessage, Transaction } from '@/types';

/** What the bot does next with one order. */
export type MerchantStep =
  | { kind: 'act'; action: 'accept' | 'markPaid' | 'release'; fn: MerchantOrderAction }
  | { kind: 'wait'; until: number }
  | { kind: 'none' };

export interface SimulatedDelays {
  /** Seconds between accepting a sale (or a QR payment) and marking it paid. */
  paySeconds: number;
  /** Seconds between the payer reporting a purchase paid and the release. */
  releaseSeconds: number;
  /** Seconds between the person's first message on an order and the bot's answer. */
  replySeconds?: number;
}

/** The statuses that may need the merchant. */
export const LIVE_MERCHANT_STATUSES = ['awaiting_acceptance', 'awaiting_payment', 'paid'] as const;

/**
 * The simulated merchant's rule for one order (pure). `firstSeen` is when this
 * bot first saw the order in its current status (unix ms), for a step that
 * waits on a status with no timestamp of its own.
 */
export function nextStep(
  order: Pick<MerchantOrder, 'merchantSide' | 'status' | 'paidAt' | 'onchainId'>,
  now: number,
  firstSeen: number,
  delays: SimulatedDelays,
): MerchantStep {
  if (order.onchainId === null) return { kind: 'none' };
  if (order.merchantSide === 'buyer') {
    if (order.status === 'awaiting_acceptance') {
      return { kind: 'act', action: 'accept', fn: 'accept' };
    }
    if (order.status === 'awaiting_payment') {
      const until = firstSeen + delays.paySeconds * 1000;
      return now >= until
        ? { kind: 'act', action: 'markPaid', fn: 'mark_paid' }
        : { kind: 'wait', until };
    }
    return { kind: 'none' };
  }
  if (order.merchantSide === 'seller' && order.status === 'paid') {
    const paidAt = order.paidAt ? Date.parse(order.paidAt) : Number.NaN;
    const until = (Number.isFinite(paidAt) ? paidAt : firstSeen) + delays.releaseSeconds * 1000;
    return now >= until
      ? { kind: 'act', action: 'release', fn: 'release' }
      : { kind: 'wait', until };
  }
  return { kind: 'none' };
}

// --- the order's chat ------------------------------------------------------------------

/** The order kinds whose payment the bot makes, and so whose receipt it sends. */
export const RECEIPT_KINDS: readonly string[] = ['SELL', 'QR_PAY'];

/** The bot's one answer to the person's first message on an order (end-user content). */
export function chatReply(order: Pick<MerchantOrder, 'merchantSide' | 'status'>): string {
  if (order.merchantSide === 'seller' && order.status === 'awaiting_payment') {
    return 'Hola. Cuando hagas la transferencia, avisame acá y adjuntá el comprobante.';
  }
  if (order.status === 'paid' || order.status === 'completed' || order.status === 'resolved') {
    return 'De nada. Si necesitás algo más, escribime acá.';
  }
  return 'Hola, ya estoy con tu orden. Te aviso apenas esté.';
}

/** What the bot does about an order's chat. */
export type ReplyStep =
  | { kind: 'reply' }
  | { kind: 'wait'; until: number }
  /** It answered already (a text of its own after the person's first message). */
  | { kind: 'answered' }
  /** The person has not written. */
  | { kind: 'none' };

/**
 * Whether to answer the person (pure): once, `replyMs` after their first
 * message, unless a text of the bot's own came after it. What the bot sent
 * before the person wrote (a receipt, say) never counts as the answer.
 */
export function replyStep(
  messages: readonly Pick<OrderMessage, 'from' | 'kind' | 'createdAt'>[],
  now: number,
  replyMs: number,
): ReplyStep {
  const first = messages.find((m) => m.from === 'creator');
  if (!first) return { kind: 'none' };
  const firstAt = Date.parse(first.createdAt);
  const answered = messages.some(
    (m) => m.from === 'merchant' && m.kind === 'text' && Date.parse(m.createdAt) >= firstAt,
  );
  if (answered) return { kind: 'answered' };
  const until = firstAt + replyMs;
  return now >= until ? { kind: 'reply' } : { kind: 'wait', until };
}

/** What happened to one step. */
export type StepOutcome =
  | { status: 'done'; hash: string }
  | { status: 'dry_run' }
  | { status: 'refused'; problem: string }
  | { status: 'reverted'; hash: string; error: string | null }
  | { status: 'failed'; error: string };

export interface SimulatedMerchantContext {
  client: MidpointClient;
  /** Null in a dry run. */
  sender: ReleaseSender | null;
  /** The bot's account (the merchant's, or its operator's). */
  signer: string;
  tier: 'test';
  marketContracts: Readonly<Record<string, string>>;
  maxFeeStroops: number;
  delays: SimulatedDelays;
  /** Order status first seen, by `orderId:status`. */
  seen: Map<string, number>;
  /** Steps finished (or given up), by `orderId:action`: never repeated while the index catches up. */
  done: Set<string>;
  /** Failed steps: attempts and when to try again, by `orderId:action`. */
  retry: Map<string, { attempts: number; at: number }>;
  /** The merchant's name on its receipts. */
  name?: string;
  /** Receipts still to send (a failed send is tried again), by order id. */
  receipts?: Map<string, { order: MerchantOrder; paidAt: number; attempts: number }>;
  /** Orders whose chat the bot answered (or found answered). */
  answered?: Set<string>;
  log: (line: string) => void;
  now?: () => number;
}

/** Attempts per step before it is left to a person. */
const MAX_ATTEMPTS = 5;
/** Attempts to send a receipt. */
const RECEIPT_ATTEMPTS = 3;
/** The latest orders whose chat the bot watches (any status). */
const CHAT_WATCH = 50;
/** Default seconds before the bot answers the person's first message. */
const DEFAULT_REPLY_SECONDS = 3;
/** Seconds before a failed step is tried again (times the attempts). */
const RETRY_SECONDS = 15;

function describe(order: MerchantOrder): string {
  const units = BigInt(order.tokenAmount);
  const scale = 10n ** BigInt(order.tokenDecimals);
  const whole = units / scale;
  const frac = (units % scale).toString().padStart(order.tokenDecimals, '0').replace(/0+$/, '');
  const amount = frac ? `${whole}.${frac}` : `${whole}`;
  return `${order.kind} ${order.id.slice(0, 8)} (${amount} ${order.tokenSymbol} for ${order.fiatAmount} ${order.currency} on ${order.rail})`;
}

function reason(error: unknown): string {
  if (error instanceof MidpointError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Builds, checks, signs and submits one step of one order. */
export async function runStep(
  order: MerchantOrder,
  step: Extract<MerchantStep, { kind: 'act' }>,
  ctx: SimulatedMerchantContext,
): Promise<StepOutcome> {
  if (!order.merchantAccountId) return { status: 'refused', problem: 'the order names no account' };
  let transaction: Transaction;
  try {
    transaction = await unwrap(
      ctx.client.POST('/v1/p2p/transactions', {
        body: {
          network: order.network as 'testnet',
          from: order.merchantAccountId,
          action: step.action,
          args: { orderId: order.id },
        },
      }),
    );
  } catch (error) {
    return { status: 'failed', error: reason(error) };
  }
  const problem = orderActionProblem({ order, transaction }, step.fn, {
    signer: ctx.signer,
    network: order.network,
    tier: ctx.tier,
    marketContracts: ctx.marketContracts,
    maxFeeStroops: ctx.maxFeeStroops,
    now: Math.floor((ctx.now?.() ?? Date.now()) / 1000),
  });
  if (problem !== null) return { status: 'refused', problem };
  if (ctx.sender === null) return { status: 'dry_run' };
  try {
    const sent = await ctx.sender.send(transaction, BOT_NETWORKS[order.network].passphrase);
    return sent.status === 'success'
      ? { status: 'done', hash: sent.hash }
      : { status: 'reverted', hash: sent.hash, error: sent.error ?? null };
  } catch (error) {
    return { status: 'failed', error: reason(error) };
  }
}

const VERB: Record<Extract<MerchantStep, { kind: 'act' }>['action'], string> = {
  accept: 'accepted',
  markPaid: 'marked paid',
  release: 'released',
};

/** Sends the receipts due (best effort: a failure is tried again on the next ticks). */
async function sendReceipts(ctx: SimulatedMerchantContext): Promise<void> {
  if (!ctx.receipts || ctx.sender === null) return;
  for (const [id, due] of ctx.receipts) {
    try {
      const body = receiptMessage(due.order, ctx.name ?? 'Comercio', new Date(due.paidAt));
      await sendOrderMessage(ctx.client, 'merchant', id, body);
      ctx.receipts.delete(id);
      ctx.log(`sent the receipt of ${describe(due.order)}`);
    } catch (error) {
      due.attempts += 1;
      if (due.attempts >= RECEIPT_ATTEMPTS) {
        ctx.receipts.delete(id);
        ctx.log(`gave up on the receipt of ${describe(due.order)}: ${reason(error)}`);
      }
    }
  }
}

/**
 * Answers the person's first message on each of the merchant's latest orders,
 * once. Reads a chat only when the order's summary says the person wrote last
 * and the bot has not answered it yet. Answers the replies sent.
 */
export async function answerChats(ctx: SimulatedMerchantContext): Promise<number> {
  if (!ctx.answered || ctx.sender === null) return 0;
  const now = ctx.now ?? Date.now;
  const replyMs = (ctx.delays.replySeconds ?? DEFAULT_REPLY_SECONDS) * 1000;
  const recent = await unwrap(
    ctx.client.GET('/v1/p2p/merchant/orders', { params: { query: { take: CHAT_WATCH } } }),
  );
  let replies = 0;
  for (const order of recent.data) {
    if (order.chat.lastFrom !== 'creator' || ctx.answered.has(order.id)) continue;
    const messages = await listOrderMessages(ctx.client, 'merchant', order.id);
    const step = replyStep(messages, now(), replyMs);
    if (step.kind === 'answered') ctx.answered.add(order.id);
    if (step.kind !== 'reply') continue;
    await sendOrderMessage(ctx.client, 'merchant', order.id, { text: chatReply(order) });
    ctx.answered.add(order.id);
    replies += 1;
    ctx.log(`answered the chat of ${describe(order)}`);
  }
  return replies;
}

/** Lists the merchant's live orders and takes every step that is due. Answers the steps taken. */
export async function tick(ctx: SimulatedMerchantContext): Promise<number> {
  const now = ctx.now ?? Date.now;
  const orders: MerchantOrder[] = [];
  for (const status of LIVE_MERCHANT_STATUSES) {
    const page = await unwrap(
      ctx.client.GET('/v1/p2p/merchant/orders', {
        params: { query: { status, take: 100 } },
      }),
    );
    orders.push(...page.data);
  }
  let taken = 0;
  for (const order of orders.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const seenKey = `${order.id}:${order.status}`;
    if (!ctx.seen.has(seenKey)) ctx.seen.set(seenKey, now());
    const step = nextStep(order, now(), ctx.seen.get(seenKey) as number, ctx.delays);
    if (step.kind !== 'act') continue;
    const key = `${order.id}:${step.action}`;
    if (ctx.done.has(key)) continue;
    const retry = ctx.retry.get(key);
    if (retry && now() < retry.at) continue;
    const outcome = await runStep(order, step, ctx);
    taken += 1;
    if (outcome.status === 'done' || outcome.status === 'dry_run') {
      ctx.done.add(key);
      ctx.retry.delete(key);
      ctx.log(
        `${outcome.status === 'dry_run' ? 'would have ' : ''}${VERB[step.action]} ${describe(order)}${outcome.status === 'done' ? ` tx ${outcome.hash.slice(0, 12)}` : ''}`,
      );
      // It paid the person: their receipt goes on the order's chat.
      if (
        outcome.status === 'done' &&
        step.action === 'markPaid' &&
        RECEIPT_KINDS.includes(order.kind)
      ) {
        ctx.receipts?.set(order.id, { order, paidAt: now(), attempts: 0 });
      }
      continue;
    }
    const attempts = (retry?.attempts ?? 0) + 1;
    const why =
      outcome.status === 'refused'
        ? `refused to sign: ${outcome.problem}`
        : outcome.status === 'reverted'
          ? `reverted ${outcome.hash.slice(0, 12)}: ${outcome.error ?? 'no detail'}`
          : outcome.error;
    if (outcome.status === 'refused' || attempts >= MAX_ATTEMPTS) {
      ctx.done.add(key);
      ctx.retry.delete(key);
      ctx.log(`gave up on ${step.action} ${describe(order)}: ${why}`);
    } else {
      ctx.retry.set(key, { attempts, at: now() + attempts * RETRY_SECONDS * 1000 });
      ctx.log(`${step.action} ${describe(order)} failed (attempt ${attempts}): ${why}`);
    }
  }
  await sendReceipts(ctx);
  try {
    await answerChats(ctx);
  } catch (error) {
    ctx.log(`cannot answer chats: ${reason(error)}`);
  }
  return taken;
}

/** The simulated merchant's settings: the reference bot's, a test key only, and the delays. */
export interface SimulatedMerchantConfig extends Omit<BotConfig, 'minScore' | 'tier'> {
  tier: 'test';
  name: string;
  delays: SimulatedDelays;
  pollSeconds: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function seconds(env: Env, name: string, fallback: number, problems: string[]): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < 0 || value > 3600) {
    problems.push(`${name} must be a number of seconds from 0 to 3600.`);
    return fallback;
  }
  return value;
}

/** Reads and checks the settings; refuses a live key or a mainnet contract. */
export function readSimulatedMerchantConfig(env: Env): SimulatedMerchantConfig {
  const base = readBotConfig(env);
  const problems: string[] = [];
  if (base.tier !== 'test') {
    problems.push('MIDPOINT_API_KEY must be a pk_test_ key: the simulated merchant never pays.');
  }
  if (Object.keys(base.marketContracts).some((n) => BOT_NETWORKS[n]?.tier !== 'test')) {
    problems.push('MARKET_CONTRACT must name only test networks (testnet, local).');
  }
  const delays = {
    paySeconds: seconds(env, 'PAY_DELAY_SECONDS', 5, problems),
    releaseSeconds: seconds(env, 'RELEASE_DELAY_SECONDS', 5, problems),
    replySeconds: seconds(env, 'REPLY_DELAY_SECONDS', DEFAULT_REPLY_SECONDS, problems),
  };
  const pollSeconds = seconds(env, 'POLL_SECONDS', 3, problems);
  if (pollSeconds < 1) problems.push('POLL_SECONDS must be at least 1.');
  if (problems.length > 0) {
    throw new Error(`Invalid simulated merchant configuration:\n- ${problems.join('\n- ')}`);
  }
  const { minScore: _minScore, tier: _tier, ...rest } = base;
  return {
    ...rest,
    tier: 'test',
    name: env.BOT_NAME?.trim() || 'simulated merchant',
    delays,
    pollSeconds,
  };
}

async function main(): Promise<void> {
  const config = readSimulatedMerchantConfig(process.env);
  const client = createMidpointClient({ baseUrl: config.apiUrl, apiKey: config.apiKey });
  const sender =
    config.dryRun || config.secret === null
      ? null
      : createReleaseSender({ secret: config.secret, client });
  const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
  const ctx: SimulatedMerchantContext = {
    client,
    sender,
    signer: sender?.address ?? 'dry-run',
    tier: 'test',
    marketContracts: config.marketContracts,
    maxFeeStroops: config.maxFeeStroops,
    delays: config.delays,
    seen: new Map(),
    done: new Set(),
    retry: new Map(),
    name: config.name,
    receipts: new Map(),
    answered: new Set(),
    log,
  };
  log(
    `${config.name} started as ${ctx.signer}: accepts sales and QR payments, marks them paid after ${config.delays.paySeconds}s and sends the receipt, releases purchases ${config.delays.releaseSeconds}s after they are reported paid, answers a chat once after ${config.delays.replySeconds}s`,
  );
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let failing = false;
  while (!stopping) {
    try {
      await tick(ctx);
      if (failing) log('the API answers again');
      failing = false;
    } catch (error) {
      if (!failing) log(`cannot read orders: ${reason(error)} (retrying)`);
      failing = true;
    }
    // Forget statuses an order left long ago: the maps stay small in a long run.
    if (ctx.seen.size > 5_000) ctx.seen.clear();
    // An answered chat is found answered again from its messages after a clear.
    if ((ctx.answered?.size ?? 0) > 5_000) ctx.answered?.clear();
    await new Promise((r) => setTimeout(r, config.pollSeconds * 1000));
  }
  log(`${config.name} stopped`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(reason(error));
    process.exitCode = 1;
  });
}
