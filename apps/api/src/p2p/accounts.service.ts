import { Injectable } from '@nestjs/common';
import type { OrgPrincipal } from '@/auth/auth.types';
import { Sep10Service } from '@/auth/sep10.service';
import { DeploymentsService } from '@/chain/deployments.service';
import { MarketReader } from '@/chain/market-reader.service';
import type { Tier } from '@/chain/networks';
import { ApiError, ErrorCode } from '@/common/api-error';
import { page, type Page, type PageQueryDto } from '@/common/pagination';
import { isAccountAddress } from '@/common/stellar';
import { Prisma } from '@/generated/prisma/client';
import type {
  CreateChallengeDto,
  RegisterAccountDto,
  UpdateAccountDto,
} from '@/p2p/dto/account.dto';
import type {
  AccountDetailView,
  AccountNetworkView,
  AccountView,
  ChallengeView,
} from '@/p2p/entities/account.entity';
import { P2P_LIVE_STATUSES } from '@/p2p/domain/order-status';
import { tierOf } from '@/p2p/tier';
import { P2P_ACCOUNT_SELECT, toAccountView, type P2pAccountRow } from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * An organization's Stellar accounts. Each is proven by a SEP-10-shaped
 * challenge (never a message signature) whose `organization` entry binds it
 * to the organization and tier; the account's signers must reach its medium
 * threshold. An account belongs to one organization per tier.
 */
