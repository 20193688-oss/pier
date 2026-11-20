import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  Account,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  WebAuth,
  type Transaction,
} from '@stellar/stellar-sdk';
import { ChainClient } from '@/chain/chain-client.service';
import { DeploymentsService, type StellarNetwork } from '@/chain/deployments.service';
import type { NetworkId, Tier } from '@/chain/networks';
import { ApiError, ErrorCode } from '@/common/api-error';
import { isAccountAddress } from '@/common/stellar';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { PrismaService } from '@/prisma/prisma.service';

/** A SEP-10 challenge is valid for five minutes. */
export const SEP10_CHALLENGE_TTL_SECONDS = 300;
/** The manage_data entry that binds a wallet registration to an organization and tier. */
export const ORGANIZATION_ENTRY = 'organization';

export type ChallengePurpose = 'session' | 'account';

/** What a registration challenge binds the wallet to. */
export interface ChallengeBinding {
  organizationId: string;
  tier: Tier;
}

/** The SEP-10 challenge response shape. */
export interface ChallengeResponse {
  transaction: string;
  network_passphrase: string;
  expiresAt: Date;
}

/** `organization` entry value: `<organizationId>:<tier>` (at most 64 bytes). */
export function bindingValue(b: ChallengeBinding): string {
  return `${b.organizationId}:${b.tier}`;
}

/**
 * SEP-10 Stellar Web Authentication, server side. A challenge is a
 * transaction with sequence 0, source = the SEP-10 key, 5-minute time bounds,
 * and the standard operations: `<home domain> auth` (source = the client
 * account, value = a random single-use nonce) and `web_auth_domain`. A wallet
 * registration's challenge also carries an `organization` entry (source = the
 * SEP-10 key) naming the organization and tier it registers under, so a
 * sign-in challenge can never register a wallet and the other way round.
 *
 * Verification follows SEP-10: the server's signature, the time bounds, the
 * home and web-auth domains, the single-use nonce (spent by a compare-and-swap
 * only after the signatures verified), and the client's signatures, which must
 * reach the account's medium threshold when the account exists (its signers
 * are loaded from the ledger), or be the master key's when it does not. The
 * SEP-10 key is never funded: a challenge can never be submitted.
 */
