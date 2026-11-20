import { Injectable } from '@nestjs/common';
import { DeploymentsService } from '@/chain/deployments.service';
import { p2pCall } from '@/chain/market-codec';
import { MarketReader } from '@/chain/market-reader.service';
import type { Tier } from '@/chain/networks';
import { TxBuilder } from '@/chain/tx-builder.service';
import { ApiError, ErrorCode } from '@/common/api-error';
import { DataCipher } from '@/common/data-cipher';
import { page, type Page } from '@/common/pagination';
import type { Prisma } from '@/generated/prisma/client';
import { isUuid } from '@/p2p/domain/order-ref';
import type { AdminDisputesQueryDto, AdminResolutionDto } from '@/p2p/dto/admin.dto';
import type { MerchantOrderView } from '@/p2p/entities/order.entity';
import { OrdersService } from '@/p2p/orders.service';
import { refusedByContract } from '@/p2p/transactions.service';
import { P2P_ORDER_SELECT } from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';

const MAX_I128 = (1n << 127n) - 1n;

/**
 * The platform console's part of the market: the disputes waiting for the
 * arbiter, one order in full (both parties' details, for the evidence), the
 * arbiter's `resolve` transaction built for its own wallet to sign (the
 * arbiter's key is never on this server), and merchant suspension. Every read
 * of personal data and every write is recorded in the audit log.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly reader: MarketReader,
    private readonly orders: OrdersService,
    private readonly cipher: DataCipher,
    private readonly builder: TxBuilder,
  ) {}

  private audit(
    tx: Prisma.TransactionClient | PrismaService,
    actor: string,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata?: Record<string, string>,
  ) {
    return tx.auditLog.create({
      data: { actor, action, resourceType, resourceId, ...(metadata ? { metadata } : {}) },
    });
  }

  async disputes(query: AdminDisputesQueryDto): Promise<Page<MerchantOrderView>> {
    const where = { status: 'disputed', ...(query.tier ? { tier: query.tier } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.p2pOrder.findMany({
        where,
        orderBy: { updatedAt: 'asc' },
        take: query.take,
        skip: query.skip,
        select: P2P_ORDER_SELECT,
      }),
      this.prisma.p2pOrder.count({ where }),
    ]);
    return page(await Promise.all(rows.map((r) => this.orders.merchantView(r))), total, query);
  }

  private async load(id: string) {
    const row = isUuid(id)
      ? await this.prisma.p2pOrder.findUnique({
          where: { id },
          select: { ...P2P_ORDER_SELECT, payerInfo: true, beneficiary: true },
        })
      : null;
    if (!row) throw ApiError.notFound(`Order ${id} not found`);
    return row;
  }

  /** One order with both parties' details and its matcher transactions (audited). */
  async order(id: string, actor: string) {
    const { payerInfo, beneficiary, ...row } = await this.load(id);
    const [client, matcherTxs] = await Promise.all([
      this.orders.clientView(row, true),
      this.prisma.p2pMatcherTx.findMany({
        where: { orderId: id },
        orderBy: { createdAt: 'asc' },
        select: {
          kind: true,
          hash: true,
          sequence: true,
          status: true,
          lastError: true,
          createdAt: true,
        },
      }),
    ]);
    await this.audit(this.prisma, actor, 'p2p.order.read', 'p2p_order', id);
    return {
      ...client,
      organizationId: row.organizationId,
      merchantOrganizationId: row.merchantOrganizationId,
      merchantAccountId: row.merchantAccountId,
      payer: payerInfo
        ? this.cipher.open<Record<string, string>>('order.payer', id, payerInfo)
        : null,
      beneficiary: beneficiary
        ? this.cipher.open<Record<string, unknown>>('order.beneficiary', id, beneficiary)
        : null,
      matcherTransactions: matcherTxs.map((t) => ({
        ...t,
        sequence: t.sequence?.toString() ?? null,
      })),
    };
  }

  /**
   * The arbiter's `resolve(id, toBuyer, bondToSeller)`, unsigned, for its own
   * wallet (a multisig) to sign. Built only for a disputed order, with a split
   * the contract accepts, and naming the arbiter the contract has now.
   */
  async resolution(id: string, dto: AdminResolutionDto, actor: string) {
    const row = await this.load(id);
    if (row.status !== 'disputed' || !row.onchainId) {
      throw ApiError.badRequest(
        ErrorCode.InvalidState,
        `Order ${id} is ${row.status}: only a disputed order is resolved.`,
      );
    }
    const toBuyer = BigInt(dto.toBuyer);
    const bondToSeller = BigInt(dto.bondToSeller ?? '0');
    if (
      toBuyer > BigInt(row.tokenAmount) ||
      bondToSeller > BigInt(row.bond) ||
      toBuyer > MAX_I128
    ) {
      throw ApiError.validation([
        `toBuyer must be at most ${row.tokenAmount} and bondToSeller at most ${row.bond}`,
      ]);
    }
    const d = this.deployments.find(row.tier as Tier, row.network);
    if (!d) {
      throw ApiError.badRequest(
        ErrorCode.NetworkUnsupported,
        `The market is no longer configured on ${row.network} (${row.tier}).`,
      );
    }
    const arbiter = await this.reader.arbiter(d);
    let transaction;
    try {
      transaction = await this.builder.invoke(
        d,
        arbiter,
        p2pCall.resolve(d.contract, BigInt(row.onchainId), toBuyer, bondToSeller),
        'resolve',
        `Resolve order ${row.onchainId}: ${toBuyer} base units to the buyer, the rest to the seller, ${bondToSeller} of the bond to the seller`,
      );
    } catch (err) {
      refusedByContract(err);
    }
    await this.audit(this.prisma, actor, 'p2p.resolution.built', 'p2p_order', id, {
      toBuyer: toBuyer.toString(),
      bondToSeller: bondToSeller.toString(),
    });
    return { orderId: id, arbiter, transaction };
  }

  /** SUSPENDED stops a merchant from being matched; only the platform lifts it. */
  async setMerchantStatus(accountId: string, status: 'ACTIVE' | 'SUSPENDED', actor: string) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.p2pAccount.updateMany({
        where: { id: accountId },
        data: { merchantStatus: status },
      });
      if (updated.count !== 1) throw ApiError.notFound(`Account ${accountId} not found`);
      await this.audit(tx, actor, `p2p.merchant.${status.toLowerCase()}`, 'p2p_account', accountId);
      return tx.p2pAccount.findUniqueOrThrow({
        where: { id: accountId },
        select: { id: true, tier: true, address: true, displayName: true, merchantStatus: true },
      });
    });
  }
}
