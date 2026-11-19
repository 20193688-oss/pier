import { Injectable } from '@nestjs/common';
import { getAddress } from 'viem';
import type { OrgPrincipal } from '@/auth/auth.types';
import { DeploymentsService } from '@/chain/deployments.service';
import { MarketReader } from '@/chain/market-reader.service';
import type { Tier } from '@/chain/networks';
import { ApiError, ErrorCode } from '@/common/api-error';
import { AccountsService } from '@/p2p/accounts.service';
import { isUuid } from '@/p2p/domain/order-ref';
import {
  buildBalanceAction,
  buildOrderAction,
  isBalanceAction,
  type P2pTransactionAction,
} from '@/p2p/domain/transaction-actions';
import type { BuildTransactionDto } from '@/p2p/dto/transaction.dto';
import type { TransactionView } from '@/p2p/entities/transaction.entity';
import { OffersService } from '@/p2p/offers.service';
import { tierOf } from '@/p2p/tier';
import { P2P_ORDER_SELECT, type P2pOrderRow } from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Builds the transactions clients and their bots sign: one action table
 * (`p2p-transaction-actions.ts`) and the facts each action reads. `from` is
 * one of the caller's accounts, or the seller's address of one of the
 * caller's sales (a person's wallet is not an account). An order action names
 * an order the caller is a party to: its client (it created it) or its
 * merchant (its account is the merchant). Nothing is signed here.
 */
@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly offers: OffersService,
    private readonly deployments: DeploymentsService,
    private readonly reader: MarketReader,
  ) {}

  async build(org: OrgPrincipal, dto: BuildTransactionDto): Promise<TransactionView> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const deployment = await this.reader.requireLive(tier, dto.network);
    const action = dto.action as P2pTransactionAction;
    const args = dto.args ?? {};

    if (isBalanceAction(action)) {
      const account = await this.accounts.ownedByRef(organizationId, tier, dto.from);
      const built = buildBalanceAction(action, args, {
        contract: deployment.contract,
        from: account.address,
        matcher: this.deployments.matcherAddress(),
        token: (value) => {
          try {
            return this.deployments.token(deployment, value);
          } catch {
            return null;
          }
        },
        sellsLiquidity:
          action === 'setMatcher' ? await this.offers.sellsLiquidity(account.id) : false,
      });
      if (!built.ok) {
        throw ApiError.validation([built.error]);
      }
      return { chainId: deployment.chainId, value: '0', ...built.value };
    }

    const orderId = args.orderId;
    if (typeof orderId !== 'string' || !isUuid(orderId)) {
      throw ApiError.validation(['args.orderId must be the id of an order']);
    }
    const order = await this.partyOrder(organizationId, tier, orderId);
    if (order.network !== deployment.network) {
      throw ApiError.validation([`the order is on ${order.network}, not ${deployment.network}`]);
    }
    const from = await this.signer(organizationId, tier, dto.from, order);
    const built = buildOrderAction(action, {
      contract: order.contract,
      from,
      order,
      now: new Date(),
    });
    if (!built.ok) {
      throw ApiError.badRequest(ErrorCode.InvalidState, built.error);
    }
    return { chainId: deployment.chainId, value: '0', ...built.value };
  }

  /** An order the caller created or is the merchant of, on its tier; else a 404. */
  async partyOrder(organizationId: string, tier: Tier, id: string): Promise<P2pOrderRow> {
    const row = await this.prisma.p2pOrder.findFirst({
      where: {
        id,
        tier,
        OR: [{ organizationId }, { merchantOrganizationId: organizationId }],
      },
      select: P2P_ORDER_SELECT,
    });
    if (!row) throw ApiError.notFound(`P2P order ${id} not found`);
    return row;
  }

  /**
   * The wallet that signs: an account of the caller (by id or address), or
   * the seller's address of a sale the caller created, for that order only.
   */
  private async signer(
    organizationId: string,
    tier: Tier,
    from: string,
    order: P2pOrderRow,
  ): Promise<string> {
    if (
      order.kind === 'SELL' &&
      order.organizationId === organizationId &&
      /^0x[0-9a-fA-F]{40}$/.test(from) &&
      getAddress(from) === order.sellerAddress
    ) {
      return order.sellerAddress;
    }
    const account = await this.accounts.ownedByRef(organizationId, tier, from);
    return account.address;
  }
}