@Injectable()
export class Sep10Service {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly deployments: DeploymentsService,
    private readonly chain: ChainClient,
    private readonly prisma: PrismaService,
  ) {}

  /** The network sign-in challenges are signed for. */
  signInNetwork(): StellarNetwork {
    return this.reachable(this.config.sep10.network);
  }

  private reachable(id: NetworkId): StellarNetwork {
    const n = this.deployments.network(id);
    if (!n) {
      throw ApiError.unavailable(
        'Sign-in is not available right now.',
        `No RPC is configured for ${id}.`,
      );
    }
    return n;
  }

  /** Builds, signs and records a challenge for `account`. */
  async challenge(
    account: string,
    purpose: ChallengePurpose,
    network: StellarNetwork,
    binding?: ChallengeBinding,
  ): Promise<ChallengeResponse> {
    if (!isAccountAddress(account)) {
      throw ApiError.validation(['account must be a Stellar account address (G...)']);
    }
    const server = this.deployments.sep10Key();
    const nonce = randomBytes(48).toString('base64');
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new Date((now + SEP10_CHALLENGE_TTL_SECONDS) * 1000);
    const builder = new TransactionBuilder(new Account(server.publicKey(), '-1'), {
      fee: BASE_FEE,
      networkPassphrase: network.passphrase,
      timebounds: { minTime: now, maxTime: now + SEP10_CHALLENGE_TTL_SECONDS },
    })
      .addOperation(
        Operation.manageData({
          name: `${this.config.sep10.homeDomain} auth`,
          value: nonce,
          source: account,
        }),
      )
      .addOperation(
        Operation.manageData({
          name: 'web_auth_domain',
          value: this.config.sep10.webAuthDomain,
          source: server.publicKey(),
        }),
      );
    if (binding) {
      builder.addOperation(
        Operation.manageData({
          name: ORGANIZATION_ENTRY,
          value: bindingValue(binding),
          source: server.publicKey(),
        }),
      );
    }
    const tx = builder.build();
    tx.sign(server);
    await this.prisma.authChallenge.create({
      data: {
        nonce,
        purpose,
        account,
        network: network.network,
        organizationId: binding?.organizationId ?? null,
        tier: binding?.tier ?? null,
        expiresAt,
      },
    });
    return {
      transaction: tx.toEnvelope().toXDR('base64'),
      network_passphrase: network.passphrase,
      expiresAt,
    };
  }

  /**
   * Verifies a signed challenge and spends its nonce; answers the account it
   * proves. `binding` must be given for (and only for) a registration.
   */
  async verify(
    transaction: string,
    purpose: ChallengePurpose,
    network: StellarNetwork,
    binding?: ChallengeBinding,
  ): Promise<string> {
    const server = this.deployments.sep10Key().publicKey();
    const { homeDomain, webAuthDomain } = this.config.sep10;
    let tx: Transaction;
    let account: string;
    try {
      const read = WebAuth.readChallengeTx(
        transaction,
        server,
        network.passphrase,
        homeDomain,
        webAuthDomain,
      );
      tx = read.tx;
      account = read.clientAccountID;
    } catch (err) {
      throw invalid(err instanceof Error ? err.message : String(err));
    }
    if (!isAccountAddress(account)) throw invalid('the challenge must name a G account');
    if (tx.memo.type !== 'none') throw invalid('the challenge must carry no memo');
    const nonce = manageDataValue(tx, `${homeDomain} auth`);
    const bound = manageDataValue(tx, ORGANIZATION_ENTRY);
    const expectedBound = binding ? bindingValue(binding) : null;
    if (bound !== expectedBound) {
      throw invalid(
        binding
          ? 'the challenge was not issued for this organization and tier'
          : 'a wallet registration challenge cannot sign in',
      );
    }
    if (tx.operations.some((op) => op.type === 'manageData' && op.name === 'client_domain')) {
      throw invalid('client_domain challenges are not supported');
    }

    await this.checkSignatures(transaction, server, network, account);

    // Spent only after the signatures verified, so nobody burns another's nonce.
    const now = new Date();
    const spent = await this.prisma.authChallenge.updateMany({
      where: {
        nonce: nonce ?? '',
        purpose,
        account,
        network: network.network,
        organizationId: binding?.organizationId ?? null,
        tier: binding?.tier ?? null,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    if (spent.count !== 1) {
      throw ApiError.badRequest(
        ErrorCode.ChallengeInvalid,
        'This challenge is unknown, already used or expired: ask for a new one.',
      );
    }
    return account;
  }

  private async checkSignatures(
    transaction: string,
    server: string,
    network: StellarNetwork,
    account: string,
  ): Promise<void> {
    const { homeDomain, webAuthDomain } = this.config.sep10;
    const state = await this.chain.account(network, account);
    try {
      if (state) {
        const signers = [
          ...(state.thresholds.master > 0
            ? [{ key: account, weight: state.thresholds.master }]
            : []),
          ...state.signers.filter((s) => s.key.startsWith('G')),
        ].map((s) => ({ ...s, type: 'ed25519_public_key' }));
        WebAuth.verifyChallengeTxThreshold(
          transaction,
          server,
          network.passphrase,
          Math.max(state.thresholds.medium, 1),
          signers,
          homeDomain,
          webAuthDomain,
        );
      } else {
        const found = WebAuth.verifyChallengeTxSigners(
          transaction,
          server,
          network.passphrase,
          [account],
          homeDomain,
          webAuthDomain,
        );
        if (!found.includes(account)) throw new Error('not signed by the account’s master key');
      }
    } catch (err) {
      throw ApiError.badRequest(
        ErrorCode.SignatureInvalid,
        'The challenge is not signed by this account (its signers must reach its medium threshold).',
        [err instanceof Error ? err.message : String(err)],
      );
    }
  }
}

function invalid(detail: string): ApiError {
  return ApiError.badRequest(ErrorCode.ChallengeInvalid, 'This challenge is not valid.', [detail]);
}

/** The value of a challenge's manage_data entry, as text, or null. */
export function manageDataValue(tx: Transaction, name: string): string | null {
  const op = tx.operations.find((o) => o.type === 'manageData' && o.name === name);
  if (!op || op.type !== 'manageData' || !op.value) return null;
  return Buffer.from(op.value).toString('utf8');
}
