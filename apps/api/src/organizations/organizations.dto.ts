import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MEMBER_ROLES, SCOPES } from '@/auth/auth.types';
import { TIERS } from '@/chain/networks';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

@ApiSchema({ name: 'CreateOrganization' })
export class CreateOrganizationDto {
  @ApiProperty({ example: 'Pampa Cambio', minLength: 2, maxLength: 80 })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;
}

@ApiSchema({ name: 'UpdateOrganization' })
export class UpdateOrganizationDto extends CreateOrganizationDto {}

@ApiSchema({ name: 'Organization', description: 'A tenant: a business, a merchant, or both.' })
export class OrganizationView {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: MEMBER_ROLES, description: 'Your role in it.' }) role!: string;
  @ApiProperty() createdAt!: Date;
}

@ApiSchema({ name: 'OrganizationList' })
export class OrganizationListView {
  @ApiProperty({ type: [OrganizationView] }) data!: OrganizationView[];
}

@ApiSchema({ name: 'AddMember' })
export class AddMemberDto {
  @ApiProperty({ example: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' })
  @Matches(EVM_ADDRESS, { message: 'address must be an EVM address' })
  address!: string;

  @ApiProperty({ enum: MEMBER_ROLES, example: 'member' })
  @IsIn(MEMBER_ROLES)
  role!: (typeof MEMBER_ROLES)[number];
}

@ApiSchema({ name: 'UpdateMember' })
export class UpdateMemberDto {
  @ApiProperty({ enum: MEMBER_ROLES })
  @IsIn(MEMBER_ROLES)
  role!: (typeof MEMBER_ROLES)[number];
}

@ApiSchema({ name: 'Member', description: 'A wallet that signs in for an organization.' })
export class MemberView {
  @ApiProperty() id!: string;
  @ApiProperty({ example: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' }) address!: string;
  @ApiProperty({ enum: MEMBER_ROLES }) role!: string;
  @ApiProperty() createdAt!: Date;
}

@ApiSchema({ name: 'MemberList' })
export class MemberListView {
  @ApiProperty({ type: [MemberView] }) data!: MemberView[];
}

@ApiSchema({ name: 'CreateApiKey' })
export class CreateApiKeyDto {
  @ApiProperty({ example: 'Merchant bot', minLength: 1, maxLength: 60 })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @ApiProperty({
    enum: TIERS,
    example: 'test',
    description:
      '`live` keys (`pk_live_`) act on mainnet; `test` keys (`pk_test_`) on test networks.',
  })
  @IsIn(TIERS)
  tier!: (typeof TIERS)[number];

  @ApiProperty({ enum: SCOPES, isArray: true, example: ['p2p:read', 'p2p:write'] })
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(SCOPES, { each: true })
  scopes!: (typeof SCOPES)[number][];
}

@ApiSchema({ name: 'ApiKey', description: 'An API key; the secret itself is shown only once.' })
export class ApiKeyView {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: TIERS }) tier!: string;
  @ApiProperty({
    example: 'pk_test_AbCd',
    description: 'The first characters, for recognising it.',
  })
  prefix!: string;
  @ApiProperty({ enum: SCOPES, isArray: true }) scopes!: string[];
  @ApiProperty({ description: 'The wallet that created it.' }) createdBy!: string;
  @ApiPropertyOptional({ nullable: true, type: Date }) lastUsedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true, type: Date }) revokedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

@ApiSchema({ name: 'CreatedApiKey' })
export class CreatedApiKeyView extends ApiKeyView {
  @ApiProperty({
    example: 'pk_test_x2V...',
    description: 'The secret: store it now, it is never shown again.',
  })
  key!: string;
}

@ApiSchema({ name: 'ApiKeyList' })
export class ApiKeyListView {
  @ApiProperty({ type: [ApiKeyView] }) data!: ApiKeyView[];
}
