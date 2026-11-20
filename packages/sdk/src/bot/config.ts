import { DEFAULT_MIN_SCORE, MAX_MATCH_SCORE } from '@/bot/choose-match';
import { BOT_NETWORKS, DEFAULT_MAX_FEE_STROOPS } from '@/bot/release';
import type { TransferMatchRequest } from '@/types';

/** The reference bot's settings, read from the environment. */
export interface BotConfig {
  /** `PEDOSPE_API_URL`: the API origin. */
  apiUrl: string;
  /** `PEDOSPE_API_KEY`: the merchant organization's API key (`p2p:read` and `p2p:write`). */
  apiKey: string;
  /** `BOT_SECRET`: the merchant account's Stellar secret (S...), absent in a dry run. */
  secret: string | null;
  /** `MIN_SCORE`: the lowest score that releases (1 to 3, default 3). */
  minScore: number;
  /** `DRY_RUN`: decide and log, never sign or send. */
  dryRun: boolean;
  /** The API key's tier (its prefix). */
  tier: 'live' | 'test';
  /**
   * `MARKET_CONTRACT`: the market contract per network, from this configuration
   * only (`testnet=C...,mainnet=C...`; a bare `C...` is the tier's network:
   * mainnet for `pk_live_`, testnet for `pk_test_`).
   */
  marketContracts: Record<string, string>;
  /** `MAX_FEE_STROOPS`: the largest fee the bot signs (default 1 000 000 = 0.1 XLM). */
  maxFeeStroops: number;
}

type Env = Readonly<Record<string, string | undefined>>;

const SECRET = /^S[A-Z2-7]{55}$/;
const CONTRACT = /^C[A-Z2-7]{55}$/;

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

  const secret = value(env, 'BOT_SECRET');
  if (secret !== undefined && !SECRET.test(secret)) {
    problems.push('BOT_SECRET must be a Stellar secret seed (S...).');
  } else if (secret === undefined && !dryRun) {
    problems.push('BOT_SECRET is required unless DRY_RUN is set.');
  }

  const rawMinScore = value(env, 'MIN_SCORE');
  const minScore = rawMinScore === undefined ? DEFAULT_MIN_SCORE : Number(rawMinScore);
  if (!Number.isInteger(minScore) || minScore < 1 || minScore > MAX_MATCH_SCORE) {
    problems.push(`MIN_SCORE must be an integer from 1 to ${MAX_MATCH_SCORE}.`);
  }

  const tier = apiKey?.startsWith('pk_live_') ? 'live' : 'test';
  const marketContracts: Record<string, string> = {};
  const contracts = value(env, 'MARKET_CONTRACT');
  if (contracts === undefined) {
    problems.push('MARKET_CONTRACT is required: the market contract the bot may call (C...).');
  } else {
    for (const part of contracts.split(',').map((p) => p.trim())) {
      const [first, second] = part.split('=');
      const network = second === undefined ? (tier === 'live' ? 'mainnet' : 'testnet') : first;
      const contract = second ?? first;
      const known = BOT_NETWORKS[network];
      if (!known || !CONTRACT.test(contract)) {
        problems.push(
          'MARKET_CONTRACT must be C... or network=C... pairs (local, testnet, mainnet).',
        );
        break;
      }
      if (known.tier !== tier) {
        problems.push(`MARKET_CONTRACT names ${network}, which a ${tier} API key never signs on.`);
        break;
      }
      marketContracts[network] = contract;
    }
  }

  const rawFee = value(env, 'MAX_FEE_STROOPS');
  const maxFeeStroops = rawFee === undefined ? DEFAULT_MAX_FEE_STROOPS : Number(rawFee);
  if (!Number.isInteger(maxFeeStroops) || maxFeeStroops < 100 || maxFeeStroops > 100_000_000) {
    problems.push('MAX_FEE_STROOPS must be an integer from 100 to 100000000.');
  }

  if (problems.length > 0)
    throw new Error(`Invalid bot configuration:\n- ${problems.join('\n- ')}`);
  return {
    apiUrl: apiUrl as string,
    apiKey: apiKey as string,
    secret: secret ?? null,
    minScore,
    dryRun,
    tier,
    marketContracts,
    maxFeeStroops,
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
