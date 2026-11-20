import { Injectable } from '@nestjs/common';
import type { OrgPrincipal } from '@/auth/auth.types';
import { DeploymentsService } from '@/chain/deployments.service';
import { MarketReader } from '@/chain/market-reader.service';
import type { Tier } from '@/chain/networks';
import {
  P2P_CURRENCIES,
  P2P_TRANSFER_MATCHES_LIMIT,
  type P2pCurrency,
} from '@/p2p/domain/constants';
import { parseDecimalUnits } from '@/p2p/domain/pricing';
import { buildOrderAction } from '@/p2p/domain/transaction-actions';
import { scoreTransfer } from '@/p2p/domain/transfer-match';
import type { TransferMatchesDto } from '@/p2p/dto/transaction.dto';
import type { TransferMatchView } from '@/p2p/entities/order.entity';
import { OrdersService } from '@/p2p/orders.service';
import { fiatUnitsOf } from '@/p2p/quotes.service';
import { tierOf } from '@/p2p/tier';
import { TransactionsService } from '@/p2p/transactions.service';
import { P2P_ORDER_SELECT } from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';

/** Candidates read per call: a merchant with more live orders than this in one amount is rare. */
const CANDIDATES = 50;

/**
 * The auto-release helper: a merchant's bot forwards each incoming bank
 * transfer and gets back the orders it most likely settles (the merchant's
 * live purchases and charges for that exact amount and currency), scored on
 * the payer's name and document, each with its `release` ready to sign. It
 * moves nothing: the bot decides and signs.
 */
@Injectable()
export class TransferMatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly deployments: DeploymentsService,
    private readonly reader: MarketReader,
    private readonly transactions: TransactionsService,
  ) {}

  async match(org: OrgPrincipal, dto: TransferMatchesDto): Promise<{ data: TransferMatchView[] }> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const amount = fiatUnitsOf(dto.currency, dto.amount);
    const decimals = P2P_CURRENCIES[dto.currency as P2pCurrency].decimals;
    const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : null;
    const rows = await this.prisma.p2pOrder.findMany({
      where: {
        merchantOrganizationId: organizationId,
        tier,
        kind: { in: ['BUY', 'CHARGE'] },
        status: { in: ['awaiting_payment', 'paid'] },
        currency: dto.currency,
        ...(receivedAt ? { createdAt: { lte: receivedAt } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: CANDIDATES,
      select: P2P_ORDER_SELECT,
    });
    const now = new Date();
    const matches: TransferMatchView[] = [];
    for (const row of rows) {
      if (parseDecimalUnits(row.fiatAmount, decimals) !== amount) continue;
      const view = await this.orders.merchantView(row);
      const release = buildOrderAction('release', {
        contract: row.contract,
        from: row.sellerAddress,
        order: row,
        now,
      });
      if (!release.ok) continue;
      let transaction;
      try {
        const d = await this.reader.requireLive(row.tier as Tier, row.network);
        transaction = await this.transactions.prepared(d, row.sellerAddress, release.value);
      } catch {
        // Not releasable right now (the contract refuses, or the node is away).
        continue;
      }
      matches.push({ order: view, ...scoreTransfer(dto, view.payer), transaction });
    }
    matches.sort(
      (a, b) =>
        b.score - a.score ||
        // A reported payment first: the person says this transfer is theirs.
        (a.order.status === 'paid' ? 0 : 1) - (b.order.status === 'paid' ? 0 : 1) ||
        a.order.createdAt.getTime() - b.order.createdAt.getTime(),
    );
    return { data: matches.slice(0, P2P_TRANSFER_MATCHES_LIMIT) };
  }
}
