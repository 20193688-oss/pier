import { Injectable, Logger } from '@nestjs/common';
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';
import { ChainCallReverted, ChainClient } from '@/chain/chain-client.service';
import { DeploymentsService, type StellarNetwork } from '@/chain/deployments.service';
import { marketErrorName } from '@/chain/market-codec';
import type { Token } from '@/chain/networks';
import { ApiError, ErrorCode } from '@/common/api-error';
import { formatUnits } from '@/p2p/domain/pricing';

/** Every transaction a wallet signs expires at most this far ahead. */
export const USER_TX_TTL_SECONDS = 300;
/** How long the API waits for a restore it pays for. */
const RESTORE_WAIT_MS = 30_000;

/** An unsigned, prepared transaction for a wallet (the API's `P2pTransaction`). */
export interface BuiltTransaction {
  network: string;
  action: string;
  description: string;
  xdr: string;
  hash: string;
  expiresAt: Date;
}

export function builtView(
  n: { network: string },
  tx: Transaction,
  action: string,
  description: string,
): BuiltTransaction {
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  return {
    network: n.network,
    action,
    description,
    xdr: tx.toXDR(),
    hash: Buffer.from(tx.hash()).toString('hex'),
    expiresAt: new Date(maxTime * 1000),
  };
}

/** A whole-token decimal (`12.5`) of base units, trailing zeros dropped. */
export function humanAmount(amount: bigint, decimals: number): string {
  return formatUnits(amount, decimals).replace(/\.?0+$/, '');
}

/** The SAC `transfer(from, to, amount)` operation. */
export function sacTransferOperation(
  token: Token,
  from: string,
  to: string,
  amount: bigint,
): xdr.Operation {
  return Operation.invokeContractFunction({
    contract: token.contract,
    function: 'transfer',
    args: [
      nativeToScVal(from, { type: 'address' }),
      nativeToScVal(to, { type: 'address' }),
      nativeToScVal(amount, { type: 'i128' }),
    ],
  });
}

/**
 * Builds every transaction a wallet signs: the wallet as source, ONE
 * operation, time bounds at most {@link USER_TX_TTL_SECONDS} ahead, and for
 * contract calls the simulation's resource fee, footprint and auth entries
 * (`assembleTransaction`). An archived entry the call needs is restored first
 * by the sponsor (a `RestoreFootprint` it pays for and waits on), so the
 * wallet still signs exactly one operation. Nothing is signed here.
 */
@Injectable()
export class TxBuilder {
  private readonly logger = new Logger(TxBuilder.name);

  constructor(
    private readonly chain: ChainClient,
    private readonly deployments: DeploymentsService,
  ) {}

  /** The wallet's account on the network, or `400 account_missing`. */
  async sourceAccount(n: StellarNetwork, address: string): Promise<Account> {
    const account = await this.chain.loadAccount(n, address);
    if (!account) {
      throw ApiError.badRequest(
        ErrorCode.AccountMissing,
        `The account ${address} does not exist on ${n.name} yet: activate it first (POST /v1/app/activate).`,
      );
    }
    return account;
  }

  private builder(
    n: StellarNetwork,
    source: Account,
    fee = BASE_FEE,
    ttlSeconds = USER_TX_TTL_SECONDS,
  ): TransactionBuilder {
    return new TransactionBuilder(source, { fee, networkPassphrase: n.passphrase }).setTimeout(
      ttlSeconds,
    );
  }

  /**
   * A prepared contract call for `source` to sign. A call the contract would
   * refuse is a `ChainCallReverted` naming its error, before anything is built.
   */
  async invoke(
    n: StellarNetwork,
    source: string,
    op: xdr.Operation,
    action: string,
    description: string,
  ): Promise<BuiltTransaction> {
    const prepared = await this.prepare(n, await this.sourceAccount(n, source), op);
    return builtView(n, prepared, action, description);
  }

  /** Simulates and assembles one operation from `account` (restoring archived entries first). */
  async prepare(
    n: StellarNetwork,
    account: Account,
    op: xdr.Operation,
    ttlSeconds = USER_TX_TTL_SECONDS,
  ): Promise<Transaction> {
    const sequence = account.sequenceNumber();
    for (let attempt = 0; attempt < 2; attempt++) {
      const tx = this.builder(n, new Account(account.accountId(), sequence), BASE_FEE, ttlSeconds)
        .addOperation(op)
        .build();
      const sim = await this.chain.simulate(n, tx);
      if (rpc.Api.isSimulationError(sim)) {
        throw new ChainCallReverted(marketErrorName(sim.error), sim.error);
      }
      if (rpc.Api.isSimulationRestore(sim) && attempt === 0) {
        await this.restore(n, sim.restorePreamble);
        continue;
      }
      return rpc.assembleTransaction(tx, sim).build();
    }
    throw ApiError.unavailable(
      'The network asked to restore archived data twice: try again shortly.',
      'restore preamble after a restore',
    );
  }

