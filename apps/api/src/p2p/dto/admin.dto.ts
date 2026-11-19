import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { PageQueryDto } from '@/common/pagination';

/** The platform console's P2P requests (`/v1/admin/p2p/*`). */

export class AdminDisputesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['live', 'test'] })
  @IsOptional()
  @IsIn(['live', 'test'])
  tier?: 'live' | 'test';
}

@ApiSchema({ description: 'How the arbiter splits a disputed order.' })
export class AdminResolutionDto {
  @ApiProperty({
    example: '100000000',
    description:
      "Base units of the order's amount that go to the buyer (fees are taken from it); the rest goes back to the seller.",
  })
  @Matches(/^(0|[1-9]\d{0,37})$/, {
    message: 'toBuyer must be a non-negative integer in base units',
  })
  toBuyer!: string;

  @ApiPropertyOptional({
    example: '0',
    description:
      "Base units of the buyer's bond that go to the seller; the rest goes back to the buyer.",
  })
  @IsOptional()
  @Matches(/^(0|[1-9]\d{0,37})$/, {
    message: 'bondToSeller must be a non-negative integer in base units',
  })
  bondToSeller?: string;
}

@ApiSchema({ description: 'A merchant status only the platform sets.' })
export class AdminMerchantDto {
  @ApiProperty({
    enum: ['ACTIVE', 'SUSPENDED'],
    description: 'SUSPENDED stops the merchant from being matched.',
  })
  @IsIn(['ACTIVE', 'SUSPENDED'])
  merchantStatus!: 'ACTIVE' | 'SUSPENDED';
}
