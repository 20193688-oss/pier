import { DEFAULT_MIN_SCORE, MAX_MATCH_SCORE } from '@/bot/choose-match';
import type { TransferMatchRequest } from '@/types';

/** The reference bot's settings, read from the environment. */
export interface BotConfig {
  /** `PEDOSPE_API_URL`: the API origin. */
  apiUrl: string;
  /** `PEDOSPE_API_KEY`: the merchant organization's API key (`p2p:read` and `p2p:write`). */
  apiKey: string;
  /** `BOT_PRIVATE_KEY`: the key that signs releases (absent in a dry run). */
  privateKey: `0x${string}` | null;
  /** `RPC_URL`: a node on the chain the releases go to (absent in a dry run). */
  rpcUrl: string | null;
  /** `MIN_SCORE`: the lowest score that releases (1 to 3, default 3). */
  minScore: number;
  /** `DRY_RUN`: decide and log, never sign or send. */
  dryRun: boolean;
  /** `MARKET_CONTRACT` (optional): the only contract the bot will call. */
  marketContract: `0x${string}` | null;
}

type Env = Readonly<Record<string, string | undefined>>;

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function value(env: Env, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
}

function parseFlag(raw: string | undefined, name: string): boolean {
  if (raw === undefined) return false;
  if (/^(?:1|true|yes)$/i.test(raw)) return true;
  if (/^(?:0|false|no)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false.`);
}

/**
 * Reads and checks the bot's settings. Error messages name the variable,
 * never its value: keys must not reach a log.
 */
export function readBotConfig(env: Env): BotConfig {
  const problems: string[] = [];
  const dryRun = parseFlag(value(env, 'DRY_RUN'), 'DRY_RUN');

  const apiUrl = value(env, 'PEDOSPE_API_URL');
  if (!apiUrl || !URL.canParse(apiUrl)) problems.push('PEDOSPE_API_URL must be an absolute URL.');

  const apiKey = value(env, 'PEDOSPE_API_KEY');
  if (!apiKey || !/^pk_(?:live|test)_\S+$/.test(apiKey)) {
    problems.push('PEDOSPE_API_KEY must be an API key (pk_live_... or pk_test_...).');
  }

  const privateKey = value(env, 'BOT_PRIVATE_KEY');
  if (privateKey !== undefined && !PRIVATE_KEY.test(privateKey)) {
    problems.push('BOT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key.');
  } else if (privateKey === undefined && !dryRun) {
    problems.push('BOT_PRIVATE_KEY is required unless DRY_RUN is set.');
  }

  const rpcUrl = value(env, 'RPC_URL');
  if (rpcUrl !== undefined && !URL.canParse(rpcUrl)) {
    problems.push('RPC_URL must be an absolute URL.');
  } else if (rpcUrl === undefined && !dryRun) {
    problems.push('RPC_URL is required unless DRY_RUN is set.');
  }

  const rawMinScore = value(env, 'MIN_SCORE');
  const minScore = rawMinScore === undefined ? DEFAULT_MIN_SCORE : Number(rawMinScore);
  if (!Number.isInteger(minScore) || minScore < 1 || minScore > MAX_MATCH_SCORE) {
    problems.push(`MIN_SCORE must be an integer from 1 to ${MAX_MATCH_SCORE}.`);
  }

  const marketContract = value(env, 'MARKET_CONTRACT');
  if (marketContract !== undefined && !ADDRESS.test(marketContract)) {
    problems.push('MARKET_CONTRACT must be a 0x-prefixed 20-byte address.');
  }

  if (problems.length > 0)
    throw new Error(`Invalid bot configuration:\n- ${problems.join('\n- ')}`);
  return {
    apiUrl: apiUrl as string,
    apiKey: apiKey as string,
    privateKey: (privateKey as `0x${string}` | undefined) ?? null,
    rpcUrl: rpcUrl ?? null,
    minScore,
    dryRun,
    marketContract: (marketContract as `0x${string}` | undefined) ?? null,
  };
}

const OPTIONAL_TEXT = ['payerName', 'payerDocument', 'reference', 'receivedAt'] as const;

/**
 * Parses one JSON line describing an incoming bank transfer:
 * `{ currency, amount, payerName?, payerDocument?, reference?, receivedAt? }`.
 * The amount may be a decimal string (preferred) or a JSON number. Unknown
 * keys are dropped; the API validates the values.
 */
export function parseTransferLine(line: string): TransferMatchRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error('The line is not JSON.');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('The line is not a JSON object.');
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.currency !== 'string' || record.currency.length === 0) {
    throw new Error('currency must be a currency code such as "ARS".');
  }
  const amount =
    typeof record.amount === 'number' && Number.isFinite(record.amount)
      ? String(record.amount)
      : record.amount;
  if (typeof amount !== 'string' || amount.length === 0) {
    throw new Error('amount must be a decimal string such as "125050.00".');
  }
  const transfer: TransferMatchRequest = {
    currency: record.currency as TransferMatchRequest['currency'],
    amount,
  };
  for (const key of OPTIONAL_TEXT) {
    const field = record[key];
    if (field === undefined || field === null) continue;
    if (typeof field !== 'string') throw new Error(`${key} must be a string.`);
    transfer[key] = field;
  }
  return transfer;
}
