import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ApiKeysService } from '@/auth/api-keys.service';
import { AuthController, WellKnownController } from '@/auth/auth.controller';
import { AuthGuard } from '@/auth/auth.guard';
import { Sep10Service } from '@/auth/sep10.service';
import { SessionsService } from '@/auth/sessions.service';
import { ChainClient } from '@/chain/chain-client.service';
import { DeploymentsService } from '@/chain/deployments.service';
import { MarketReader } from '@/chain/market-reader.service';
import { TxBuilder } from '@/chain/tx-builder.service';
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

const CORE = [
  DeploymentsService,
  ChainClient,
  MarketReader,
  TxBuilder,
  DataCipher,
  Sep10Service,
  SessionsService,
  ApiKeysService,
  RateLimiter,
];

/** What every feature module shares: the chain layer, the cipher, auth. */
@Global()
@Module({})
class CoreModule {
  static register(chain?: unknown): DynamicModule {
    // Tests replace the chain client (no network) with a fake.
    const providers: Provider[] = chain
      ? [...CORE.filter((p) => p !== ChainClient), { provide: ChainClient, useValue: chain }]
      : CORE;
    return { module: CoreModule, providers, exports: CORE };
  }
}

/** What a test may replace. */
export interface AppOverrides {
  /** A stand-in for `ChainClient`. */
  chain?: unknown;
}

@Module({})
export class AppModule {
  static register(config: AppConfig, overrides: AppOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        PrismaModule,
        CoreModule.register(overrides.chain),
        P2pModule.register({ devTools: config.dev.tools }),
      ],
      controllers: [
        HealthController,
        AuthController,
        WellKnownController,
        OrganizationsController,
        WebhooksController,
      ],
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
