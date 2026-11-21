import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  FeeBumpTransaction,
  Transaction,
  TransactionBuilder,
  WebAuth,
  rpc,
} from '@stellar/stellar-sdk';
import { ChainClient } from '@/chain/chain-client.service';
import { DeploymentsService, type Deployment } from '@/chain/deployments.service';
import { MarketReader } from '@/chain/market-reader.service';
import type { Tier } from '@/chain/networks';
import { USER_TX_TTL_SECONDS } from '@/chain/tx-builder.service';
import { ApiError, ErrorCode } from '@/common/api-error';
import { clientSubject } from '@/common/client-ip';
import { DataCipher } from '@/common/data-cipher';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { ChargesService } from '@/p2p/charges.service';
import { P2P_SPONSOR_LOCK_CLASS, P2P_SUBMIT_WAIT_MS } from '@/p2p/domain/constants';
import { checkSubmission, type SubmissionKind } from '@/p2p/domain/submit-policy';
import { PrismaService } from '@/prisma/prisma.service';

/** Seconds of clock skew a transaction's upper bound may carry past the build TTL. */
const TTL_SKEW_SECONDS = 60;
/** HKDF label of the key client addresses are MACed under on submissions. */
const SUBMIT_CLIENT_KEY_LABEL = 'pier submission client v1';

/** Who submits: a wallet session (for itself) or an organization (for its accounts). */
export type SubmitPrincipal =
  | { channel: 'app'; tier: Tier; address: string }
  | { channel: 'org'; tier: Tier; organizationId: string };

export interface SubmissionView {
  hash: string;
  network: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  error: string | null;
  feeBumpHash: string | null;
  ledger: number | null;
  sponsored: boolean;
}

interface Row {
  id: string;
  hash: string;
  feeBumpHash: string | null;
  network: string;
  status: string;
  error: string | null;
  ledger: number | null;
  sponsored: boolean;
  envelope: string;
  outer: string | null;
  tier: string;
  maxTime: Date;
  sentAt: Date | null;
}

const SELECT = {
  id: true,
  hash: true,
  feeBumpHash: true,
  network: true,
  status: true,
  error: true,
  ledger: true,
  sponsored: true,
  envelope: true,
  outer: true,
  tier: true,
  maxTime: true,
  sentAt: true,
} as const;

/** A network's refusal of a transaction, as a short code (`txBAD_SEQ`, `tx_failed: ...`). */
export function resultError(result: unknown): string {
  try {
    const json = JSON.stringify((result as { toJSON?: () => unknown })?.toJSON?.() ?? result);
    return json.length > 300 ? `${json.slice(0, 300)}…` : json;
  } catch {
    return String(result);
  }
}

/**
 * Gasless submission. A wallet signs the transaction the API built; the API
 * checks it against the policy (`submit-policy.ts`: one allowed operation or
 * the sponsored-activation shape, time bounds, fee cap), checks who may
 * submit for its source (the session's own account, or an account registered
 * to the organization and tier) and that the source really signed it for
 * THIS network (the passphrase check: the signature verifies only over this
 * network's hash), applies the per-address and per-IP limits and the
 * sponsor's daily budget, then wraps it in a fee-bump paid by the sponsor (or
 * submits it as signed when gasless is off), WRITES it, broadcasts it and
 * waits up to about 15 s. Only the stored bytes are ever sent again
 * (`SubmissionFollowerJob`).
 *
 * The sponsor's key signs only fee-bumps of transactions that passed the
 * policy, and an activation's sponsorship operations: it can never move a
 * token (it holds only lumens).
 */
