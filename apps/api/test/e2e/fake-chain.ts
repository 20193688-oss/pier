import { ApiError } from '@/common/api-error';
import type { AccountState, TrustlineState } from '@/chain/chain-client.service';

/**
 * A stand-in for `ChainClient` in the wiring suites, which need no network:
 * every account is missing (so SEP-10 checks the master key's signature), and
 * every other read answers the 503 a node that cannot be reached answers.
 * A deployment therefore never verifies: chain routes answer 503, which is
 * neither a 401 nor a 403.
 */
export class FakeChain {
  /** Accounts a test made exist. */
  readonly accounts = new Map<string, AccountState>();

  async account(_n: unknown, address: string): Promise<AccountState | null> {
    return this.accounts.get(address) ?? null;
  }

  async loadAccount(): Promise<null> {
    return null;
  }

  async trustlines(
    _n: unknown,
    _address: string,
    tokens: readonly unknown[],
  ): Promise<(TrustlineState | null)[]> {
    return tokens.map(() => null);
  }

  private unavailable(): never {
    throw ApiError.unavailable('The network cannot be reached right now.', 'fake chain');
  }

  server(): never {
    return this.unavailable();
  }
  simulate(): never {
    return this.unavailable();
  }
  send(): never {
    return this.unavailable();
  }
  getTransaction(): never {
    return this.unavailable();
  }
  getEvents(): never {
    return this.unavailable();
  }
  latestLedger(): never {
    return this.unavailable();
  }
  health(): never {
    return this.unavailable();
  }
  ledgerEntries(): never {
    return this.unavailable();
  }
  contractWasmHash(): never {
    return this.unavailable();
  }
  warn(): void {}
}
