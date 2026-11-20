/**
 * Reference merchant bot: auto-releases purchases (BUY orders) when the local
 * money arrives at the merchant's bank account.
 *
 * For each incoming bank transfer it calls
 * `POST /v1/p2p/merchant/transfer-matches` with the merchant's API key. The
 * API answers the merchant's live orders for that exact amount and currency,
 * scored 1 for the amount, +1 when the payer's name matches and +1 when the
 * document matches, each with its unsigned `release` transaction. The bot
 * releases only when:
 *
 * - the best score is at least `MIN_SCORE` (default 3: amount, name and document),
 * - no other match has the same score (an ambiguous transfer is left to a person),
 * - the order is a purchase (BUY), and
 * - the transaction, decoded with the bot's OWN passphrase for the order's
 *   network, is exactly one `release(<the bot's account>, <the order's
 *   on-chain id>)` on the bot's OWN `MARKET_CONTRACT`, from the bot's account,
 *   with no memo, no preconditions but an upper time bound within 6 minutes, a
 *   fee under `MAX_FEE_STROOPS`, and at most one source-account authorization
 *   for that same call with no sub-invocations. A test key never signs on
 *   mainnet. Every API answer is untrusted.
 *
 * It then signs the envelope with its own Stellar secret (`BOT_SECRET`: best
 * an operator the merchant granted only PERM_RELEASE with `set_operator`, so
 * the key cannot withdraw; or the merchant account's own), submits it through
 * the API (`POST /v1/p2p/submit`: the API's sponsor pays the fee when gasless
 * is on) and waits for the result. The API never holds that key.
 *
 * Input: one JSON object per line, from the file named by the first argument,
 * or from stdin when there is none (or it is `-`):
 *
 *     {"currency":"ARS","amount":"125050.00","payerName":"Juan Gomez","payerDocument":"20123456786","reference":"TRX-88213","receivedAt":"2026-11-19T12:12:40Z"}
 *
 * Environment:
 *
 * - `MIDPOINT_API_URL`  the API origin
 * - `MIDPOINT_API_KEY`  the merchant organization's API key (`pk_live_...` / `pk_test_...`)
 * - `BOT_SECRET`       its Stellar secret (S...): an operator with PERM_RELEASE, or the merchant; not needed with `DRY_RUN`
 * - `MIN_SCORE`        1 to 3 (default 3)
 * - `DRY_RUN`          `true`: decide and log, never sign or send
 * - `MARKET_CONTRACT`  required: the market contract (C...), or `network=C...` pairs
 * - `MAX_FEE_STROOPS`  optional: the largest fee it signs (default 1000000)
 *
 * Run (after `npm run build -w @midpoint/sdk`):
 *
 *     DRY_RUN=true MIDPOINT_API_URL=... MIDPOINT_API_KEY=... npm run bot -w @midpoint/sdk -- transfers.jsonl
 *     tail -f bank-feed.jsonl | node packages/sdk/dist/bot/auto-release.js
 *
 * Every outcome is logged as one JSON line on stdout. Keys are never logged. The exit code is 1
 * when any transfer could not be processed or a release was refused.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { chooseMatch, type MatchDecision } from '@/bot/choose-match';
import { parseTransferLine, readBotConfig } from '@/bot/config';
import {
  BOT_NETWORKS,
  createReleaseSender,
  releaseProblem,
  type ReleaseSender,
} from '@/bot/release';
import { createMidpointClient, MidpointError, unwrap, type MidpointClient } from '@/client';
import type { TransferMatchRequest } from '@/types';

type SkipReason = Extract<MatchDecision, { action: 'skip' }>['reason'];

/** What the bot did with one transfer. */
export type TransferOutcome =
  | { status: 'skipped'; reason: SkipReason; bestScore: number; candidates: string[] }
  | { status: 'refused'; orderId: string; problem: string }
  | { status: 'dry_run'; orderId: string; score: number; description: string }
  | { status: 'released'; orderId: string; hash: string }
  | { status: 'reverted'; orderId: string; hash: string };

