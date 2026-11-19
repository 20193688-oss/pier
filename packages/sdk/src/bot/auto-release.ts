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
 * - the transaction is exactly `release(<the order's on-chain id>)` on the
 *   order's contract (and `MARKET_CONTRACT` when set), with no value.
 *
 * It then signs the transaction with its own key, through `RPC_URL`, refusing
 * when the node's `eth_chainId` is not the transaction's `chainId`, and waits
 * for the receipt. The API never holds that key: it is the merchant's wallet,
 * or better a separate key the merchant allowed to release with
 * `P2PMarket.setOperator(<bot address>, 2)` (PERM_RELEASE), so it cannot
 * withdraw the merchant's balance.
 *
 * Input: one JSON object per line, from the file named by the first argument,
 * or from stdin when there is none (or it is `-`):
 *
 *     {"currency":"ARS","amount":"125050.00","payerName":"Juan Gomez","payerDocument":"20123456786","reference":"TRX-88213","receivedAt":"2026-11-19T12:12:40Z"}
 *
 * Environment:
 *
 * - `PEDOSPE_API_URL`  the API origin
 * - `PEDOSPE_API_KEY`  the merchant organization's API key (`pk_live_...` / `pk_test_...`)
 * - `BOT_PRIVATE_KEY`  the signing key (0x + 64 hex); not needed with `DRY_RUN`
 * - `RPC_URL`          a node on the orders' chain; not needed with `DRY_RUN`
 * - `MIN_SCORE`        1 to 3 (default 3)
 * - `DRY_RUN`          `true`: decide and log, never sign or send
 * - `MARKET_CONTRACT`  optional: the only contract address the bot will call
 *
 * Run (after `npm run build -w @pedospe/sdk`):
 *
 *     DRY_RUN=true PEDOSPE_API_URL=... PEDOSPE_API_KEY=... npm run bot -w @pedospe/sdk -- transfers.jsonl
 *     tail -f bank-feed.jsonl | node packages/sdk/dist/bot/auto-release.js
 *
 * Every outcome is logged as one JSON line on stdout. Keys and the RPC URL
 * (which often embeds a provider key) are never logged. The exit code is 1
 * when any transfer could not be processed or a release was refused.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { BaseError } from 'viem';
import { chooseMatch, type MatchDecision } from '@/bot/choose-match';
import { parseTransferLine, readBotConfig } from '@/bot/config';
import { createReleaseSender, releaseProblem, type ReleaseSender } from '@/bot/release';
import { createPedospeClient, PedospeError, unwrap, type PedospeClient } from '@/client';
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
  client: PedospeClient;
  minScore: number;
  /** Null in a dry run. */
  sender: ReleaseSender | null;
  marketContract: `0x${string}` | null;
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
    ctx.client.POST('/v1/p2p/merchant/transfer-matches', { body: transfer }),
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
  const problem = releaseProblem(match, { marketContract: ctx.marketContract });
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
  const { hash, status } = await ctx.sender.send(match.transaction);
  if (status !== 'success') return { status: 'reverted', orderId, hash };
  ctx.released.add(orderId);
  return { status: 'released', orderId, hash };
}

function log(level: 'info' | 'warn' | 'error', msg: string, fields: object = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
}

/** A one-line reason that never carries request details (viem's long messages include the RPC URL). */
function describeError(error: unknown): string {
  if (error instanceof PedospeError) return `${error.code}: ${error.message}`;
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const config = readBotConfig(process.env);
  const sender =
    config.dryRun || config.privateKey === null || config.rpcUrl === null
      ? null
      : createReleaseSender({ privateKey: config.privateKey, rpcUrl: config.rpcUrl });
  const ctx: BotContext = {
    client: createPedospeClient({ baseUrl: config.apiUrl, apiKey: config.apiKey }),
    minScore: config.minScore,
    sender,
    marketContract: config.marketContract,
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
