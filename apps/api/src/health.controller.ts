import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiSchema, ApiTags } from '@nestjs/swagger';
import { Public } from '@/auth/decorators';
import { PrismaService } from '@/prisma/prisma.service';

@ApiSchema({ name: 'Health' })
class HealthView {
  @ApiProperty({ example: 'ok' }) status!: string;
}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Liveness and database reachability' })
  @ApiOkResponse({ type: HealthView })
  async health(): Promise<HealthView> {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
}