export interface BotContext {
  client: MidpointClient;
  minScore: number;
  /** Null in a dry run. */
  sender: ReleaseSender | null;
  /** The API key's tier: a test key never signs on mainnet, nor a live key on testnet. */
  tier: 'live' | 'test';
  /** The market contract per network, from the bot's own configuration (never the API). */
  marketContracts: Readonly<Record<string, string>>;
  /** The largest fee the bot signs, stroops. */
  maxFeeStroops: number;
  /**
   * Orders released in this run. The API sees a release only once it is
   * indexed, so until then a second transfer could match the same order again.
   */
  released: Set<string>;
}

/** Matches one transfer, decides, and releases (or, without a sender, only decides). */
export async function handleTransfer(
  transfer: TransferMatchRequest,
  ctx: BotContext,
): Promise<TransferOutcome> {
  const { data } = await unwrap(
    ctx.client.POST('/v1/p2p/merchant/transfer-matches', {
      // The releases are built for the bot's own account (the merchant, or its operator).
      body: ctx.sender ? { ...transfer, signer: ctx.sender.address } : transfer,
    }),
  );
  const decision = chooseMatch(
    data.filter((m) => !ctx.released.has(m.order.id)),
    ctx.minScore,
  );
  if (decision.action === 'skip') {
    return {
      status: 'skipped',
      reason: decision.reason,
      bestScore: decision.bestScore,
      candidates: decision.candidates.map((m) => m.order.id),
    };
  }
  const { match } = decision;
  const orderId = match.order.id;
  const problem = releaseProblem(match, {
    // A dry run (no key) checks the release is the merchant's own.
    signer: ctx.sender?.address ?? match.order.sellerAddress,
    network: match.order.network,
    tier: ctx.tier,
    marketContracts: ctx.marketContracts,
    maxFeeStroops: ctx.maxFeeStroops,
  });
  if (problem !== null) return { status: 'refused', orderId, problem };
  if (ctx.sender === null) {
    ctx.released.add(orderId);
    return {
      status: 'dry_run',
      orderId,
      score: match.score,
      description: match.transaction.description,
    };
  }
  const { hash, status } = await ctx.sender.send(
    match.transaction,
    BOT_NETWORKS[match.order.network].passphrase,
  );
  if (status !== 'success') return { status: 'reverted', orderId, hash };
  ctx.released.add(orderId);
  return { status: 'released', orderId, hash };
}

function log(level: 'info' | 'warn' | 'error', msg: string, fields: object = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
}

/** A one-line reason that never carries request details. */
function describeError(error: unknown): string {
  if (error instanceof MidpointError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const config = readBotConfig(process.env);
  const client = createMidpointClient({ baseUrl: config.apiUrl, apiKey: config.apiKey });
  const sender =
    config.dryRun || config.secret === null
      ? null
      : createReleaseSender({ secret: config.secret, client });
  const ctx: BotContext = {
    client,
    minScore: config.minScore,
    sender,
    tier: config.tier,
    marketContracts: config.marketContracts,
    maxFeeStroops: config.maxFeeStroops,
    released: new Set(),
  };
  const file = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : null;
  log('info', 'started', {
    dryRun: sender === null,
    minScore: config.minScore,
    signer: sender?.address ?? null,
    input: file ?? 'stdin',
  });

  const lines = createInterface({
    input: file ? createReadStream(file, 'utf8') : process.stdin,
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  let failures = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim() === '') continue;
    let transfer: TransferMatchRequest;
    try {
      transfer = parseTransferLine(line);
    } catch (error) {
      failures += 1;
      log('error', 'invalid transfer', { line: lineNumber, error: describeError(error) });
      continue;
    }
    const about = {
      line: lineNumber,
      currency: transfer.currency,
      amount: transfer.amount,
      reference: transfer.reference ?? null,
    };
    try {
      const outcome = await handleTransfer(transfer, ctx);
      const bad = outcome.status === 'refused' || outcome.status === 'reverted';
      if (bad) failures += 1;
      log(bad ? 'warn' : 'info', 'transfer', { ...about, ...outcome });
    } catch (error) {
      failures += 1;
      log('error', 'transfer failed', { ...about, error: describeError(error) });
    }
  }
  log('info', 'done', { lines: lineNumber, failures });
  process.exitCode = failures > 0 ? 1 : 0;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    log('error', 'stopped', { error: describeError(error) });
    process.exitCode = 1;
  });
}
