import { Injectable, Logger } from '@nestjs/common';
import type { Hex } from 'viem';
import { ChainClient } from '@/chain/chain-client.service';
import { DeploymentsService, type Deployment } from '@/chain/deployments.service';
import { P2P_MATCHER_GAS_MARGIN_BPS, P2P_MATCHER_NONCE_LOCK_CLASS } from '@/p2p/domain/constants';
import { PrismaService } from '@/prisma/prisma.service';

/** What the matcher sends: an order's opening, or an act for a buyer it opened an order for. */
export type P2pMatcherKind = 'open' | 'markPaid' | 'cancel' | 'dispute';

export interface P2pMatcherSend {
  kind: P2pMatcherKind;
  orderId: string;
  data: Hex;
}

/**
 * The only place the matcher key signs. Every transaction is:
 *
 *   1. simulated (`eth_estimateGas`): a call the contract would revert is a
 *      `ChainCallReverted` before anything is signed, so a refused request costs
 *      no gas and burns no nonce;
 *   2. signed and WRITTEN to `p2p_matcher_tx` under the network's nonce lock,
 *      with the next nonce (the higher of the node's pending count and the last
 *      one recorded), so two replicas never sign the same nonce;
 *   3. broadcast, after the row is committed.
 *
 * Only that row's bytes are ever sent again (`MatcherFollowerJob`): a
 * nonce is signed once, never re-signed with other fees or another call. The
 * matcher holds gas money and the authority sellers granted it; it never holds
 * a seller's or a buyer's tokens.
 */
@Injectable()
export class MatcherService {
  private readonly logger = new Logger(MatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly chain: ChainClient,
  ) {}

  /** Signs, records and broadcasts; answers the transaction hash. */
  async send(d: Deployment, input: P2pMatcherSend): Promise<Hex> {
    const key = this.deployments.matcherKey();
    const from = this.deployments.matcherAddress() as string;
    const [estimate, fees] = await Promise.all([
      this.chain.estimateGas(d, { from, to: d.contract, data: input.data }),
      this.chain.feeData(d),
    ]);
    const gasLimit = (estimate * P2P_MATCHER_GAS_MARGIN_BPS) / 10_000n;

    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${P2P_MATCHER_NONCE_LOCK_CLASS}::int, hashtext(${`${d.tier}:${d.network}`}))`;
        const last = await tx.p2pMatcherTx.findFirst({
          where: { tier: d.tier, network: d.network, fromAddress: from },
          orderBy: { nonce: 'desc' },
          select: { nonce: true },
        });
        const pending = await this.chain.pendingNonce(d, from);
        const recorded = last ? last.nonce + 1n : 0n;
        const nonce = pending > recorded ? pending : recorded;
        const signed = await this.chain.sign(key, {
          chainId: d.chainId,
          nonce,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          gas: gasLimit,
          to: d.contract,
          data: input.data,
        });
        return tx.p2pMatcherTx.create({
          data: {
            tier: d.tier,
            network: d.network,
            fromAddress: from,
            nonce,
            kind: input.kind,
            orderId: input.orderId,
            toAddress: d.contract,
            hash: signed.hash,
            raw: signed.raw,
          },
          select: { id: true, hash: true, raw: true },
        });
      },
      { timeout: this.deployments.timeoutMs() * 3, maxWait: 10_000 },
    );

    try {
      await this.chain.sendRawTransaction(d, row.raw as Hex);
      await this.prisma.p2pMatcherTx.updateMany({
        where: { id: row.id, status: 'signed' },
        data: { status: 'sent', sentAt: new Date() },
      });
    } catch (err) {
      // Recorded and signed: the follower sends these same bytes again. The
      // request is not failed for it, its order simply stays where it is.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `P2P matcher ${input.kind} for order ${input.orderId} on ${d.network}/${d.tier} (${row.hash}) not broadcast yet: ${message}`,
      );
      await this.prisma.p2pMatcherTx.updateMany({
        where: { id: row.id },
        data: { lastError: message.slice(0, 500) },
      });
    }
    return row.hash as Hex;
  }
}
