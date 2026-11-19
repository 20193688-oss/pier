import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ApiKeysService } from '@/auth/api-keys.service';
import { AuthController } from '@/auth/auth.controller';
import { AuthGuard } from '@/auth/auth.guard';
import { SessionsService } from '@/auth/sessions.service';
import { ChainClient } from '@/chain/chain-client.service';
import { DeploymentsService } from '@/chain/deployments.service';
import { MarketReader } from '@/chain/market-reader.service';
import { DataCipher } from '@/common/data-cipher';
import { ErrorFilter } from '@/common/error.filter';
import { RateLimitGuard, RateLimiter } from '@/common/rate-limit';
import { ConfigModule } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { HealthController } from '@/health.controller';
import { OrganizationsController } from '@/organizations/organizations.controller';
import { OrganizationsService } from '@/organizations/organizations.service';
import { P2pModule } from '@/p2p/p2p.module';
import { PrismaModule } from '@/prisma/prisma.module';
import { WebhookSenderJob } from '@/webhooks/webhook-sender.job';
import { WebhooksController } from '@/webhooks/webhooks.controller';
import { WebhooksService } from '@/webhooks/webhooks.service';

/** What every feature module shares: the chain layer, the cipher, auth. */
@Global()
@Module({
  providers: [
    DeploymentsService,
    ChainClient,
    MarketReader,
    DataCipher,
    SessionsService,
    ApiKeysService,
    RateLimiter,
  ],
  exports: [
    DeploymentsService,
    ChainClient,
    MarketReader,
    DataCipher,
    SessionsService,
    ApiKeysService,
    RateLimiter,
  ],
})
class CoreModule {}

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        PrismaModule,
        CoreModule,
        P2pModule.register({ devTools: config.dev.tools }),
      ],
      controllers: [HealthController, AuthController, OrganizationsController, WebhooksController],
      providers: [
        OrganizationsService,
        WebhooksService,
        WebhookSenderJob,
        // Guards run in this order: who is calling, then how often.
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}
