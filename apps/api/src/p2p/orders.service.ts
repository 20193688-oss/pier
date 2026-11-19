import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { getAddress } from 'viem';
import type { OrgPrincipal } from '@/auth/auth.types';
import { ChainCallReverted } from '@/chain/chain-client.service';
import { DeploymentsService } from '@/chain/deployments.service';
import { approveCalldata, p2pCalldata, type P2pOrderAction } from '@/chain/market-codec';
import { MarketReader } from '@/chain/market-reader.service';
import type { Tier } from '@/chain/networks';
import { ApiError, ErrorCode } from '@/common/api-error';
import { DataCipher } from '@/common/data-cipher';
import { page, type Page } from '@/common/pagination';
import { isUuid, openParamsOf } from '@/p2p/domain/order-ref';
import type { P2pOrderKind } from '@/p2p/domain/order-status';
import { formatUnits } from '@/p2p/domain/pricing';
import {
  isDocumentNumber,
  isP2pRailId,
  isPersonName,
  validateRailDetails,
} from '@/p2p/domain/rails';
import type {
  BeneficiaryDto,
  CreateOrderDto,
  PayerDto,
  QueryOrdersDto,
  ReportPaidDto,
} from '@/p2p/dto/order.dto';
import type {
  BeneficiaryView,
  CreatedOrderView,
  MerchantOrderView,
  OrderView,
  PayerView,
} from '@/p2p/entities/order.entity';
import type { TransactionView } from '@/p2p/entities/transaction.entity';
import { MatcherService } from '@/p2p/matcher.service';
import { OrderOpener } from '@/p2p/order-opener.service';
import { PaymentMethodsService } from '@/p2p/payment-methods.service';
import { QuotesService, fiatUnitsOf, noMatch, windowsFor } from '@/p2p/quotes.service';
import { tierOf } from '@/p2p/tier';
import {
  P2P_ORDER_SELECT,
  isLive,
  toMerchantOrderView,
  toOrderView,
  type P2pOrderRow,
} from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';

/** Who an order is created for: an organization, or the public app's wallet. */
export interface OrderOwner {
  organizationId: string;
  tier: Tier;
  /** The public app's signed-in wallet; null for organization orders. */
  endUserAddress: string | null;
}

/** The matcher acts for the buyer only on the orders it opened for a person or a payer. */
const MATCHER_BUYER_KINDS: readonly P2pOrderKind[] = ['BUY', 'CHARGE'];

/** Orders where `address` is the buyer or the seller, EIP-55 like every stored address. */
function addressFilter(address: string | undefined) {
  if (!address) return {};
  const wallet = getAddress(address);
  return { OR: [{ buyerAddress: wallet }, { sellerAddress: wallet }] };
}

/** A sealed payer identity, as the merchant reads it. */
interface SealedPayer {
  name: string;
  document: string;
  email?: string;
}

