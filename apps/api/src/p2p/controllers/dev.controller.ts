import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '@/auth/decorators';
import { RateLimit } from '@/common/rate-limit';
import { DevToolsService } from '@/p2p/dev-tools.service';

/**
 * Development only: registered when `DEV_TOOLS=true` (refused in production)
 * and acting only on the local dev chain (31337). Not part of the public
 * contract, so it is left out of the OpenAPI document.
 */
@ApiExcludeController()
@Controller('v1/dev')
export class DevController {
  constructor(private readonly dev: DevToolsService) {}

  /** Plays the merchant's bot: a bank transfer for this order "arrived". */
  @Post('orders/:id/simulate-transfer')
  @Public()
  @HttpCode(200)
  @RateLimit({ name: 'dev:simulate', limit: 60, windowMs: 60_000, per: 'ip' })
  simulate(@Param('id') id: string) {
    return this.dev.simulateTransfer(id);
  }
}