@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly reader: MarketReader,
    private readonly sep10: Sep10Service,
  ) {}

  async challenge(org: OrgPrincipal, dto: CreateChallengeDto): Promise<ChallengeView> {
    const tier = tierOf(org, this.deployments);
    const network = this.deployments.pick(tier, dto.network);
    return this.sep10.challenge(dto.address, 'account', network, {
      organizationId: org.organizationId,
      tier,
    });
  }

  /**
   * Registers an account: its signed challenge must be one issued for this
   * organization and tier, and is then spent (compare-and-swap), so a
   * signature registers once.
   */
  async register(org: OrgPrincipal, dto: RegisterAccountDto): Promise<AccountView> {
    const tier = tierOf(org, this.deployments);
    const network = this.deployments.pick(tier, dto.network);
    const address = await this.sep10.verify(dto.transaction, 'account', network, {
      organizationId: org.organizationId,
      tier,
    });
    try {
      const row = await this.prisma.p2pAccount.create({
        data: {
          organizationId: org.organizationId,
          tier,
          address,
          label: dto.label?.trim() || null,
          displayName: dto.displayName?.trim() || null,
          verifiedAt: new Date(),
        },
        select: P2P_ACCOUNT_SELECT,
      });
      return toAccountView(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw ApiError.conflict(
          ErrorCode.AccountTaken,
          `This account is already registered on the ${tier} tier.`,
        );
      }
      throw err;
    }
  }

  async list(org: OrgPrincipal, query: PageQueryDto): Promise<Page<AccountView>> {
    const tier = tierOf(org, this.deployments);
    const where = { organizationId: org.organizationId, tier };
    const [rows, total] = await Promise.all([
      this.prisma.p2pAccount.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_ACCOUNT_SELECT,
      }),
      this.prisma.p2pAccount.count({ where }),
    ]);
    return page(rows.map(toAccountView), total, query);
  }

  /** One account with what the contract holds for it on every live network. */
  async get(org: OrgPrincipal, id: string): Promise<AccountDetailView> {
    const tier = tierOf(org, this.deployments);
    const row = await this.owned(org.organizationId, tier, id);
    return { ...toAccountView(row), networks: await this.onchain(row, tier) };
  }

  private async onchain(row: P2pAccountRow, tier: Tier): Promise<AccountNetworkView[]> {
    const matcher = this.deployments.matcherAddress();
    const [live, locked] = await Promise.all([
      this.reader.liveDeployments(tier),
      this.lockedByToken(row.address, tier),
    ]);
    const seen = (row.operators ?? {}) as Record<string, Record<string, number> | undefined>;
    const results = await Promise.all(
      live.map(async (d) => {
        try {
          const [balances, terms] = await Promise.all([
            Promise.all(
              d.tokens.map(async (t) => ({
                symbol: t.symbol,
                token: t.contract,
                decimals: t.decimals,
                amount: (await this.reader.balanceOf(d, row.address, t.contract, true)).toString(),
                locked: (locked.get(`${d.network}:${t.contract}`) ?? 0n).toString(),
              })),
            ),
            matcher
              ? this.reader.matcherTerms(d, row.address, matcher, true)
              : Promise.resolve({ maxPerOrder: 0n, autoSettle: false }),
          ]);
          const operators = Object.fromEntries(
            Object.entries(seen[d.network] ?? {}).filter(([, bits]) => bits > 0),
          );
          return [
            {
              network: d.network,
              balances,
              matcher: { maxPerOrder: terms.maxPerOrder.toString(), autoSettle: terms.autoSettle },
              operators,
            },
          ];
        } catch {
          return [];
        }
      }),
    );
    return results.flat();
  }

  /**
   * What `address` has locked in live orders, per `network:token`, from this
   * service's rows: the amount of each order it sells in, plus the bond of each
   * it accepted as the buyer. The contract's free balance is the authority.
   */
  private async lockedByToken(address: string, tier: Tier): Promise<Map<string, bigint>> {
    const open = ['awaiting_acceptance', 'awaiting_payment', 'paid', 'disputed'];
    const accepted = ['awaiting_payment', 'paid', 'disputed'];
    const rows = await this.prisma.p2pOrder.findMany({
      where: {
        tier,
        OR: [
          { sellerAddress: address, status: { in: open } },
          { buyerAddress: address, status: { in: accepted }, bond: { not: '0' } },
        ],
      },
      select: { network: true, token: true, sellerAddress: true, tokenAmount: true, bond: true },
    });
    const totals = new Map<string, bigint>();
    for (const o of rows) {
      const key = `${o.network}:${o.token}`;
      const part = o.sellerAddress === address ? BigInt(o.tokenAmount) : BigInt(o.bond);
      totals.set(key, (totals.get(key) ?? 0n) + part);
    }
    return totals;
  }

  async update(org: OrgPrincipal, id: string, dto: UpdateAccountDto): Promise<AccountView> {
    const tier = tierOf(org, this.deployments);
    const row = await this.owned(org.organizationId, tier, id);
    const suspended = () =>
      ApiError.badRequest(
        ErrorCode.InvalidState,
        'This account is suspended by the platform: its status cannot be changed here.',
      );
    if (dto.merchantStatus && row.merchantStatus === 'SUSPENDED') throw suspended();
    const updated = await this.prisma.p2pAccount.updateMany({
      where: {
        id: row.id,
        organizationId: org.organizationId,
        tier,
        // Never lifts a suspension that landed meanwhile.
        ...(dto.merchantStatus ? { merchantStatus: { not: 'SUSPENDED' } } : {}),
      },
      data: {
        ...(dto.label !== undefined ? { label: dto.label.trim() || null } : {}),
        ...(dto.displayName !== undefined ? { displayName: dto.displayName.trim() || null } : {}),
        ...(dto.merchantStatus ? { merchantStatus: dto.merchantStatus } : {}),
      },
    });
    if (updated.count !== 1) throw suspended();
    return toAccountView(await this.owned(org.organizationId, tier, id));
  }

  /**
   * Forgets an account, its payment methods and offers. Refused while it has
   * live orders (the counterparty still needs its details). Its tokens stay in
   * the contract, withdrawable by the wallet.
   */
  async remove(org: OrgPrincipal, id: string): Promise<void> {
    const tier = tierOf(org, this.deployments);
    const row = await this.owned(org.organizationId, tier, id);
    const live = await this.prisma.p2pOrder.count({
      where: {
        tier,
        status: { in: [...P2P_LIVE_STATUSES] },
        OR: [
          { merchantAccountId: row.id },
          { sellerAddress: row.address, organizationId: org.organizationId },
        ],
      },
    });
    if (live > 0) {
      throw ApiError.conflict(
        ErrorCode.OperationInFlight,
        'This account has live orders: wait until they end before removing it.',
      );
    }
    await this.prisma.p2pAccount.deleteMany({
      where: { id: row.id, organizationId: org.organizationId, tier },
    });
  }

  /** The organization's account by id on its tier, or the 404 of a missing one. */
  async owned(organizationId: string, tier: Tier, id: string): Promise<P2pAccountRow> {
    const row = await this.prisma.p2pAccount.findFirst({
      where: { id, organizationId, tier },
      select: P2P_ACCOUNT_SELECT,
    });
    if (!row) throw ApiError.notFound(`Account ${id} not found`);
    return row;
  }

  /** The organization's account by id or by address on its tier, or a 404. */
  async ownedByRef(organizationId: string, tier: Tier, ref: string): Promise<P2pAccountRow> {
    const row = await this.prisma.p2pAccount.findFirst({
      where: isAccountAddress(ref)
        ? { address: ref, organizationId, tier }
        : { id: ref, organizationId, tier },
      select: P2P_ACCOUNT_SELECT,
    });
    if (!row) throw ApiError.notFound(`Account ${ref} not found`);
    return row;
  }

  /** The organization's only account on its tier, or a 400 asking which. */
  async soleAccount(organizationId: string, tier: Tier, purpose: string): Promise<P2pAccountRow> {
    const rows = await this.prisma.p2pAccount.findMany({
      where: { organizationId, tier },
      take: 2,
      select: P2P_ACCOUNT_SELECT,
    });
    if (rows.length !== 1) {
      throw ApiError.badRequest(
        ErrorCode.ValidationFailed,
        rows.length === 0
          ? `Register a wallet first (POST /v1/p2p/accounts): it is the account ${purpose}.`
          : `You have several accounts: name the one ${purpose}.`,
      );
    }
    return rows[0];
  }
}
