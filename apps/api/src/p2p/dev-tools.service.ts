import { Inject, Injectable } from '@nestjs/common';
import type { Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { ChainClient } from '@/chain/chain-client.service';
import { DeploymentsService, type Deployment } from '@/chain/deployments.service';
import { p2pCalldata, type P2pOrderAction } from '@/chain/market-codec';
import { DEV_CHAIN_ID, type Tier } from '@/chain/networks';
import { ApiError, ErrorCode } from '@/common/api-error';
import { sameAddress } from '@/common/evm';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { isUuid } from '@/p2p/domain/order-ref';
import { P2P_MERCHANT_SIDE, type P2pOrderKind } from '@/p2p/domain/order-status';
import { P2P_ORDER_SELECT } from '@/p2p/views';
import { PrismaService } from '@/prisma/prisma.service';

/** Receipt polls before a dev transaction is reported as not mined. */
const RECEIPT_POLLS = 50;

export interface SimulatedTransfer {
  orderId: string;
  kind: string;
  /** What the dev merchant did, in order, with each transaction's hash. */
  steps: { action: string; hash: string }[];
}

/**
 * Development only (`DEV_TOOLS=true`, never in production): plays the
 * merchant's bot on the local dev chain so a whole order can be clicked
 * through without a bank. "A bank transfer arrived" means:
 *
 *   - a purchase or charge (the merchant sells): the merchant releases;
 *   - a sale or payout (the merchant buys): the merchant accepts if needed
 *     and marks the order paid (it "sent" the local money).
 *
 * It signs with the merchant's dev key (`DEV_WALLET_KEYS`), and refuses any
 * order whose network is not the dev chain (chain id 31337, checked against
 * the node itself). The indexer moves the order afterwards, as for real.
 */
@Injectable()
export class DevToolsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly chain: ChainClient,
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
    if (!d || d.chainId !== DEV_CHAIN_ID) {
      throw ApiError.forbidden(
        'Transfers are simulated only on the local dev chain (chain id 31337).',
      );
    }
    // The client refuses a node that does not answer 31337.
    await this.chain.client(d);
    if (!row.onchainId) {
      throw ApiError.badRequest(
        ErrorCode.InvalidState,
        'The order is not open on-chain yet: wait for the indexer.',
      );
    }
    const kind = row.kind as P2pOrderKind;
    const merchantKey = this.keyOf(row.merchantAddress);
    const id = BigInt(row.onchainId);
    const steps: SimulatedTransfer['steps'] = [];
    if (P2P_MERCHANT_SIDE[kind] === 'seller') {
      if (row.status !== 'awaiting_payment' && row.status !== 'paid') {
        throw ApiError.badRequest(
          ErrorCode.InvalidState,
          `The order is ${row.status}: nothing to release.`,
        );
      }
      steps.push({ action: 'release', hash: await this.send(d, merchantKey, 'release', id) });
    } else {
      if (row.status === 'awaiting_acceptance') {
        steps.push({ action: 'accept', hash: await this.send(d, merchantKey, 'accept', id) });
      } else if (row.status !== 'awaiting_payment') {
        throw ApiError.badRequest(
          ErrorCode.InvalidState,
          `The order is ${row.status}: nothing to pay.`,
        );
      }
      steps.push({ action: 'markPaid', hash: await this.send(d, merchantKey, 'markPaid', id) });
    }
    return { orderId: row.id, kind: row.kind, steps };
  }

  private keyOf(address: string): Hex {
    const key = this.config.dev.walletKeys.find((k) =>
      sameAddress(privateKeyToAddress(k), address),
    );
    if (!key) {
      throw ApiError.badRequest(
        ErrorCode.InvalidState,
        `No dev key for the merchant ${address}: add it to DEV_WALLET_KEYS.`,
      );
    }
    return key;
  }

  private async send(d: Deployment, key: Hex, action: P2pOrderAction, id: bigint): Promise<Hex> {
    const from = privateKeyToAddress(key);
    const data = p2pCalldata.orderAction(action, id);
    const [gas, fees, nonce] = await Promise.all([
      this.chain.estimateGas(d, { from, to: d.contract, data }),
      this.chain.feeData(d),
      this.chain.pendingNonce(d, from),
    ]);
    const signed = await this.chain.sign(key, {
      chainId: d.chainId,
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      gas: (gas * 13n) / 10n,
      to: d.contract,
      data,
    });
    await this.chain.sendRawTransaction(d, signed.raw);
    for (let i = 0; i < RECEIPT_POLLS; i++) {
      const receipt = await this.chain.receipt(d, signed.hash);
      if (receipt) {
        if (!receipt.succeeded) {
          throw ApiError.badRequest(
            ErrorCode.InvalidState,
            `The dev ${action} reverted (${signed.hash}).`,
          );
        }
        return signed.hash;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return signed.hash;
  }
}
