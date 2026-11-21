import { Injectable } from '@nestjs/common';
import type { OrgPrincipal } from '@/auth/auth.types';
import { ChainCallReverted } from '@/chain/chain-client.service';
import { DeploymentsService, type Deployment } from '@/chain/deployments.service';
import { MarketReader } from '@/chain/market-reader.service';
import type { Tier } from '@/chain/networks';
import { TxBuilder, type BuiltTransaction } from '@/chain/tx-builder.service';
import { ApiError, ErrorCode } from '@/common/api-error';
import { isAccountAddress } from '@/common/stellar';
import { AccountsService } from '@/p2p/accounts.service';
import { showsOutcome } from '@/p2p/domain/action-outcome';
import { isUuid } from '@/p2p/domain/order-ref';
import { isSelfOpened } from '@/p2p/domain/order-status';
import {
  buildBalanceAction,
  buildOrderAction,
  isBalanceAction,
  type P2pBalanceAction,
  type P2pBuiltCall,
  type P2pTransactionAction,
} from '@/p2p/domain/transaction-actions';
import type { BuildTransactionDto } from '@/p2p/dto/transaction.dto';
import { OffersService } from '@/p2p/offers.service';
import { alreadyDone, onchainOutcome, type OutcomeOrder } from '@/p2p/order-outcome';
import { tierOf } from '@/p2p/tier';
import { P2P_ORDER_SELECT, type P2pOrderRow } from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';

/** A contract refusal while preparing a transaction, as the 400 a caller reads. */
export function refusedByContract(err: unknown): never {
  if (err instanceof ChainCallReverted) {
    throw ApiError.badRequest(
      ErrorCode.InvalidState,
      `The contract would refuse it (${err.contractError ?? 'refused'}).`,
      [err.detail.slice(0, 300)],
    );
  }
  throw err;
}

/**
 * Builds the transactions clients and their bots sign: one action table
 * (`transaction-actions.ts`) and the facts each action reads, prepared
 * through simulation (`TxBuilder`). `from` is one of the caller's accounts, or
 * the seller of one of the caller's sales (a person's wallet is not an
 * account). An order action names an order the caller is a party to: its
 * client (it created it) or its merchant; one the order already shows is a
 * 409 `already_done` (a retry), checked before the chain is reached. Nothing
 * is signed here.
 */
@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly offers: OffersService,
    private readonly deployments: DeploymentsService,
    private readonly reader: MarketReader,
    private readonly builder: TxBuilder,
  ) {}

  /** A built call as the prepared transaction `from` signs. */
  async prepared(d: Deployment, from: string, call: P2pBuiltCall): Promise<BuiltTransaction> {
    try {
      return await this.builder.invoke(d, from, call.operation, call.fn, call.description);
    } catch (err) {
      refusedByContract(err);
    }
  }

  /**
   * An order action's prepared transaction. When the contract refuses it, the
   * order is read on-chain: one that already shows the action (it went
   * through and the indexer has not caught up) is a 409 `already_done`;
   * anything else stays the contract's 400.
   */
  async preparedOrderAction(
    d: Deployment,
    from: string,
    call: P2pBuiltCall,
    order: OutcomeOrder,
    action: Exclude<P2pTransactionAction, P2pBalanceAction>,
  ): Promise<BuiltTransaction> {
    try {
      return await this.builder.invoke(d, from, call.operation, call.fn, call.description);
    } catch (err) {
      if (err instanceof ChainCallReverted) {
        const shown = await onchainOutcome(this.reader, d, order, action);
        if (shown) throw alreadyDone(shown);
      }
      refusedByContract(err);
    }
  }

  async build(org: OrgPrincipal, dto: BuildTransactionDto): Promise<BuiltTransaction> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    // The network is checked against configuration here; the chain is reached last.
    const configured = this.deployments.require(tier, dto.network);
    const action = dto.action as P2pTransactionAction;
    const args = dto.args ?? {};

    if (isBalanceAction(action)) {
      const deployment = await this.reader.requireLive(tier, dto.network);
      const account = await this.accounts.ownedByRef(organizationId, tier, dto.from);
      const built = buildBalanceAction(action, args, {
        contract: deployment.contract,
        from: account.address,
        matcher: this.deployments.matcherAddress(),
        token: (value) => this.deployments.findToken(deployment, value),
        sellsLiquidity:
          action === 'setMatcher' ? await this.offers.sellsLiquidity(account.id) : false,
      });
      if (!built.ok) throw ApiError.validation([built.error]);
      return this.prepared(deployment, account.address, built.value);
    }

    const orderId = args.orderId;
    if (typeof orderId !== 'string' || !isUuid(orderId)) {
      throw ApiError.validation(['args.orderId must be the id of an order']);
    }
    const order = await this.partyOrder(organizationId, tier, orderId);
    if (order.network !== configured.network) {
      throw ApiError.validation([`the order is on ${order.network}, not ${configured.network}`]);
    }
    const from = await this.signer(organizationId, tier, dto.from, order);
    if (showsOutcome(action, order.status)) throw alreadyDone(order.status);
    const built = buildOrderAction(action, {
      contract: order.contract,
      from,
      order,
      now: new Date(),
    });
    if (!built.ok) throw ApiError.badRequest(ErrorCode.InvalidState, built.error);
    const deployment = await this.reader.requireLive(tier, dto.network);
    return this.preparedOrderAction(deployment, from, built.value, order, action);
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
   * The account that signs: an account of the caller (by id or address), or
   * the seller of a sale the caller created, for that order only.
   */
  private async signer(
    organizationId: string,
    tier: Tier,
    from: string,
    order: P2pOrderRow,
  ): Promise<string> {
    if (
      isSelfOpened(order.kind) &&
      order.organizationId === organizationId &&
      isAccountAddress(from) &&
      from === order.sellerAddress
    ) {
      return order.sellerAddress;
    }
    const account = await this.accounts.ownedByRef(organizationId, tier, from);
    return account.address;
  }
}
