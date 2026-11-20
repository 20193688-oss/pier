import { Inject, Injectable } from '@nestjs/common';
import { Keypair, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import { DeploymentsService, type Deployment } from '@/chain/deployments.service';
import { p2pCall, type P2pOrderAction } from '@/chain/market-codec';
import { NETWORKS, type Tier } from '@/chain/networks';
import { TxBuilder } from '@/chain/tx-builder.service';
import { ApiError, ErrorCode } from '@/common/api-error';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { isUuid } from '@/p2p/domain/order-ref';
import { P2P_MERCHANT_SIDE, type P2pOrderKind } from '@/p2p/domain/order-status';
import { P2P_ORDER_SELECT } from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';

/** How long a dev transaction is waited for. */
const DEV_TX_WAIT_MS = 30_000;

export interface SimulatedTransfer {
  orderId: string;
  kind: string;
  /** What the dev merchant did, in order, with each transaction's hash. */
  steps: { action: string; hash: string }[];
}

/**
 * Development only (`DEV_TOOLS=true`, refused in production): plays the
 * merchant's bot so a whole order can be clicked through without a bank. "A
 * bank transfer arrived" means:
 *
 *   - a purchase or charge (the merchant sells): the merchant releases;
 *   - a sale, QR payment or payout (the merchant buys): the merchant accepts
 *     if needed and marks the order paid (it "sent" the local money).
 *
 * It signs with the merchant's dev secret (`DEV_WALLET_SECRETS`), and refuses
 * any order that is not on a test network (`local` or `testnet`; never
 * mainnet). The indexer moves the order afterwards, as for real.
 */
@Injectable()
export class DevToolsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly builder: TxBuilder,
  ) {}

  async simulateTransfer(orderId: string): Promise<SimulatedTransfer> {
    if (!this.config.dev.tools || this.config.nodeEnv === 'production') {
      throw ApiError.forbidden('The dev tools are off on this deployment.');
    }
    const row = isUuid(orderId)
      ? await this.prisma.p2pOrder.findUnique({ where: { id: orderId }, select: P2P_ORDER_SELECT })
      : null;
    if (!row) throw ApiError.notFound(`Order ${orderId} not found`);
    const d = this.deployments.find(row.tier as Tier, row.network);
    if (!d || d.network === 'mainnet' || NETWORKS[d.network].tier !== 'test') {
      throw ApiError.forbidden(
        'Transfers are simulated only on the test networks (local, testnet).',
      );
    }
    if (!row.onchainId) {
      throw ApiError.badRequest(
        ErrorCode.InvalidState,
        'The order is not open on-chain yet: wait for the indexer.',
      );
    }
    const kind = row.kind as P2pOrderKind;
    const merchant = this.keyOf(row.merchantAddress);
    const id = BigInt(row.onchainId);
    const steps: SimulatedTransfer['steps'] = [];
    if (P2P_MERCHANT_SIDE[kind] === 'seller') {
      if (row.status !== 'awaiting_payment' && row.status !== 'paid') {
        throw ApiError.badRequest(
          ErrorCode.InvalidState,
          `The order is ${row.status}: nothing to release.`,
        );
      }
      steps.push({ action: 'release', hash: await this.send(d, merchant, 'release', id) });
    } else {
      if (row.status === 'awaiting_acceptance') {
        steps.push({ action: 'accept', hash: await this.send(d, merchant, 'accept', id) });
      } else if (row.status !== 'awaiting_payment') {
        throw ApiError.badRequest(
          ErrorCode.InvalidState,
          `The order is ${row.status}: nothing to pay.`,
        );
      }
      steps.push({ action: 'mark_paid', hash: await this.send(d, merchant, 'mark_paid', id) });
    }
    return { orderId: row.id, kind: row.kind, steps };
  }

  private keyOf(address: string): Keypair {
    const secret = this.config.dev.walletSecrets.find(
      (k) => Keypair.fromSecret(k).publicKey() === address,
    );
    if (!secret) {
      throw ApiError.badRequest(
        ErrorCode.InvalidState,
        `No dev key for the merchant ${address}: add it to DEV_WALLET_SECRETS.`,
      );
    }
    return Keypair.fromSecret(secret);
  }

  private async send(
    d: Deployment,
    key: Keypair,
    action: P2pOrderAction,
    id: bigint,
  ): Promise<string> {
    const built = await this.builder.invoke(
      d,
      key.publicKey(),
      p2pCall.orderAction(d.contract, action, key.publicKey(), id),
      action,
      `dev ${action}`,
    );
    const tx = TransactionBuilder.fromXDR(built.xdr, d.passphrase) as Transaction;
    tx.sign(key);
    return this.builder.sendAndWait(d, tx, DEV_TX_WAIT_MS);
  }
}
