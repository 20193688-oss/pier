import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import { AccountsService } from '@/p2p/accounts.service';
import { AdminService } from '@/p2p/admin.service';
import { AppChargesService } from '@/p2p/app-charges.service';
import { AppWalletService } from '@/p2p/app-wallet.service';
import { AppWalletController, SubmitController } from '@/p2p/controllers/app-wallet.controller';
import { AppOrdersService } from '@/p2p/app-orders.service';
import { ChargesService } from '@/p2p/charges.service';
import { CheckoutService } from '@/p2p/checkout.service';
import {
  AccountsController,
  PaymentMethodsController,
} from '@/p2p/controllers/accounts.controller';
import {
  ChargesController,
  CheckoutController,
  PayoutsController,
} from '@/p2p/controllers/collections.controller';
import { DevController } from '@/p2p/controllers/dev.controller';
import {
  AdminController,
  AppController,
  MarketController,
} from '@/p2p/controllers/public.controller';
import { OffersController, OrdersController } from '@/p2p/controllers/trading.controller';
import { DevToolsService } from '@/p2p/dev-tools.service';
import { ExpiryJob } from '@/p2p/expiry.job';
import { IndexerJob } from '@/p2p/indexer.job';
import { MarketService } from '@/p2p/market.service';
import { MatcherFollowerJob } from '@/p2p/matcher-follower.job';
import { MatcherService } from '@/p2p/matcher.service';
import { OffersService } from '@/p2p/offers.service';
import { OrderOpener } from '@/p2p/order-opener.service';
import { OrdersService } from '@/p2p/orders.service';
import { PaymentMethodsService } from '@/p2p/payment-methods.service';
import { PayoutsService } from '@/p2p/payouts.service';
import { QuotesService } from '@/p2p/quotes.service';
import { SubmissionFollowerJob } from '@/p2p/submission-follower.job';
import { SubmissionsService } from '@/p2p/submissions.service';
import { TransactionsService } from '@/p2p/transactions.service';
import { TransferMatchesService } from '@/p2p/transfer-matches.service';

const SERVICES: Provider[] = [
  AccountsService,
  PaymentMethodsService,
  OffersService,
  QuotesService,
  MatcherService,
  OrderOpener,
  OrdersService,
  TransactionsService,
  TransferMatchesService,
  ChargesService,
  CheckoutService,
  PayoutsService,
  AdminService,
  MarketService,
  AppOrdersService,
  AppWalletService,
  AppChargesService,
  SubmissionsService,
  IndexerJob,
  ExpiryJob,
  MatcherFollowerJob,
  SubmissionFollowerJob,
];

const CONTROLLERS: Type[] = [
  MarketController,
  AccountsController,
  PaymentMethodsController,
  OffersController,
  OrdersController,
  ChargesController,
  PayoutsController,
  CheckoutController,
  AppController,
  AppWalletController,
  SubmitController,
  AdminController,
];

/** The P2P market. The dev tools are wired only when `devTools` (DEV_TOOLS=true). */
@Module({})
export class P2pModule {
  static register(options: { devTools: boolean }): DynamicModule {
    return {
      module: P2pModule,
      controllers: options.devTools ? [...CONTROLLERS, DevController] : CONTROLLERS,
      providers: options.devTools ? [...SERVICES, DevToolsService] : SERVICES,
      exports: [IndexerJob, ExpiryJob, MatcherFollowerJob, SubmissionFollowerJob, MarketService],
    };
  }
}