  /**
   * Restores archived ledger entries, paid by the sponsor (it holds only
   * lumens; a restore moves nothing). Without a sponsor the caller must
   * restore them itself: `409 restore_required`.
   */
  async restore(
    n: StellarNetwork,
    preamble: { minResourceFee: string; transactionData: { build(): xdr.SorobanTransactionData } },
  ): Promise<void> {
    const sponsor = this.deployments.sponsorKey();
    if (!sponsor) {
      throw ApiError.conflict(
        ErrorCode.RestoreRequired,
        'Some of the contract’s data is archived and must be restored first (RestoreFootprint).',
      );
    }
    const account = await this.chain.loadAccount(n, sponsor.publicKey());
    if (!account) throw ApiError.unavailable('The sponsor account does not exist on this network.');
    const fee = (BigInt(BASE_FEE) + BigInt(preamble.minResourceFee)).toString();
    const tx = new TransactionBuilder(account, { fee, networkPassphrase: n.passphrase })
      .setSorobanData(preamble.transactionData.build())
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(60)
      .build();
    tx.sign(sponsor);
    const hash = await this.sendAndWait(n, tx, RESTORE_WAIT_MS);
    this.logger.log(`Restored archived entries on ${n.network} (${hash})`);
  }

  /** Sends a signed transaction and waits for its result; throws unless it succeeded. */
  async sendAndWait(n: StellarNetwork, tx: Transaction, waitMs: number): Promise<string> {
    const sent = await this.chain.send(n, tx);
    if (sent.status === 'ERROR') {
      throw ApiError.unavailable('The network refused a transaction.', `send: ${sent.status}`);
    }
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      const got = await this.chain.getTransaction(n, sent.hash);
      if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) return sent.hash;
      if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw ApiError.unavailable('A transaction failed on the network.', `${sent.hash} failed`);
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw ApiError.unavailable('The network did not confirm in time.', `${sent.hash} pending`);
  }

  /** A classic `payment` of a token for `source` to sign. */
  async payment(
    n: StellarNetwork,
    source: string,
    destination: string,
    token: Token,
    amount: bigint,
    memo: string | null,
    ttlSeconds = USER_TX_TTL_SECONDS,
  ): Promise<BuiltTransaction> {
    const builder = this.builder(
      n,
      await this.sourceAccount(n, source),
      BASE_FEE,
      ttlSeconds,
    ).addOperation(
      Operation.payment({
        destination,
        asset: new Asset(token.code, token.issuer),
        amount: formatUnits(amount, token.decimals),
      }),
    );
    if (memo) builder.addMemo(Memo.text(memo));
    const tx = builder.build();
    return builtView(
      n,
      tx,
      'transfer',
      `Send ${humanAmount(amount, token.decimals)} ${token.symbol} to ${destination}`,
    );
  }

  /**
   * A SAC `transfer` to a contract address for `source` to sign (simulated,
   * prepared). Soroban transactions carry no memo: a note stays off-chain.
   */
  async sacTransfer(
    n: StellarNetwork,
    source: string,
    to: string,
    token: Token,
    amount: bigint,
    ttlSeconds = USER_TX_TTL_SECONDS,
  ): Promise<BuiltTransaction> {
    const account = await this.sourceAccount(n, source);
    const op = sacTransferOperation(token, source, to, amount);
    const tx = await this.prepare(n, account, op, ttlSeconds);
    return builtView(
      n,
      tx,
      'transfer',
      `Send ${humanAmount(amount, token.decimals)} ${token.symbol} to ${to}`,
    );
  }

  /**
   * The sponsored activation (CAP-33): the sponsor pays the reserves of the
   * account (created with 0 XLM when it is missing) and of the token's
   * trustline. Null when there is nothing to do. When the account is missing
   * the transaction's source is the SPONSOR (a missing account has no
   * sequence number), and the API adds the sponsor's signature at submit.
   */
  async activation(
    n: StellarNetwork,
    user: string,
    token: Token,
  ): Promise<BuiltTransaction | null> {
    const sponsor = this.deployments.sponsorAddress();
    if (!sponsor) {
      throw ApiError.unavailable(
        'Sponsored activation is not available right now.',
        'P2P_SPONSOR_SECRET is not set.',
      );
    }
    const state = await this.chain.account(n, user);
    if (state) {
      const [trustline] = await this.chain.trustlines(n, user, [token]);
      if (trustline) return null;
    }
    const source = state
      ? new Account(user, state.sequence.toString())
      : await this.chain.loadAccount(n, sponsor);
    if (!source) throw ApiError.unavailable('The sponsor account does not exist on this network.');
    const ops: xdr.Operation[] = [
      Operation.beginSponsoringFutureReserves({ sponsoredId: user, source: sponsor }),
      ...(state
        ? []
        : [Operation.createAccount({ destination: user, startingBalance: '0', source: sponsor })]),
      Operation.changeTrust({ asset: new Asset(token.code, token.issuer), source: user }),
      Operation.endSponsoringFutureReserves({ source: user }),
    ];
    const builder = this.builder(n, source, (Number(BASE_FEE) * ops.length).toString());
    for (const op of ops) builder.addOperation(op);
    return builtView(
      n,
      builder.build(),
      'activate',
      state
        ? `Open your ${token.symbol} trustline (the reserve is sponsored)`
        : `Create your account and open your ${token.symbol} trustline (the reserves are sponsored)`,
    );
  }
}

/** A keypair's signature on a transaction, added in place (the sponsor's, at submit). */
export function addSignature(tx: Transaction, key: Keypair): void {
  tx.sign(key);
}
