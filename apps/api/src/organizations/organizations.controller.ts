import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { SessionPrincipal } from '@/auth/auth.types';
import { CurrentSession, SessionAuth } from '@/auth/decorators';
import { ApiErrors } from '@/common/openapi';
import {
  AddMemberDto,
  ApiKeyListView,
  CreateApiKeyDto,
  CreatedApiKeyView,
  CreateOrganizationDto,
  MemberListView,
  MemberView,
  OrganizationListView,
  OrganizationView,
  UpdateMemberDto,
  UpdateOrganizationDto,
} from '@/organizations/organizations.dto';
import { OrganizationsService } from '@/organizations/organizations.service';

/**
 * Organizations, members and API keys: managed by members through wallet
 * sessions only (an API key never creates keys or members).
 */
@ApiTags('Organizations')
@Controller('v1/organizations')
@SessionAuth()
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create an organization',
    description: 'The signed-in wallet becomes its owner.',
  })
  @ApiCreatedResponse({ type: OrganizationView })
  @ApiErrors(400, 409)
  create(
    @CurrentSession() session: SessionPrincipal,
    @Body() dto: CreateOrganizationDto,
  ): Promise<OrganizationView> {
    return this.organizations.create(session.address, dto.name);
  }

  @Get()
  @ApiOperation({
    summary: 'Your organizations',
    description: 'Every organization the wallet is a member of.',
  })
  @ApiOkResponse({ type: OrganizationListView })
  async list(@CurrentSession() session: SessionPrincipal): Promise<OrganizationListView> {
    return { data: await this.organizations.list(session.address) };
  }

  @Get(':orgId')
  @ApiOperation({ summary: 'One organization' })
  @ApiOkResponse({ type: OrganizationView })
  @ApiErrors(404)
  get(
    @CurrentSession() session: SessionPrincipal,
    @Param('orgId') orgId: string,
  ): Promise<OrganizationView> {
    return this.organizations.get(orgId, session.address);
  }

  @Patch(':orgId')
  @ApiOperation({ summary: 'Rename an organization', description: 'Admins and owners.' })
  @ApiOkResponse({ type: OrganizationView })
  @ApiErrors(400, 404)
  rename(
    @CurrentSession() session: SessionPrincipal,
    @Param('orgId') orgId: string,
    @Body() dto: UpdateOrganizationDto,
  ): Promise<OrganizationView> {
    return this.organizations.rename(orgId, session.address, dto.name);
  }

  @Get(':orgId/members')
  @ApiOperation({ summary: 'Members of an organization' })
  @ApiOkResponse({ type: MemberListView })
  @ApiErrors(404)
  async members(
    @CurrentSession() session: SessionPrincipal,
    @Param('orgId') orgId: string,
  ): Promise<MemberListView> {
    return { data: await this.organizations.members(orgId, session.address) };
  }

  @Post(':orgId/members')
  @ApiOperation({
    summary: 'Add a member',
    description: 'Owners only. The wallet signs in with SIWE to act.',
  })
  @ApiCreatedResponse({ type: MemberView })
  @ApiErrors(400, 404, 409)
  addMember(
    @CurrentSession() session: SessionPrincipal,
    @Param('orgId') orgId: string,
    @Body() dto: AddMemberDto,
  ): Promise<MemberView> {
    return this.organizations.addMember(orgId, session.address, dto);
  }

  @Patch(':orgId/members/:memberId')
  @ApiOperation({
    summary: 'Change a member’s role',
    description: 'Owners only; the last owner stays an owner.',
  })
  @ApiOkResponse({ type: MemberView })
  @ApiErrors(400, 404, 409)
  updateMember(
    @CurrentSession() session: SessionPrincipal,
    @Param('orgId') orgId: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateMemberDto,
  ): Promise<MemberView> {
    return this.organizations.updateMember(orgId, session.address, memberId, dto.role);
  }

  @Delete(':orgId/members/:memberId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a member',
    description: 'Owners remove anyone; a member may remove itself. The last owner stays.',
  })
  @ApiNoContentResponse()
  @ApiErrors(404, 409)
  removeMember(
    @CurrentSession() session: SessionPrincipal,
    @Param('orgId') orgId: string,
    @Param('memberId') memberId: string,
  ): Promise<void> {
    return this.organizations.removeMember(orgId, session.address, memberId);
  }

  @Get(':orgId/api-keys')
  @ApiOperation({
    summary: 'API keys of an organization',
    description: 'Admins and owners; secrets are never shown again.',
  })
  @ApiOkResponse({ type: ApiKeyListView })
  @ApiErrors(404)
  async keys(
    @CurrentSession() session: SessionPrincipal,
    @Param('orgId') orgId: string,
  ): Promise<ApiKeyListView> {
    return { data: await this.organizations.listKeys(orgId, session.address) };
  }

  @Post(':orgId/api-keys')
  @ApiOperation({
    summary: 'Create an API key',
    description:
      'Admins and owners. `test` keys act on test networks only, `live` keys on mainnet only. The secret is in this response and never again.',
  })
  @ApiCreatedResponse({ type: CreatedApiKeyView })
  @ApiErrors(400, 404)
  createKey(
    @CurrentSession() session: SessionPrincipal,
    @Param('orgId') orgId: string,
    @Body() dto: CreateApiKeyDto,
  ): Promise<CreatedApiKeyView> {
    return this.organizations.createKey(orgId, session.address, dto);
  }

  @Delete(':orgId/api-keys/:keyId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revoke an API key',
    description: 'Admins and owners; effective at once.',
  })
  @ApiNoContentResponse()
  @ApiErrors(404)
  revokeKey(
    @CurrentSession() session: SessionPrincipal,
    @Param('orgId') orgId: string,
    @Param('keyId') keyId: string,
  ): Promise<void> {
    return this.organizations.revokeKey(orgId, session.address, keyId);
  }
}
