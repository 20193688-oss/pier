import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** The `take` / `skip` pair every list accepts. */
export class PageQueryDto {
  @ApiPropertyOptional({
    default: 20,
    minimum: 1,
    maximum: 100,
    description: 'Page size (1 to 100).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take: number = 20;

  @ApiPropertyOptional({ default: 0, minimum: 0, description: 'Items to skip (offset).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;
}

export interface Page<T> {
  data: T[];
  total: number;
  take: number;
  skip: number;
}

export function page<T>(data: T[], total: number, query: { take: number; skip: number }): Page<T> {
  return { data, total, take: query.take, skip: query.skip };
}