/**
 * P2P orders: the client's routes (create from a quote, read, report paid,
 * cancel, dispute) and the merchant's reads. Every lookup is by consumer AND
 * tier: the client's by `organizationId`, the merchant's by `merchantOrganizationId`,
 * so neither reads an order of the other's that it is not a party to.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly reader: MarketReader,
    private readonly quotes: QuotesService,
    private readonly opener: OrderOpener,
    private readonly matcher: MatcherService,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly cipher: DataCipher,
  ) {}

  /** The chain id an order's network has on its tier, from the table (no RPC). */
  chainIdOf(row: { network: string; tier: string }): number {
    return this.deployments.chainIdOf(row);
  }

  /** The client's view; the merchant's payment details only on a live purchase or charge. */
  async clientView(row: P2pOrderRow, withDetails: boolean): Promise<OrderView> {
    const details =
      withDetails && MATCHER_BUYER_KINDS.includes(row.kind as P2pOrderKind) && isLive(row.status)
        ? await this.paymentMethods.paymentDetailsOf(row.merchantPaymentMethodId)
        : null;
    return toOrderView(row, this.chainIdOf(row), details);
  }

  /** The merchant's view; the other party's details only while the order is live. */
  async merchantView(row: P2pOrderRow): Promise<MerchantOrderView> {
    let payer: PayerView | null = null;
    let beneficiary: BeneficiaryView | null = null;
    if (isLive(row.status)) {
      const sealed = await this.prisma.p2pOrder.findUnique({
        where: { id: row.id },
        select: { payerInfo: true, beneficiary: true },
      });
      if (sealed?.payerInfo) {
        const p = this.cipher.open<SealedPayer>('order.payer', row.id, sealed.payerInfo);
        payer = { name: p.name, document: p.document };
      }
      if (sealed?.beneficiary) {
        beneficiary = this.cipher.open<BeneficiaryView>(
          'order.beneficiary',
          row.id,
          sealed.beneficiary,
        );
      }
    }
    return toMerchantOrderView(row, this.chainIdOf(row), {
      payer,
      beneficiary,
    });
  }

  private checkPayer(payer: PayerDto | undefined) {
    if (!payer) {
      throw ApiError.validation([
        'payer is required on a purchase: the merchant checks the transfer comes from this person',
      ]);
    }
    const errors: string[] = [];
    if (!isPersonName(payer.name)) errors.push('payer.name must be a person’s name');
    if (!isDocumentNumber(payer.document)) {
      errors.push('payer.document must be 4 to 20 letters, digits, dots or hyphens');
    }
    if (errors.length) throw ApiError.validation(errors);
    return { name: payer.name.trim(), document: payer.document.trim() };
  }

  /** A beneficiary checked against the order's rail: where the merchant will pay. */
  checkBeneficiary(beneficiary: BeneficiaryDto | undefined, rail: string, currency: string) {
    if (!beneficiary) {
      throw ApiError.validation([
        'beneficiary is required: it is where the merchant pays the local money',
      ]);
    }
    const errors: string[] = [];
    if (!isPersonName(beneficiary.holderName)) {
      errors.push('beneficiary.holderName must be a person’s or a company’s name');
    }
    if (!isDocumentNumber(beneficiary.document)) {
      errors.push('beneficiary.document must be 4 to 20 letters, digits, dots or hyphens');
    }
    const details = isP2pRailId(rail)
      ? validateRailDetails(rail, currency, beneficiary.details)
      : { ok: false as const, errors: [`rail ${rail} is not a rail`] };
    if (!details.ok) errors.push(...details.errors.map((e) => `beneficiary.${e}`));
    if (errors.length || !details.ok) {
      throw ApiError.validation(errors);
    }
    return {
      holderName: beneficiary.holderName.trim(),
      document: beneficiary.document.trim(),
      rail,
      details: details.details,
    };
  }

  /**
   * An order from a quote. A purchase is opened by the matcher on the
   * merchant's balance; a sale answers the two transactions the seller's wallet
   * signs. One order per quote: a retry with the same quote and the same
   * wallet answers the order it made, another wallet is `409`.
   */
  async create(org: OrgPrincipal, dto: CreateOrderDto): Promise<CreatedOrderView> {
    const tier = tierOf(org, this.deployments);
    return this.createFor({ organizationId: org.organizationId, tier, endUserAddress: null }, dto);
  }

  /** An order from one of the owner's quotes (shared with the public app). */
  async createFor(owner: OrderOwner, dto: CreateOrderDto): Promise<CreatedOrderView> {
    const { organizationId, tier } = owner;
    const quote = await this.prisma.p2pQuote.findFirst({
      where: { id: dto.quoteId, organizationId, tier, endUserAddress: owner.endUserAddress },
    });
    if (!quote) {
      throw ApiError.notFound(`P2P quote ${dto.quoteId} not found`, ErrorCode.QuoteNotFound);
    }
    if (dto.kind && dto.kind !== quote.side) {
      throw ApiError.validation([`kind must be the quote's side (${quote.side})`]);
    }
    const wallet = quote.side === 'BUY' ? dto.recipient : dto.seller;
    if (!wallet) {
      throw ApiError.validation([
        quote.side === 'BUY'
          ? 'recipient is required on a purchase: the wallet that receives the tokens'
          : 'seller is required on a sale: the wallet that sends the tokens',
      ]);
    }
    const address = getAddress(wallet);

    const replay = await this.prisma.p2pOrder.findFirst({
      where: { quoteId: quote.id, organizationId, tier },
      select: P2P_ORDER_SELECT,
    });
    if (replay) {
      const replayWallet = quote.side === 'BUY' ? replay.buyerAddress : replay.sellerAddress;
      if (replayWallet !== address) {
        throw ApiError.conflict(
          ErrorCode.IdempotencyConflict,
          'An order already exists for this quote with another wallet. Quote again for a new order.',
        );
      }
      return {
        ...(await this.clientView(replay, true)),
        transactions:
          quote.side === 'SELL' && replay.status === 'pending' ? this.sellTransactions(replay) : [],
      };
    }

    if (quote.expiresAt <= new Date()) {
      throw ApiError.badRequest(ErrorCode.QuoteExpired, 'This quote expired: quote again.');
    }
    const deployment = await this.reader.requireLive(tier, quote.network);
    const token = this.deployments.token(deployment, quote.token);
    const protocol = await this.quotes.openProtocol(deployment);
    if (protocol.feeBps !== quote.protocolFeeBps) {
      throw ApiError.badRequest(
        ErrorCode.QuoteExpired,
        'The protocol fee changed since this quote: quote again.',
      );
    }
    const merchant = await this.prisma.p2pAccount.findFirst({
      where: { id: quote.merchantAccountId, tier, merchantStatus: 'ACTIVE' },
      select: {
        id: true,
        organizationId: true,
        address: true,
        displayName: true,
        completedOrders: true,
        cancelledOrders: true,
        disputesLost: true,
        medianReleaseSeconds: true,
      },
    });
    if (!merchant?.displayName || merchant.address === address) throw noMatch();

    const side = quote.side as 'BUY' | 'SELL';
    const payer = side === 'BUY' ? this.checkPayer(dto.payer) : undefined;
    const beneficiary =
      side === 'SELL'
        ? this.checkBeneficiary(dto.beneficiary, quote.rail, quote.currency)
        : undefined;
    const paymentMethod =
      side === 'BUY'
        ? await this.paymentMethods.activeFor(merchant.id, quote.rail, quote.currency)
        : null;
    if (side === 'BUY' && !paymentMethod) throw noMatch();

    const windows = windowsFor(side);
    const matcherAddress = this.deployments.matcherAddress();
    if (side === 'BUY' && !matcherAddress) {
      throw ApiError.unavailable(
        'The P2P market cannot open orders on this deployment right now.',
        'P2P_MATCHER_PRIVATE_KEY is not set.',
      );
    }
    const row = await this.opener.insert({
      id: randomUUID(),
      organizationId,
      endUserAddress: owner.endUserAddress,
      kind: side,
      deployment,
      token,
      match: {
        offerId: quote.offerId,
        offerSnapshot: { price: quote.price, quoteId: quote.id },
        account: { ...merchant, displayName: merchant.displayName },
        price: quote.price,
        amounts: {
          fiatUnits: fiatUnitsOf(quote.currency, quote.fiatAmount),
          grossTokens: BigInt(quote.tokenAmount),
          protocolFee: BigInt(quote.protocolFee),
          integratorFee: BigInt(quote.integratorFee),
          netTokens: BigInt(quote.netAmount),
        },
        bond: BigInt(quote.bond),
        paymentMethodId: paymentMethod?.id ?? null,
      },
      currency: quote.currency,
      rail: quote.rail,
      sellerAddress: side === 'BUY' ? merchant.address : address,
      buyerAddress: side === 'BUY' ? address : merchant.address,
      openerAddress: side === 'BUY' ? (matcherAddress as string) : address,
      windows,
      protocolFeeBps: quote.protocolFeeBps,
      integratorFeeBps: quote.integratorFeeBps,
      integratorAddress: quote.integratorAddress,
      quoteId: quote.id,
      externalReference: dto.externalReference?.trim() || null,
      payer,
      beneficiary,
    });

    if (side === 'BUY') {
      const opened = await this.opener.openViaMatcher(deployment, row);
      return { ...(await this.clientView(opened, true)), transactions: [] };
    }
    return {
      ...(await this.clientView(row, true)),
      transactions: this.sellTransactions(row),
    };
  }

  /** What the seller's wallet signs to open a sale: the exact approval, then `openWithDeposit`. */
  private sellTransactions(row: P2pOrderRow): TransactionView[] {
    const chainId = this.chainIdOf(row);
    const amount = BigInt(row.tokenAmount);
    const human = `${formatUnits(amount, row.tokenDecimals).replace(/\.?0+$/, '')} ${row.tokenSymbol}`;
    return [
      {
        chainId,
        to: row.token,
        data: approveCalldata(row.contract, amount),
        value: '0',
        description: `Allow the P2P market to take exactly ${human}`,
      },
      {
        chainId,
        to: row.contract,
        data: p2pCalldata.openWithDeposit(openParamsOf(row)),
        value: '0',
        description: `Lock ${human} in a sale to ${row.merchantDisplayName ?? 'the merchant'}; it is released to them once you confirm their payment`,
      },
    ];
  }

  async list(org: OrgPrincipal, query: QueryOrdersDto): Promise<Page<OrderView>> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const where = {
      organizationId,
      tier,
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...addressFilter(query.address),
    };
    const [rows, total] = await Promise.all([
      this.prisma.p2pOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_ORDER_SELECT,
      }),
      this.prisma.p2pOrder.count({ where }),
    ]);
    return page(await Promise.all(rows.map((r) => this.clientView(r, false))), total, query);
  }

  /** The caller's order (as its client), or the 404 of a missing one. */
  async owned(organizationId: string, tier: Tier, id: string): Promise<P2pOrderRow> {
    const row = isUuid(id)
      ? await this.prisma.p2pOrder.findFirst({
          where: { id, organizationId, tier },
          select: P2P_ORDER_SELECT,
        })
      : null;
    if (!row) throw ApiError.notFound(`P2P order ${id} not found`);
    return row;
  }

  async get(org: OrgPrincipal, id: string): Promise<OrderView> {
    const tier = tierOf(org, this.deployments);
    const row = await this.owned(org.organizationId, tier, id);
    return this.clientView(row, true);
  }

  /**
   * The buyer side's acts the matcher sends for a purchase or a charge: the
   * person reported the transfer (`markPaid`), gave up (`cancel`), or contests
   * a payment the merchant ignores (`dispute`). A sale's and a payout's are
   * signed by their own wallets (`POST /v1/p2p/transactions`); the matcher
   * only withdraws a payout nobody accepted yet.
   */
  async act(
    org: OrgPrincipal,
    id: string,
    action: 'paid' | 'cancel' | 'dispute',
    dto?: ReportPaidDto,
  ): Promise<OrderView> {
    const tier = tierOf(org, this.deployments);
    const row = await this.owned(org.organizationId, tier, id);
    return this.clientView(await this.sendBuyerAct(row, action, dto?.reference), true);
  }

  /** Validates and sends one matcher act for an order; shared with the keyless checkout. */
  async sendBuyerAct(
    row: P2pOrderRow,
    action: 'paid' | 'cancel' | 'dispute',
    reference?: string,
  ): Promise<P2pOrderRow> {
    const kind = row.kind as P2pOrderKind;
    const payoutWithdraw =
      kind === 'PAYOUT' && action === 'cancel' && row.status === 'awaiting_acceptance';
    if (!MATCHER_BUYER_KINDS.includes(kind) && !payoutWithdraw) {
      throw ApiError.badRequest(
        ErrorCode.InvalidState,
        kind === 'PAYOUT'
          ? 'A payout is cancelled here only before its merchant accepts it; release or dispute it from your wallet (POST /v1/p2p/transactions).'
          : 'A sale is signed by the seller’s wallet: build the transaction with POST /v1/p2p/transactions.',
      );
    }
    const needed: Record<typeof action, string[]> = {
      paid: ['awaiting_payment'],
      cancel: ['awaiting_payment', 'awaiting_acceptance'],
      dispute: ['paid'],
    };
    if (!row.onchainId || !needed[action].includes(row.status)) {
      throw ApiError.badRequest(
        ErrorCode.InvalidState,
        `This order is ${row.status}: it cannot be ${action === 'paid' ? 'reported paid' : action === 'cancel' ? 'cancelled' : 'disputed'} now.`,
      );
    }
    const deployment = await this.reader.requireLive(row.tier as Tier, row.network);
    const call: P2pOrderAction = action === 'paid' ? 'markPaid' : action;
    try {
      await this.matcher.send(deployment, {
        kind: call === 'markPaid' ? 'markPaid' : call,
        orderId: row.id,
        data: p2pCalldata.orderAction(call, BigInt(row.onchainId)),
      });
    } catch (err) {
      if (err instanceof ChainCallReverted) {
        throw ApiError.badRequest(
          ErrorCode.InvalidState,
          `The contract refused it (${err.contractError ?? 'refused'}): the order moved on-chain, read it again.`,
        );
      }
      throw err;
    }
    if (action === 'paid' && reference?.trim()) {
      await this.prisma.p2pOrder.updateMany({
        where: { id: row.id },
        data: { paidReference: reference.trim() },
      });
    }
    return (await this.prisma.p2pOrder.findUnique({
      where: { id: row.id },
      select: P2P_ORDER_SELECT,
    })) as P2pOrderRow;
  }

  // --- the merchant's reads ------------------------------------------------

  async merchantList(org: OrgPrincipal, query: QueryOrdersDto): Promise<Page<MerchantOrderView>> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const where = {
      merchantOrganizationId: organizationId,
      tier,
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...addressFilter(query.address),
    };
    const [rows, total] = await Promise.all([
      this.prisma.p2pOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_ORDER_SELECT,
      }),
      this.prisma.p2pOrder.count({ where }),
    ]);
    return page(await Promise.all(rows.map((r) => this.merchantView(r))), total, query);
  }

  async merchantGet(org: OrgPrincipal, id: string): Promise<MerchantOrderView> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const row = isUuid(id)
      ? await this.prisma.p2pOrder.findFirst({
          where: { id, merchantOrganizationId: organizationId, tier },
          select: P2P_ORDER_SELECT,
        })
      : null;
    if (!row) throw ApiError.notFound(`P2P order ${id} not found`);
    return this.merchantView(row);
  }
}
