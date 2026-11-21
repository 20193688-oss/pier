import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { OrgPrincipal } from '@/auth/auth.types';
import { ChainCallReverted } from '@/chain/chain-client.service';
import { DeploymentsService, type Deployment } from '@/chain/deployments.service';
import { p2pCall, type P2pOrderAction } from '@/chain/market-codec';
import { MarketReader } from '@/chain/market-reader.service';
import type { Tier } from '@/chain/networks';
import { TxBuilder, humanAmount, type BuiltTransaction } from '@/chain/tx-builder.service';
import { ApiError, ErrorCode } from '@/common/api-error';
import { DataCipher } from '@/common/data-cipher';
import { page, type Page } from '@/common/pagination';
import { showsOutcome } from '@/p2p/domain/action-outcome';
import { isUuid, openParamsOf, type P2pOrderTerms } from '@/p2p/domain/order-ref';
import { isSelfOpened, type P2pOrderKind } from '@/p2p/domain/order-status';
import { qrHash, readQrPayment, type QrSummary, type SealedQr } from '@/p2p/domain/qr-pay';
import {
  P2P_RAILS,
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
import { MatcherService } from '@/p2p/matcher.service';
import { OrderOpener } from '@/p2p/order-opener.service';
import { onchainOutcome } from '@/p2p/order-outcome';
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

/** Orders where `address` is the buyer or the seller. */
function addressFilter(address: string | undefined) {
  if (!address) return {};
  return { OR: [{ buyerAddress: address }, { sellerAddress: address }] };
}

/** What creating an order may also carry: the scanned QR of a QR payment. */
export interface OrderExtras {
  qr?: string;
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
    private readonly builder: TxBuilder,
  ) {}

  /** A QR payment's sealed QR, opened, or null. */
  private async sealedQr(row: P2pOrderRow): Promise<SealedQr | null> {
    if (row.kind !== 'QR_PAY') return null;
    const sealed = await this.prisma.p2pOrder.findUnique({
      where: { id: row.id },
      select: { qrPayload: true },
    });
    return sealed?.qrPayload
      ? this.cipher.open<SealedQr>('order.qr', row.id, sealed.qrPayload)
      : null;
  }

  /**
   * The client's view; the merchant's payment details only on a live purchase
   * or charge, and a QR payment's QR (never its payload) on a single read.
   */
  async clientView(row: P2pOrderRow, withDetails: boolean): Promise<OrderView> {
    const details =
      withDetails && MATCHER_BUYER_KINDS.includes(row.kind as P2pOrderKind) && isLive(row.status)
        ? await this.paymentMethods.paymentDetailsOf(row.merchantPaymentMethodId)
        : null;
    const qr = withDetails ? await this.sealedQr(row) : null;
    const summary: QrSummary | null = qr
      ? {
          standard: qr.standard,
          merchantName: qr.merchantName,
          merchantCity: qr.merchantCity,
          amount: qr.amount,
          currency: qr.currency,
        }
      : null;
    return toOrderView(row, details, summary);
  }

  /** The merchant's view; the other party's details only while the order is live. */
  async merchantView(row: P2pOrderRow): Promise<MerchantOrderView> {
    let payer: PayerView | null = null;
    let beneficiary: BeneficiaryView | null = null;
    let qr: SealedQr | null = null;
    if (isLive(row.status)) {
      qr = await this.sealedQr(row);
      const sealed = await this.prisma.p2pOrder.findUnique({
        where: { id: row.id },
        select: { payerInfo: true, beneficiary: true },
      });
      if (sealed?.payerInfo) {
        const p = this.cipher.open<SealedPayer>('order.payer', row.id, sealed.payerInfo);
        payer = { name: p.name, document: p.document };
      }
      if (sealed?.beneficiary) {
        const opened = this.cipher.open<BeneficiaryView>(
          'order.beneficiary',
          row.id,
          sealed.beneficiary,
        );
        // A beneficiary may come without an ID (`document`) on the rails that do not need it.
        beneficiary = { ...opened, document: opened.document ?? null };
      }
    }
    return toMerchantOrderView(row, { payer, beneficiary, qr });
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
    // The holder's ID is optional where the rail's transfer does not need it (their bank already
    // identified them); given, it is checked as always.
    const document = beneficiary.document?.trim() || null;
    const idRequired = isP2pRailId(rail) && P2P_RAILS[rail].beneficiaryIdRequired;
    if (document === null && idRequired) {
      errors.push(`beneficiary.document is required: ${rail} transfers need the holder’s ID`);
    }
    if (document !== null && !isDocumentNumber(document)) {
      errors.push('beneficiary.document must be 4 to 20 letters, digits, dots or hyphens');
    }
    const details = isP2pRailId(rail)
      ? validateRailDetails(rail, currency, beneficiary.details, { beneficiary: true })
      : { ok: false as const, errors: [`rail ${rail} is not a rail`] };
    if (!details.ok) errors.push(...details.errors.map((e) => `beneficiary.${e}`));
    if (errors.length || !details.ok) {
      throw ApiError.validation(errors);
    }
    return {
      holderName: beneficiary.holderName.trim(),
      document,
      rail,
      details: details.details,
    };
  }

  /**
   * An order from a quote. A purchase is opened by the matcher on the
   * merchant's balance; a sale (and a QR payment) answers the transaction the
   * seller's wallet signs (`open_with_deposit`). One order per quote: a retry
   * with the same quote and the same wallet answers the order it made (with a
   * fresh transaction while it waits for its signature), another wallet is `409`.
   */
  async create(org: OrgPrincipal, dto: CreateOrderDto): Promise<CreatedOrderView> {
    const tier = tierOf(org, this.deployments);
    return this.createFor({ organizationId: org.organizationId, tier, endUserAddress: null }, dto);
  }

  /** An order from one of the owner's quotes (shared with the public app). */
  async createFor(
    owner: OrderOwner,
    dto: CreateOrderDto,
    extras: OrderExtras = {},
  ): Promise<CreatedOrderView> {
    const { organizationId, tier } = owner;
    const quote = await this.prisma.p2pQuote.findFirst({
      where: { id: dto.quoteId, organizationId, tier, endUserAddress: owner.endUserAddress },
    });
    if (!quote) {
      throw ApiError.notFound(`P2P quote ${dto.quoteId} not found`, ErrorCode.QuoteNotFound);
    }
    const qrPay = quote.kind === 'QR_PAY';
    if (qrPay !== (extras.qr !== undefined)) {
      throw ApiError.validation([
        qrPay
          ? 'qr is required: the QR this quote was made for'
          : 'qr is only for a QR payment quote',
      ]);
    }
    if (qrPay && qrHash(extras.qr as string) !== quote.qrHash) {
      throw ApiError.validation(['qr must be the QR this quote was made for']);
    }
    if (!qrPay && dto.kind && dto.kind !== quote.side) {
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
    const address = wallet;

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
      const pendingSale = isSelfOpened(replay.kind) && replay.status === 'pending';
      return {
        ...(await this.clientView(replay, true)),
        transactions: pendingSale
          ? [
              await this.sellTransaction(
                await this.reader.requireLive(tier, replay.network),
                replay,
              ),
            ]
          : [],
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
    const kind: P2pOrderKind = qrPay ? 'QR_PAY' : side;
    const payer = side === 'BUY' ? this.checkPayer(dto.payer) : undefined;
    const beneficiary =
      kind === 'SELL'
        ? this.checkBeneficiary(dto.beneficiary, quote.rail, quote.currency)
        : undefined;
    let qr: SealedQr | undefined;
    if (qrPay) {
      const read = readQrPayment(extras.qr as string, quote.fiatAmount);
      if (!read.ok) throw ApiError.badRequest(ErrorCode.QrInvalid, read.error);
      qr = read.sealed;
    }
    const paymentMethod =
      side === 'BUY'
        ? await this.paymentMethods.activeFor(merchant.id, quote.rail, quote.currency)
        : null;
    if (side === 'BUY' && !paymentMethod) throw noMatch();

    const windows = windowsFor(kind);
    const matcherAddress = this.deployments.matcherAddress();
    if (side === 'BUY' && !matcherAddress) {
      throw ApiError.unavailable(
        'The P2P market cannot open orders on this deployment right now.',
        'P2P_MATCHER_SECRET is not set.',
      );
    }
    const id = randomUUID();
    const terms: P2pOrderTerms = {
      id,
      sellerAddress: side === 'BUY' ? merchant.address : address,
      buyerAddress: side === 'BUY' ? address : merchant.address,
      token: quote.token,
      tokenAmount: quote.tokenAmount,
      bond: quote.bond,
      ...windows,
      integratorAddress: quote.integratorAddress,
      integratorFeeBps: quote.integratorFeeBps,
    };
    // A sale is prepared BEFORE anything is written: a seller who cannot fund
    // it (balance, trustline, missing account) is a 400, not a dead order.
    const transaction =
      side === 'SELL'
        ? await this.sellTransaction(deployment, {
            ...terms,
            contract: deployment.contract,
            network: deployment.network,
            tokenSymbol: token.symbol,
            tokenDecimals: token.decimals,
            merchantDisplayName: merchant.displayName,
          })
        : null;
    const row = await this.opener.insert({
      id,
      organizationId,
      endUserAddress: owner.endUserAddress,
      kind,
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
      qr: qr as unknown as Record<string, unknown> | undefined,
    });

    if (side === 'BUY') {
      const opened = await this.opener.openViaMatcher(deployment, row);
      return { ...(await this.clientView(opened, true)), transactions: [] };
    }
    return {
      ...(await this.clientView(row, true)),
      transactions: transaction ? [transaction] : [],
    };
  }

  /**
   * What the seller's wallet signs to open a sale or a QR payment:
   * `open_with_deposit`, whose pull of the tokens into the market is covered
   * by the same signature (no approval). A refusal in its simulation (no
   * balance, no trustline) is a 400 naming the contract's error.
   */
  async sellTransaction(
    d: Deployment,
    row: P2pOrderTerms & {
      contract: string;
      network: string;
      tokenSymbol: string;
      tokenDecimals: number;
      merchantDisplayName: string | null;
    },
  ): Promise<BuiltTransaction> {
    const amount = BigInt(row.tokenAmount);
    const human = `${humanAmount(amount, row.tokenDecimals)} ${row.tokenSymbol}`;
    try {
      return await this.builder.invoke(
        d,
        row.sellerAddress,
        p2pCall.openWithDeposit(row.contract, openParamsOf(row)),
        'open_with_deposit',
        `Lock ${human} in a sale to ${row.merchantDisplayName ?? 'the merchant'}; it is released to them once you confirm their payment`,
      );
    } catch (err) {
      if (err instanceof ChainCallReverted) {
        throw ApiError.badRequest(
          ErrorCode.InvalidState,
          `Your wallet cannot open this sale (${err.contractError ?? 'refused'}): check its ${row.tokenSymbol} balance.`,
          [err.detail.slice(0, 300)],
        );
      }
      throw err;
    }
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

  /** The caller's order as its client, found as `GET /v1/p2p/orders/{id}` finds it. */
  async clientOwned(org: OrgPrincipal, id: string): Promise<P2pOrderRow> {
    return this.owned(org.organizationId, tierOf(org, this.deployments), id);
  }

  async get(org: OrgPrincipal, id: string): Promise<OrderView> {
    return this.clientView(await this.clientOwned(org, id), true);
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

  /**
   * Validates and sends one matcher act for an order; shared with the keyless
   * checkout. Idempotent: an order that already shows the act (stored, or on
   * the contract when it refuses the call because the first one went through
   * before the indexer caught up) is answered as it is, and nothing is sent.
   */
  async sendBuyerAct(
    row: P2pOrderRow,
    action: 'paid' | 'cancel' | 'dispute',
    reference?: string,
  ): Promise<P2pOrderRow> {
    const kind = row.kind as P2pOrderKind;
    const outcome = action === 'paid' ? 'markPaid' : action;
    const done = showsOutcome(outcome, row.status);
    const payoutWithdraw =
      kind === 'PAYOUT' && action === 'cancel' && (row.status === 'awaiting_acceptance' || done);
    if (!MATCHER_BUYER_KINDS.includes(kind) && !payoutWithdraw) {
      throw ApiError.badRequest(
        ErrorCode.InvalidState,
        kind === 'PAYOUT'
          ? 'A payout is cancelled here only before its merchant accepts it; release or dispute it from your wallet (POST /v1/p2p/transactions).'
          : 'A sale or a QR payment is signed by the seller’s wallet: build the transaction with POST /v1/p2p/transactions.',
      );
    }
    if (done) return row;
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
    const call: P2pOrderAction = action === 'paid' ? 'mark_paid' : action;
    const matcher = this.deployments.matcherKey().publicKey();
    try {
      await this.matcher.send(deployment, {
        kind: outcome,
        orderId: row.id,
        operation: p2pCall.orderAction(deployment.contract, call, matcher, BigInt(row.onchainId)),
      });
    } catch (err) {
      if (err instanceof ChainCallReverted) {
        // The first call went through and the indexer has not caught up: the
        // order as it is (the indexer moves it shortly), not a refusal.
        if (await onchainOutcome(this.reader, deployment, row, outcome)) {
          return this.reread(row);
        }
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
    return this.reread(row);
  }

  /** An order row read again (after an act); the one given when it is gone. */
  private async reread(row: P2pOrderRow): Promise<P2pOrderRow> {
    return (
      (await this.prisma.p2pOrder.findUnique({
        where: { id: row.id },
        select: P2P_ORDER_SELECT,
      })) ?? row
    );
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

  /** An order one of the caller's merchant accounts takes, or the 404 of a missing one. */
  async merchantOwned(org: OrgPrincipal, id: string): Promise<P2pOrderRow> {
    const tier = tierOf(org, this.deployments);
    const organizationId = org.organizationId;
    const row = isUuid(id)
      ? await this.prisma.p2pOrder.findFirst({
          where: { id, merchantOrganizationId: organizationId, tier },
          select: P2P_ORDER_SELECT,
        })
      : null;
    if (!row) throw ApiError.notFound(`P2P order ${id} not found`);
    return row;
  }

  async merchantGet(org: OrgPrincipal, id: string): Promise<MerchantOrderView> {
    return this.merchantView(await this.merchantOwned(org, id));
  }
}
