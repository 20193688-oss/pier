import { Injectable } from '@nestjs/common';
import { ApiKeysService } from '@/auth/api-keys.service';
import { ROLE_RANK, type MemberRole, type Scope } from '@/auth/auth.types';
import type { Tier } from '@/chain/networks';
import { isAccountAddress } from '@/common/stellar';
import { ApiError, ErrorCode } from '@/common/api-error';
import type {
  ApiKeyView,
  CreatedApiKeyView,
  MemberView,
  OrganizationView,
} from '@/organizations/organizations.dto';
import { PrismaService } from '@/prisma/prisma.service';

/** Organizations one wallet may create. */
const MAX_OWNED_ORGANIZATIONS = 20;
/** Members of one organization. */
const MAX_MEMBERS = 100;

/**
 * Organizations, their members and their API keys, managed by members
 * through wallet sessions (never by API keys). Roles: an owner manages
 * members; an admin manages keys, webhooks and the P2P setup; a member reads.
 * A wallet that is not a member gets the 404 of a missing organization.
 */
@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly apiKeys: ApiKeysService,
  ) {}

  /** The caller's role in an organization, at least `min`; 404 when not a member, 403 below `min`. */
  async requireRole(organizationId: string, address: string, min: MemberRole): Promise<MemberRole> {
    const member = await this.prisma.member.findFirst({
      where: { organizationId, address, organization: { system: false } },
      select: { role: true },
    });
    if (!member) throw ApiError.notFound(`Organization ${organizationId} not found`);
    const role = member.role as MemberRole;
    if (ROLE_RANK[role] < ROLE_RANK[min]) {
      throw ApiError.forbidden(`This needs the ${min} role; yours is ${role}.`);
    }
    return role;
  }

  async create(address: string, name: string): Promise<OrganizationView> {
    const owned = await this.prisma.member.count({ where: { address, role: 'owner' } });
    if (owned >= MAX_OWNED_ORGANIZATIONS) {
      throw ApiError.conflict(
        ErrorCode.Conflict,
        `A wallet owns at most ${MAX_OWNED_ORGANIZATIONS} organizations.`,
      );
    }
    const org = await this.prisma.organization.create({
      data: { name: name.trim(), members: { create: { address, role: 'owner' } } },
    });
    return { id: org.id, name: org.name, role: 'owner', createdAt: org.createdAt };
  }

  async list(address: string): Promise<OrganizationView[]> {
    const rows = await this.prisma.member.findMany({
      where: { address, organization: { system: false } },
      orderBy: { createdAt: 'asc' },
      select: { role: true, organization: { select: { id: true, name: true, createdAt: true } } },
    });
    return rows.map((r) => ({ ...r.organization, role: r.role }));
  }

  async get(organizationId: string, address: string): Promise<OrganizationView> {
    const role = await this.requireRole(organizationId, address, 'member');
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    return { id: org.id, name: org.name, role, createdAt: org.createdAt };
  }

  async rename(organizationId: string, address: string, name: string): Promise<OrganizationView> {
    const role = await this.requireRole(organizationId, address, 'admin');
    const org = await this.prisma.organization.update({
      where: { id: organizationId },
      data: { name: name.trim() },
    });
    return { id: org.id, name: org.name, role, createdAt: org.createdAt };
  }

  // --- members ---------------------------------------------------------------

  async members(organizationId: string, address: string): Promise<MemberView[]> {
    await this.requireRole(organizationId, address, 'member');
    return this.prisma.member.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, address: true, role: true, createdAt: true },
    });
  }

  async addMember(
    organizationId: string,
    caller: string,
    input: { address: string; role: MemberRole },
  ): Promise<MemberView> {
    await this.requireRole(organizationId, caller, 'owner');
    const count = await this.prisma.member.count({ where: { organizationId } });
    if (count >= MAX_MEMBERS) {
      throw ApiError.conflict(
        ErrorCode.Conflict,
        `An organization has at most ${MAX_MEMBERS} members.`,
      );
    }
    const address = input.address;
    if (!isAccountAddress(address)) {
      throw ApiError.validation(['address must be a Stellar account address (G...)']);
    }
    const existing = await this.prisma.member.findFirst({ where: { organizationId, address } });
    if (existing) throw ApiError.conflict(ErrorCode.Conflict, 'This wallet is already a member.');
    return this.prisma.member.create({
      data: { organizationId, address, role: input.role },
      select: { id: true, address: true, role: true, createdAt: true },
    });
  }

  async updateMember(
    organizationId: string,
    caller: string,
    memberId: string,
    role: MemberRole,
  ): Promise<MemberView> {
    await this.requireRole(organizationId, caller, 'owner');
    return this.prisma.$transaction(async (tx) => {
      const member = await tx.member.findFirst({ where: { id: memberId, organizationId } });
      if (!member) throw ApiError.notFound(`Member ${memberId} not found`);
      if (member.role === 'owner' && role !== 'owner') {
        const owners = await tx.member.count({ where: { organizationId, role: 'owner' } });
        if (owners <= 1) {
          throw ApiError.conflict(ErrorCode.LastOwner, 'An organization keeps at least one owner.');
        }
      }
      return tx.member.update({
        where: { id: memberId },
        data: { role },
        select: { id: true, address: true, role: true, createdAt: true },
      });
    });
  }

  /** An owner removes a member, or a member leaves; the last owner never goes. */
  async removeMember(organizationId: string, caller: string, memberId: string): Promise<void> {
    const callerRole = await this.requireRole(organizationId, caller, 'member');
    await this.prisma.$transaction(async (tx) => {
      const member = await tx.member.findFirst({ where: { id: memberId, organizationId } });
      if (!member) throw ApiError.notFound(`Member ${memberId} not found`);
      if (member.address !== caller && callerRole !== 'owner') {
        throw ApiError.forbidden('Only an owner removes another member.');
      }
      if (member.role === 'owner') {
        const owners = await tx.member.count({ where: { organizationId, role: 'owner' } });
        if (owners <= 1) {
          throw ApiError.conflict(ErrorCode.LastOwner, 'An organization keeps at least one owner.');
        }
      }
      await tx.member.delete({ where: { id: memberId } });
    });
  }

  // --- API keys --------------------------------------------------------------------

  async listKeys(organizationId: string, caller: string): Promise<ApiKeyView[]> {
    await this.requireRole(organizationId, caller, 'admin');
    return this.apiKeys.list(organizationId);
  }

  async createKey(
    organizationId: string,
    caller: string,
    input: { name: string; tier: Tier; scopes: Scope[] },
  ): Promise<CreatedApiKeyView> {
    await this.requireRole(organizationId, caller, 'admin');
    const { key, row } = await this.apiKeys.create({
      organizationId,
      tier: input.tier,
      name: input.name.trim(),
      scopes: input.scopes,
      createdBy: caller,
    });
    return { ...row, key };
  }

  async revokeKey(organizationId: string, caller: string, keyId: string): Promise<void> {
    await this.requireRole(organizationId, caller, 'admin');
    await this.apiKeys.revoke(organizationId, keyId);
  }
}
