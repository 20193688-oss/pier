import { Injectable, Logger } from '@nestjs/common';
import {
  Account,
  Asset,
  Contract,
  FeeBumpTransaction,
  Keypair,
  SignerKey,
  Transaction,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { ApiError } from '@/common/api-error';
import { DeploymentsService, type StellarNetwork } from '@/chain/deployments.service';
import type { Token } from '@/chain/networks';

/** A call the contract (or the host) refuses in simulation: `contractError` names the contract error when known. */
export class ChainCallReverted extends Error {
  constructor(
    readonly contractError: string | null,
    readonly detail: string,
  ) {
    super(`refused${contractError ? ` (${contractError})` : ''}`);
    this.name = 'ChainCallReverted';
  }
}

/** An account as the ledger holds it. */
export interface AccountState {
  address: string;
  sequence: bigint;
  /** Lumens, stroops. */
  balance: bigint;
  /** Master key weight and the low / medium / high thresholds. */
  thresholds: { master: number; low: number; medium: number; high: number };
  /** Every signer other than the master key: `G...` keys (and other signer kinds by their StrKey). */
  signers: { key: string; weight: number }[];
  subentries: number;
}

/** A trustline as the ledger holds it. */
export interface TrustlineState {
  balance: bigint;
  limit: bigint;
  /** AUTHORIZED_FLAG: may receive and send. */
  authorized: boolean;
}

const AUTHORIZED_FLAG = 1;

/** The contract error code in a host error text (`Error(Contract, #12)`), or null. */
export function contractErrorCode(text: string): number | null {
  const match = /Error\(Contract, #(\d+)\)/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Every RPC the market makes, through stellar-sdk's Soroban RPC client, one
 * client per network and node. Before a client is used its node must answer
 * the network's passphrase (`getNetwork`): a node on another network is
 * refused, never trusted. Horizon is not needed.
 */
@Injectable()
export class ChainClient {
  private readonly logger = new Logger(ChainClient.name);
  private readonly servers = new Map<string, rpc.Server>();
  private readonly checked = new Map<string, Promise<void>>();

  constructor(private readonly deployments: DeploymentsService) {}

  private raw(n: StellarNetwork): rpc.Server {
    let server = this.servers.get(n.rpcUrl);
    if (!server) {
      server = new rpc.Server(n.rpcUrl, {
        allowHttp: n.rpcUrl.startsWith('http://'),
        timeout: this.deployments.timeoutMs(),
      });
      this.servers.set(n.rpcUrl, server);
    }
    return server;
  }

  /** The client of a network whose node answered the right passphrase. */
  async server(n: StellarNetwork): Promise<rpc.Server> {
    const server = this.raw(n);
    const key = `${n.network}:${n.rpcUrl}`;
    let check = this.checked.get(key);
    if (!check) {
      check = server.getNetwork().then(
        (answer) => {
          if (answer.passphrase !== n.passphrase) {
            throw ApiError.unavailable(
              `The market is not available on ${n.name} right now.`,
              `The node for ${n.network} answered the passphrase "${answer.passphrase}".`,
            );
          }
        },
        (err: unknown) => {
          throw ApiError.unavailable(
            `${n.name} cannot be reached right now.`,
            `getNetwork on ${n.network} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
      // A failed check (node down, wrong network) is tried again on the next call.
      check.catch(() => this.checked.delete(key));
      this.checked.set(key, check);
    }
    await check;
    return server;
  }

  private async call<T>(
    n: StellarNetwork,
    what: string,
    run: (s: rpc.Server) => Promise<T>,
  ): Promise<T> {
    const server = await this.server(n);
    try {
      return await run(server);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw ApiError.unavailable(
        `${n.name} cannot be reached right now.`,
        `${what} on ${n.network} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  simulate(n: StellarNetwork, tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse> {
    return this.call(n, 'simulateTransaction', (s) => s.simulateTransaction(tx));
  }

  send(
    n: StellarNetwork,
    tx: Transaction | FeeBumpTransaction,
  ): Promise<rpc.Api.SendTransactionResponse> {
    return this.call(n, 'sendTransaction', (s) => s.sendTransaction(tx));
  }

  getTransaction(n: StellarNetwork, hash: string): Promise<rpc.Api.GetTransactionResponse> {
    return this.call(n, 'getTransaction', (s) => s.getTransaction(hash));
  }

  getEvents(
    n: StellarNetwork,
    request: rpc.Api.GetEventsRequest,
  ): Promise<rpc.Api.GetEventsResponse> {
    return this.call(n, 'getEvents', (s) => s.getEvents(request));
  }

  latestLedger(n: StellarNetwork): Promise<rpc.Api.GetLatestLedgerResponse> {
    return this.call(n, 'getLatestLedger', (s) => s.getLatestLedger());
  }

  health(n: StellarNetwork): Promise<rpc.Api.GetHealthResponse> {
    return this.call(n, 'getHealth', (s) => s.getHealth());
  }

  ledgerEntries(
    n: StellarNetwork,
    keys: xdr.LedgerKey[],
  ): Promise<rpc.Api.GetLedgerEntriesResponse> {
    return this.call(n, 'getLedgerEntries', (s) => s.getLedgerEntries(...keys));
  }

  /** An account's entry, or null when it does not exist. */
  async account(n: StellarNetwork, address: string): Promise<AccountState | null> {
    const key = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrPublicKey() }),
    );
    const res = await this.ledgerEntries(n, [key]);
    const entry = res.entries[0]?.val;
    if (!entry || entry.type !== 'account') return null;
    return accountStateOf(address, entry.account);
  }

  /** A sequence-ready `Account` for a transaction builder, or null when it does not exist. */
  async loadAccount(n: StellarNetwork, address: string): Promise<Account | null> {
    const state = await this.account(n, address);
    return state ? new Account(address, state.sequence.toString()) : null;
  }

  /** The trustlines of `address` to each token (null where there is none). */
  async trustlines(
    n: StellarNetwork,
    address: string,
    tokens: readonly Token[],
  ): Promise<(TrustlineState | null)[]> {
    if (tokens.length === 0) return [];
    const keys = tokens.map((t) =>
      xdr.LedgerKey.trustline(
        new xdr.LedgerKeyTrustLine({
          accountId: Keypair.fromPublicKey(address).xdrAccountId(),
          asset: new Asset(t.code, t.issuer).toTrustLineXdrObject(),
        }),
      ),
    );
    const res = await this.ledgerEntries(n, keys);
    return keys.map((k) => {
      const wanted = k.toXdr('base64');
      const found = res.entries.find((e) => e.key.toXdr('base64') === wanted)?.val;
      if (!found || found.type !== 'trustline') return null;
      const tl = found.trustLine;
      return {
        balance: BigInt(tl.balance),
        limit: BigInt(tl.limit),
        authorized: (tl.flags & AUTHORIZED_FLAG) !== 0,
      };
    });
  }

  /** The hex sha256 of the wasm a contract runs, or null (no such contract, or not a wasm contract). */
  async contractWasmHash(n: StellarNetwork, contractId: string): Promise<string | null> {
    const res = await this.ledgerEntries(n, [new Contract(contractId).getFootprint()]);
    const entry = res.entries[0]?.val;
    if (!entry || entry.type !== 'contractData') return null;
    const scv = entry.contractData.val;
    if (scv.type !== 'scvContractInstance') return null;
    const exec = scv.instance.executable;
    if (exec.type !== 'contractExecutableWasm') return null;
    return Buffer.from(exec.wasmHash.value).toString('hex');
  }

  warn(message: string): void {
    this.logger.warn(message);
  }
}

/** An account entry as `AccountState`. */
export function accountStateOf(address: string, a: xdr.AccountEntry): AccountState {
  const t = a.thresholds.value;
  return {
    address,
    sequence: BigInt(a.seqNum),
    balance: BigInt(a.balance),
    thresholds: { master: t[0], low: t[1], medium: t[2], high: t[3] },
    signers: a.signers.flatMap((s) => {
      try {
        return [{ key: SignerKey.encodeSignerKey(s.key), weight: s.weight }];
      } catch {
        return [];
      }
    }),
    subentries: a.numSubEntries,
  };
}