@Injectable()
export class SubmissionsService {
  private readonly logger = new Logger(SubmissionsService.name);
  private clientSecret?: Buffer;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly reader: MarketReader,
    private readonly chain: ChainClient,
    private readonly cipher: DataCipher,
    private readonly charges: ChargesService,
  ) {}

  private clientKey(ip: string): string {
    this.clientSecret ??= this.cipher.derive(SUBMIT_CLIENT_KEY_LABEL);
    return createHmac('sha256', this.clientSecret).update(clientSubject(ip)).digest('base64url');
  }

  private refuse(error: string): ApiError {
    return ApiError.badRequest(ErrorCode.SubmissionRefused, 'This transaction is not submitted.', [
      error,
    ]);
  }

  async submit(
    principal: SubmitPrincipal,
    dto: { xdr: string; network?: string },
    ip: string,
  ): Promise<SubmissionView> {
    const d = await this.reader.requireLive(
      principal.tier,
      this.deployments.pick(principal.tier, dto.network).network,
    );
    let parsed: Transaction | FeeBumpTransaction;
    try {
      parsed = TransactionBuilder.fromXDR(dto.xdr, d.passphrase);
    } catch {
      throw this.refuse('xdr is not a transaction envelope');
    }
    if (parsed instanceof FeeBumpTransaction) {
      throw this.refuse('submit the signed inner transaction, not a fee-bump');
    }
    const tx = parsed;
    const hash = Buffer.from(tx.hash()).toString('hex');
    const existing = await this.prisma.p2pSubmission.findUnique({
      where: { hash },
      select: { ...SELECT, source: true },
    });
    if (existing) {
      // The same signed bytes again: where they stand, to whoever may submit for them.
      await this.checkSubmitter(principal, existing.source);
      return this.follow(d, existing, P2P_SUBMIT_WAIT_MS);
    }

    const sponsor = this.deployments.sponsorKey();
    const check = checkSubmission(tx, {
      contract: d.contract,
      tokens: d.tokens,
      sponsor: sponsor?.publicKey() ?? null,
      now: Math.floor(Date.now() / 1000),
      maxFeeStroops: this.config.sponsor.limits.maxFeeStroops,
      maxTtlSeconds: USER_TX_TTL_SECONDS + TTL_SKEW_SECONDS,
    });
    if (!check.ok) throw this.refuse(check.error);
    await this.checkSubmitter(principal, check.account);
    await this.checkSigned(d, tx, check.account);

    // An activation's sponsorship operations carry the sponsor's own signature.
    if (check.kind === 'activation' && sponsor) tx.sign(sponsor);
    const sponsored = sponsor !== null && tx.source !== sponsor.publicKey();
    let outer: FeeBumpTransaction | null = null;
    if (sponsored && sponsor) {
      const inclusion = this.inclusionFeePerOp(tx);
      outer = TransactionBuilder.buildFeeBumpTransaction(
        sponsor,
        String(Math.max(100, inclusion)),
        tx,
        d.passphrase,
      );
      outer.sign(sponsor);
    }
    const feeStroops = BigInt(outer ? outer.fee : sponsor && !sponsored ? tx.fee : '0');
    const row = await this.record(principal, d, {
      hash,
      tx,
      outer,
      kind: check.kind,
      account: check.account,
      maxTime: check.maxTime,
      feeStroops: sponsor ? feeStroops : 0n,
      reserveStroops: sponsor ? check.reserveStroops : 0n,
      clientKey: this.clientKey(ip),
    });
    await this.markSubmitted(hash);
    await this.broadcast(d, row);
    return this.follow(d, (await this.load(row.id)) as Row, P2P_SUBMIT_WAIT_MS);
  }

  private inclusionFeePerOp(tx: Transaction): number {
    const env = tx.toEnvelope();
    let resource = 0n;
    if (env.type === 'envelopeTypeTx') {
      const ext = env.v1.tx.ext;
      if (ext.type === 'sorobanData') resource = BigInt(ext.sorobanData.resourceFee);
    }
    return Math.ceil(Number(BigInt(tx.fee) - resource) / tx.operations.length);
  }

  /** The session's own account, or an account of the organization on its tier. */
  private async checkSubmitter(principal: SubmitPrincipal, account: string): Promise<void> {
    if (principal.channel === 'app') {
      if (account !== principal.address) {
        throw this.refuse('the transaction must act for your own account');
      }
      return;
    }
    const registered = await this.prisma.p2pAccount.count({
      where: { organizationId: principal.organizationId, tier: principal.tier, address: account },
    });
    if (registered === 0) {
      throw this.refuse(
        'the transaction must act for an account registered to your organization on this tier',
      );
    }
  }

  /**
   * The account signed this exact transaction for THIS network: a signature
   * verifies over the network-bound hash with its master key or one of its
   * signers. A transaction signed for another network fails here.
   */
  private async checkSigned(d: Deployment, tx: Transaction, account: string): Promise<void> {
    if (WebAuth.verifyTxSignedBy(tx, account)) return;
    const state = await this.chain.account(d, account);
    const keys = (state?.signers ?? []).map((s) => s.key).filter((k) => k.startsWith('G'));
    if (keys.length > 0 && WebAuth.gatherTxSigners(tx, keys).length > 0) return;
    throw ApiError.badRequest(
      ErrorCode.SignatureInvalid,
      `The transaction is not signed by ${account} for ${d.name}.`,
    );
  }

  /** Limits, budget and the row, as one step under the sponsor's lock. */
  private async record(
    principal: SubmitPrincipal,
    d: Deployment,
    input: {
      hash: string;
      tx: Transaction;
      outer: FeeBumpTransaction | null;
      kind: SubmissionKind;
      account: string;
      maxTime: number;
      feeStroops: bigint;
      reserveStroops: bigint;
      clientKey: string;
    },
  ): Promise<Row> {
    const limits = this.config.sponsor.limits;
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3600_000);
    const dayAgo = new Date(now.getTime() - 24 * 3600_000);
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${P2P_SPONSOR_LOCK_CLASS}::int, hashtext(${d.network}))`;
      const [byAddress, byClient] = await Promise.all([
        tx.p2pSubmission.count({ where: { source: input.account, createdAt: { gt: hourAgo } } }),
        tx.p2pSubmission.count({
          where: { clientKey: input.clientKey, createdAt: { gt: hourAgo } },
        }),
      ]);
      const retry = (seconds: number) => ApiError.rateLimited(seconds);
      if (byAddress >= limits.perAddressPerHour || byClient >= limits.perIpPerHour) {
        throw retry(600);
      }
      if (input.kind === 'activation') {
        const activations = await tx.p2pSubmission.count({
          where: { clientKey: input.clientKey, kind: 'activation', createdAt: { gt: dayAgo } },
        });
        if (activations >= limits.activationsPerIpPerDay) throw retry(3600);
      }
      if (input.feeStroops + input.reserveStroops > 0n) {
        const spent = await tx.p2pSubmission.aggregate({
          where: { network: d.network, createdAt: { gte: midnight } },
          _sum: { feeStroops: true, reserveStroops: true },
        });
        const total =
          (spent._sum.feeStroops ?? 0n) +
          (spent._sum.reserveStroops ?? 0n) +
          input.feeStroops +
          input.reserveStroops;
        if (total > limits.dailyBudgetStroops) {
          const tomorrow = midnight.getTime() + 24 * 3600_000;
          throw new ApiError(
            503,
            ErrorCode.BudgetExhausted,
            'The fee sponsor’s budget for today is spent: try again tomorrow.',
            undefined,
            Math.max(60, Math.ceil((tomorrow - now.getTime()) / 1000)),
          );
        }
      }
      return tx.p2pSubmission.create({
        data: {
          hash: input.hash,
          feeBumpHash: input.outer ? Buffer.from(input.outer.hash()).toString('hex') : null,
          tier: d.tier,
          network: d.network,
          channel: principal.channel,
          organizationId: principal.channel === 'org' ? principal.organizationId : null,
          source: input.account,
          kind: input.kind,
          envelope: input.tx.toXDR(),
          outer: input.outer?.toXDR() ?? null,
          sponsored: input.outer !== null || input.feeStroops > 0n,
          feeStroops: input.feeStroops,
          reserveStroops: input.reserveStroops,
          clientKey: input.clientKey,
          maxTime: new Date(input.maxTime * 1000),
        },
        select: SELECT,
      });
    });
  }

  private load(id: string): Promise<Row | null> {
    return this.prisma.p2pSubmission.findUnique({ where: { id }, select: SELECT });
  }

  /** Sends a row's stored bytes; a refusal of those exact bytes fails it. */
  async broadcast(d: Deployment, row: Row): Promise<void> {
    const bytes = row.outer ?? row.envelope;
    const envelope = row.outer
      ? new FeeBumpTransaction(bytes, d.passphrase)
      : new Transaction(bytes, d.passphrase);
    try {
      const sent = await this.chain.send(d, envelope);
      if (sent.status === 'ERROR') {
        await this.settle(row, 'FAILED', resultError(sent.errorResult), null);
        return;
      }
      await this.prisma.p2pSubmission.updateMany({
        where: { id: row.id },
        data: { sentAt: new Date() },
      });
    } catch (err) {
      // Written: the follower sends these same bytes again.
      this.logger.warn(`Submission ${row.hash} not broadcast yet: ${String(err)}`);
    }
  }

  /** Polls a row for up to `waitMs`, answering where it stands. */
  async follow(d: Deployment, row: Row, waitMs: number): Promise<SubmissionView> {
    const until = Date.now() + waitMs;
    let current = row;
    while (current.status === 'PENDING') {
      current = await this.refresh(d, current);
      if (current.status !== 'PENDING' || Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return view(current);
  }

  /** Reads a pending row's result from the network once. */
  async refresh(d: Deployment, row: Row): Promise<Row> {
    if (row.status !== 'PENDING') return row;
    let got: rpc.Api.GetTransactionResponse;
    try {
      got = await this.chain.getTransaction(d, row.feeBumpHash ?? row.hash);
    } catch {
      return row;
    }
    if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      await this.settle(row, 'SUCCESS', null, got.ledger);
    } else if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
      await this.settle(row, 'FAILED', resultError(got.resultXdr), got.ledger);
    } else if (Date.now() > row.maxTime.getTime() + 30_000) {
      await this.settle(row, 'FAILED', 'expired: the network never applied it', null);
    }
    return (await this.load(row.id)) as Row;
  }

  /** The transfers and charge payments this transaction carries went out. */
  private async markSubmitted(hash: string): Promise<void> {
    await this.prisma.appTransfer.updateMany({
      where: { hash, status: 'PENDING' },
      data: { status: 'SUBMITTED' },
    });
    await this.prisma.p2pChargePayment.updateMany({
      where: { hash, status: 'PENDING' },
      data: { status: 'SUBMITTED' },
    });
  }

  /**
   * A final status, once (compare-and-swap on PENDING), with what it settles
   * in the same transaction: the transfer it carried, and the charge it paid
   * (`P2P_CHARGE_SUCCEEDED`, `paidWith: 'TOKEN'`) once the transfer succeeded
   * on-chain.
   */
  private async settle(
    row: Row,
    status: 'SUCCESS' | 'FAILED',
    error: string | null,
    ledger: number | null,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.p2pSubmission.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { status, error, ledger },
      });
      if (moved.count !== 1) return;
      const ok = status === 'SUCCESS';
      await tx.appTransfer.updateMany({
        where: { hash: row.hash, status: { in: ['PENDING', 'SUBMITTED'] } },
        data: { status: ok ? 'COMPLETED' : 'FAILED', completedAt: now },
      });
      const payments = await tx.p2pChargePayment.findMany({
        where: { hash: row.hash, status: { in: ['PENDING', 'SUBMITTED'] } },
        select: { id: true, chargeId: true, hash: true, amount: true },
      });
      for (const payment of payments) {
        const paid = await tx.p2pChargePayment.updateMany({
          where: { id: payment.id, status: { in: ['PENDING', 'SUBMITTED'] } },
          data: { status: ok ? 'COMPLETED' : 'FAILED', completedAt: now },
        });
        if (ok && paid.count === 1) await this.charges.onTokenPayment(tx, payment);
      }
    });
  }

  /** A submission the caller may read: its own account's (app) or its organization's (org). */
  async get(principal: SubmitPrincipal, hash: string): Promise<SubmissionView> {
    const wanted = hash.toLowerCase();
    const row = /^[0-9a-f]{64}$/.test(wanted)
      ? await this.prisma.p2pSubmission.findFirst({
          where: {
            OR: [{ hash: wanted }, { feeBumpHash: wanted }],
            tier: principal.tier,
            ...(principal.channel === 'app'
              ? { channel: 'app', source: principal.address }
              : { channel: 'org', organizationId: principal.organizationId }),
          },
          select: SELECT,
        })
      : null;
    if (!row) throw ApiError.notFound(`Submission ${hash} not found`);
    const d = this.deployments.find(row.tier as Tier, row.network);
    return d ? view(await this.refresh(d, row)) : view(row);
  }
}

function view(row: Row): SubmissionView {
  return {
    hash: row.hash,
    network: row.network,
    status: row.status as SubmissionView['status'],
    error: row.error,
    feeBumpHash: row.feeBumpHash,
    ledger: row.ledger,
    sponsored: row.sponsored,
  };
}

export type { Row as SubmissionRow };
export { SELECT as SUBMISSION_SELECT };
