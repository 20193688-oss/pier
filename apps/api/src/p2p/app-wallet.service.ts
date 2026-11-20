import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { normalizeHandle, normalizeRecipient } from '@midpoint/payment-qr';
import { Address, nativeToScVal, scValToNative, type rpc } from '@stellar/stellar-sdk';
import type { SessionPrincipal } from '@/auth/auth.types';
import { ChainCallReverted, ChainClient } from '@/chain/chain-client.service';
import { DeploymentsService, type Deployment } from '@/chain/deployments.service';
import { eventNameTopic } from '@/chain/market-codec';
import { MarketReader } from '@/chain/market-reader.service';
import type { Token } from '@/chain/networks';
import { TxBuilder, type BuiltTransaction } from '@/chain/tx-builder.service';
import { ApiError, ErrorCode } from '@/common/api-error';
import { baseAccountOf, isContractAddress } from '@/common/stellar';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { Prisma } from '@/generated/prisma/client';
import { AppOrdersService } from '@/p2p/app-orders.service';
import type { ActivityQueryDto, CreateTransferDto } from '@/p2p/dto/app-wallet.dto';
import type {
  ActivityItemView,
  ActivityView,
  BalancesView,
  CreatedTransferView,
  HandleView,
  ProfileView,
  TransferView,
} from '@/p2p/entities/app-wallet.entity';
import { OrdersService } from '@/p2p/orders.service';
import { APP_ORGANIZATION_ID } from '@/p2p/p2p-events';
import { P2P_ORDER_SELECT } from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';

/** Handles nobody may claim. */
export const RESERVED_HANDLES = new Set([
  'admin',
  'administrator',
  'api',
  'app',
  'arbiter',
  'help',
  'matcher',
  'me',
  'merchant',
  'official',
  'midpoint',
  'root',
  'security',
  'sponsor',
  'stellar',
  'support',
  'system',
  'team',
  'usdc',
  'wallet',
]);

/** Whether a normalised handle is reserved (the product's name included). */
export function isReservedHandle(handle: string, brandName: string): boolean {
  const brand = brandName.toLowerCase().replace(/[^a-z0-9_]/g, '');
  return RESERVED_HANDLES.has(handle) || handle === brand || handle.startsWith('midpoint');
}

/**
 * How far back incoming payments from outside the app are read, ledgers
 * (about 7 days at 5 s a ledger): also bounded by what the RPC keeps.
 */
export const INCOMING_WINDOW_LEDGERS = 120_960;
/** A wallet's incoming payments are read at most this often. */
const INCOMING_SCAN_EVERY_MS = 10_000;
/** Pages of events one scan reads. */
const INCOMING_MAX_PAGES = 5;

type TransferRow = Prisma.AppTransferGetPayload<object>;

/** A cursor over (time, type, id), newest first. */
function encodeCursor(at: Date, type: string, id: string): string {
  return Buffer.from(`${at.toISOString()}|${type}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; key: string } | null {
  const [iso, type, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) || !type || !id ? null : { at, key: `${type}|${id}` };
}

/**
 * The payments app's wallet features (`/v1/app/*`, a session acting for its
 * own account): its @handle, balances, the sponsored activation, transfers
 * to addresses and handles, and its activity, which also shows payments that
 * reached it from outside the app.
 *
 * External payments are read from the token contracts' CAP-67 `transfer`
 * and `mint` events (RPC `getEvents`, filtered by recipient), on demand when the
 * activity is read, from where the last read stopped, at most
 * {@link INCOMING_WINDOW_LEDGERS} back and never before what the RPC keeps
 * (about 7 days on SDF's RPC): a payment older than that window when the
 * wallet first opens its activity is not shown.
 */
@Injectable()
export class AppWalletService {
  private readonly logger = new Logger(AppWalletService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly reader: MarketReader,
    private readonly chain: ChainClient,
    private readonly builder: TxBuilder,
    private readonly appOrders: AppOrdersService,
    private readonly orders: OrdersService,
  ) {}

  /** The app's deployment a request names (or its only one), verified. */
  deployment(network: string | undefined): Promise<Deployment> {
    const tier = this.appOrders.tier();
    return this.reader.requireLive(tier, this.deployments.pick(tier, network).network);
  }

  // --- profile and handles -------------------------------------------------------

  async profile(session: SessionPrincipal): Promise<ProfileView> {
    const row = await this.prisma.appProfile.findUnique({ where: { address: session.address } });
    return { address: session.address, handle: row?.handle ?? null };
  }

  async setHandle(session: SessionPrincipal, input: string): Promise<ProfileView> {
    const handle = normalizeHandle(input);
    if (!handle) {
      throw ApiError.validation(['handle must be 3 to 20 of a-z, 0-9 and underscore']);
    }
    if (isReservedHandle(handle, this.config.brandName)) {
      throw ApiError.conflict(ErrorCode.HandleTaken, `@${handle} is reserved.`);
    }
    try {
      await this.prisma.appProfile.upsert({
        where: { address: session.address },
        create: { address: session.address, handle },
        update: { handle },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw ApiError.conflict(ErrorCode.HandleTaken, `@${handle} is taken.`);
      }
      throw err;
    }
    return { address: session.address, handle };
  }

  async resolveHandle(input: string): Promise<HandleView> {
    const handle = normalizeHandle(input);
    const row = handle ? await this.prisma.appProfile.findUnique({ where: { handle } }) : null;
    if (!row?.handle) throw ApiError.notFound(`@${handle ?? input} not found`);
    return { handle: row.handle, address: row.address };
  }

  private async handlesOf(addresses: string[]): Promise<Map<string, string>> {
    const rows = await this.prisma.appProfile.findMany({
      where: { address: { in: [...new Set(addresses)] }, handle: { not: null } },
      select: { address: true, handle: true },
    });
    return new Map(rows.map((r) => [r.address, r.handle as string]));
  }

  // --- balances and activation ---------------------------------------------------

  async balances(session: SessionPrincipal, network?: string): Promise<BalancesView> {
    const d = await this.deployment(network);
    const state = await this.chain.account(d, session.address);
    const lines = state ? await this.chain.trustlines(d, session.address, d.tokens) : [];
    return {
      network: d.network,
      account: { exists: state !== null },
      xlm: (state?.balance ?? 0n).toString(),
      tokens: d.tokens.map((t, i) => ({
        symbol: t.symbol,
        contract: t.contract,
        amount: (lines[i]?.balance ?? 0n).toString(),
        trustline: Boolean(lines[i]),
        authorized: lines[i]?.authorized ?? false,
      })),
    };
  }

  async activate(
    session: SessionPrincipal,
    dto: { network?: string; token: string },
  ): Promise<{ transaction: BuiltTransaction | null }> {
    const d = await this.deployment(dto.network);
    const token = this.deployments.token(d, dto.token);
    return { transaction: await this.builder.activation(d, session.address, token) };
  }

  // --- transfers -------------------------------------------------------------------

  private async recipient(to: string): Promise<{ address: string; handle: string | null }> {
    const normalised = normalizeRecipient(to);
    if (!normalised) {
      throw ApiError.validation(['to must be a Stellar address (G, M or C) or an @handle']);
    }
    if (!normalised.startsWith('@')) return { address: normalised, handle: null };
    const found = await this.prisma.appProfile.findUnique({
      where: { handle: normalised.slice(1) },
    });
    if (!found)
      throw ApiError.badRequest(ErrorCode.ValidationFailed, `${normalised} is nobody’s handle.`);
    return { address: found.address, handle: normalised.slice(1) };
  }

  async createTransfer(
    session: SessionPrincipal,
    dto: CreateTransferDto,
  ): Promise<CreatedTransferView> {
    const d = await this.deployment(dto.network);
    const token = this.deployments.token(d, dto.token);
    const to = await this.recipient(dto.to);
    const toAccount = baseAccountOf(to.address);
    if (toAccount === session.address) {
      throw ApiError.validation(['you cannot send to yourself']);
    }
    const amount = BigInt(dto.amount);
    const note = dto.note?.trim() || null;
    if (note && Buffer.byteLength(note, 'utf8') > 28) {
      throw ApiError.validation(['note holds at most 28 bytes']);
    }
    const [own] = await this.chain.trustlines(d, session.address, [token]);
    if (!own || !own.authorized || own.balance < amount) {
      throw ApiError.badRequest(
        ErrorCode.InsufficientBalance,
        `Your ${token.symbol} balance is ${(own?.balance ?? 0n).toString()} base units: not enough.`,
      );
    }
    let transaction: BuiltTransaction;
    if (isContractAddress(to.address)) {
      try {
        transaction = await this.builder.sacTransfer(d, session.address, to.address, token, amount);
      } catch (err) {
        if (err instanceof ChainCallReverted) {
          throw ApiError.badRequest(
            ErrorCode.RecipientCannotReceive,
            `${to.address} cannot receive ${token.symbol}.`,
          );
        }
        throw err;
      }
    } else {
      await this.canReceive(d, toAccount, token);
      transaction = await this.builder.payment(d, session.address, to.address, token, amount, note);
    }
    const row = await this.prisma.appTransfer.create({
      data: {
        id: randomUUID(),
        tier: d.tier,
        network: d.network,
        token: token.contract,
        tokenSymbol: token.symbol,
        amount: amount.toString(),
        fromAddress: session.address,
        toAddress: to.address,
        toAccount,
        note,
        hash: transaction.hash,
        expiresAt: transaction.expiresAt,
      },
    });
    return { transfer: await this.transferView(row, session.address), transaction };
  }

  /** A G account that can receive the token: it exists and holds an authorised trustline. */
  private async canReceive(d: Deployment, account: string, token: Token): Promise<void> {
    const state = await this.chain.account(d, account);
    const [line] = state ? await this.chain.trustlines(d, account, [token]) : [null];
    if (!state || !line || !line.authorized) {
      throw ApiError.badRequest(
        ErrorCode.RecipientCannotReceive,
        `${account} cannot receive ${token.symbol} yet: it needs ${state ? 'a trustline' : 'an account and a trustline'}.`,
      );
    }
  }

  async getTransfer(session: SessionPrincipal, id: string): Promise<TransferView> {
    const row = await this.prisma.appTransfer.findFirst({
      where: {
        id,
        tier: this.config.app.tier,
        OR: [{ fromAddress: session.address }, { toAccount: session.address }],
      },
    });
    if (!row) throw ApiError.notFound(`Transfer ${id} not found`);
    return this.transferView(row, session.address);
  }

  private async transferView(
    row: TransferRow,
    me: string,
    handles?: Map<string, string>,
  ): Promise<TransferView> {
    const known = handles ?? (await this.handlesOf([row.fromAddress, row.toAccount]));
    return {
      id: row.id,
      network: row.network,
      token: row.tokenSymbol,
      tokenContract: row.token,
      amount: row.amount,
      from: row.fromAddress,
      fromHandle: row.origin === 'external' ? null : (known.get(row.fromAddress) ?? null),
      to: row.toAddress,
      toHandle: known.get(row.toAccount) ?? null,
      note: row.note,
      direction: row.fromAddress === me ? 'out' : 'in',
      status: row.status,
      hash: row.hash,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    };
  }

  // --- activity ----------------------------------------------------------------------

  async activity(session: SessionPrincipal, query: ActivityQueryDto): Promise<ActivityView> {
    const d = await this.deployment(query.network);
    await this.scanIncoming(d, session.address).catch((err: unknown) => {
      this.logger.warn(`Incoming payments of ${session.address} not read: ${String(err)}`);
    });
    const limit = query.limit ?? 20;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) throw ApiError.validation(['cursor is not valid']);
    const before = cursor ? { lte: cursor.at } : undefined;
    const [orders, transfers] = await Promise.all([
      this.prisma.p2pOrder.findMany({
        where: {
          organizationId: APP_ORGANIZATION_ID,
          tier: d.tier,
          network: d.network,
          endUserAddress: session.address,
          ...(before ? { createdAt: before } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: P2P_ORDER_SELECT,
      }),
      this.prisma.appTransfer.findMany({
        where: {
          tier: d.tier,
          network: d.network,
          status: { not: 'PENDING' },
          OR: [{ fromAddress: session.address }, { toAccount: session.address }],
          ...(before ? { createdAt: before } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
    ]);
    type Entry = { at: Date; key: string; build: () => Promise<ActivityItemView> };
    const handles = await this.handlesOf(transfers.flatMap((t) => [t.fromAddress, t.toAccount]));
    const entries: Entry[] = [
      ...orders.map((o) => ({
        at: o.createdAt,
        key: `order|${o.id}`,
        build: async () => ({
          type: 'order',
          at: o.createdAt,
          order: await this.orders.clientView(o, false),
        }),
      })),
      ...transfers.map((t) => ({
        at: t.createdAt,
        key: `transfer|${t.id}`,
        build: async () => ({
          type: 'transfer',
          at: t.createdAt,
          transfer: await this.transferView(t, session.address, handles),
        }),
      })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.key < b.key ? 1 : -1))
      .filter(
        (e) =>
          !cursor ||
          e.at.getTime() < cursor.at.getTime() ||
          (e.at.getTime() === cursor.at.getTime() && e.key < cursor.key),
      );
    const pageEntries = entries.slice(0, limit);
    const last = pageEntries.at(-1);
    const [type, id] = last ? last.key.split('|') : ['', ''];
    return {
      items: await Promise.all(pageEntries.map((e) => e.build())),
      nextCursor: entries.length > limit && last ? encodeCursor(last.at, type, id) : null,
    };
  }

  /**
   * Reads token `transfer` events to `address` from where the last scan
   * stopped, and records each payment that did not come through the app (or
   * from the market contract, which pays orders) as an incoming transfer.
   */
  async scanIncoming(d: Deployment, address: string): Promise<void> {
    const scan = await this.prisma.appIncomingScan.findUnique({
      where: { address_network: { address, network: d.network } },
    });
    if (scan && Date.now() - scan.updatedAt.getTime() < INCOMING_SCAN_EVERY_MS) return;
    const health = await this.chain.health(d);
    const floor = Math.max(health.oldestLedger, health.latestLedger - INCOMING_WINDOW_LEDGERS);
    let startLedger = Math.max(floor, (scan?.lastLedger ?? 0) + 1);
    if (startLedger > health.latestLedger) startLedger = health.latestLedger;
    const toTopic = nativeToScVal(address, { type: 'address' }).toXdr('base64');
    const filters: rpc.Api.EventFilter[] = [
      {
        type: 'contract',
        contractIds: d.tokens.map((t) => t.contract),
        // CAP-67: `transfer` [from, to, asset], and `mint` [to, asset] from the issuer.
        topics: [
          [eventNameTopic('transfer'), '*', toTopic, '**'],
          [eventNameTopic('mint'), toTopic, '**'],
        ],
      },
    ];
    let lastLedger = startLedger;
    let cursor: string | null = null;
    for (let page = 0; page < INCOMING_MAX_PAGES; page++) {
      const res: rpc.Api.GetEventsResponse = cursor
        ? await this.chain.getEvents(d, { filters, cursor, limit: 100 })
        : await this.chain.getEvents(d, { filters, startLedger, limit: 100 });
      for (const ev of res.events) await this.recordIncoming(d, address, ev);
      lastLedger = Math.max(lastLedger, res.latestLedger);
      cursor = res.cursor;
      if (res.events.length < 100) break;
    }
    await this.prisma.appIncomingScan.upsert({
      where: { address_network: { address, network: d.network } },
      create: { address, network: d.network, lastLedger },
      update: { lastLedger },
    });
  }

  private async recordIncoming(
    d: Deployment,
    address: string,
    ev: rpc.Api.EventResponse,
  ): Promise<void> {
    const token = d.tokens.find((t) => t.contract === ev.contractId?.contractId());
    if (!token || ev.topic.length < 3) return;
    const name = scValToNative(ev.topic[0]) as unknown;
    const from = name === 'mint' ? token.issuer : Address.fromScVal(ev.topic[1]).toString();
    if (from === d.contract || from === address) return;
    const raw = scValToNative(ev.value) as unknown;
    const amount =
      typeof raw === 'bigint'
        ? raw
        : raw && typeof raw === 'object' && 'amount' in raw
          ? BigInt((raw as { amount: bigint }).amount)
          : null;
    if (amount === null || amount <= 0n) return;
    const ours = await this.prisma.p2pSubmission.count({
      where: { OR: [{ hash: ev.txHash }, { feeBumpHash: ev.txHash }] },
    });
    const known = await this.prisma.appTransfer.count({ where: { hash: ev.txHash } });
    if (ours > 0 || known > 0) return;
    const at = new Date(ev.ledgerClosedAt);
    await this.prisma.appTransfer
      .create({
        data: {
          id: randomUUID(),
          tier: d.tier,
          network: d.network,
          token: token.contract,
          tokenSymbol: token.symbol,
          amount: amount.toString(),
          fromAddress: from,
          toAddress: address,
          toAccount: address,
          status: 'COMPLETED',
          origin: 'external',
          hash: ev.txHash,
          eventId: ev.id,
          createdAt: at,
          completedAt: at,
        },
      })
      .catch((err: unknown) => {
        // Seen already (the event id is unique).
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'))
          throw err;
      });
  }
}
