import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { getAddress, verifyMessage, type Hex } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import {
  newSecret,
  SESSION_TOKEN_PREFIX,
  sha256Hex,
  type SessionPrincipal,
} from '@/auth/auth.types';
import { ApiError, ErrorCode } from '@/common/api-error';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { PrismaService } from '@/prisma/prisma.service';

/** Clock skew a SIWE `issuedAt` may have. */
const ISSUED_AT_SKEW_MS = 5 * 60 * 1000;
/** A session's `lastUsedAt` is written at most this often. */
const TOUCH_EVERY_MS = 60 * 1000;

/**
 * Sign-in with Ethereum (EIP-4361): a single-use nonce from the API, a
 * message the wallet signs naming this service's domain and that nonce, and
 * a session whose token is shown once (cookie and body) and stored only as
 * its SHA-256. Externally owned accounts only: a smart-contract wallet's
 * EIP-1271 signature is not accepted yet.
 */
@Injectable()
export class SessionsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async issueNonce(): Promise<{ nonce: string; expiresAt: Date; domain: string }> {
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + this.config.siwe.nonceTtlSeconds * 1000);
    await this.prisma.siweNonce.create({ data: { nonce, expiresAt } });
    return { nonce, expiresAt, domain: this.config.siwe.domain };
  }

  /** Verifies a signed SIWE message and opens a session; the token is returned once. */
  async signIn(
    message: string,
    signature: string,
  ): Promise<{ token: string; address: string; expiresAt: Date }> {
    const parsed = parseSiweMessage(message);
    const now = new Date();
    const problems: string[] = [];
    if (!parsed.address) problems.push('the message names no address');
    if (parsed.domain !== this.config.siwe.domain) {
      problems.push(`the message must be for ${this.config.siwe.domain}`);
    }
    if (parsed.version !== '1') problems.push('the message must be SIWE version 1');
    if (!parsed.nonce) problems.push('the message carries no nonce');
    if (!parsed.uri) {
      problems.push('the message names no URI');
    } else {
      try {
        if (new URL(parsed.uri).host !== this.config.siwe.domain) {
          problems.push(`the message URI must be on ${this.config.siwe.domain}`);
        }
      } catch {
        problems.push('the message URI is not a URL');
      }
    }
    if (!parsed.issuedAt || parsed.issuedAt.getTime() > now.getTime() + ISSUED_AT_SKEW_MS) {
      problems.push('the message must carry an issuedAt that is not in the future');
    }
    if (parsed.expirationTime && parsed.expirationTime <= now) problems.push('the message expired');
    if (parsed.notBefore && parsed.notBefore > now) problems.push('the message is not valid yet');
    if (problems.length > 0) {
      throw ApiError.badRequest(
        ErrorCode.ChallengeInvalid,
        'This sign-in message is not valid.',
        problems,
      );
    }
    const address = getAddress(parsed.address as string);
    const valid = await verifyMessage({ address, message, signature: signature as Hex }).catch(
      () => false,
    );
    if (!valid) {
      throw ApiError.badRequest(
        ErrorCode.SignatureInvalid,
        'The signature does not verify against this wallet for this message.',
      );
    }
    // Spent only after the signature verified, so nobody burns another's nonce.
    const spent = await this.prisma.siweNonce.updateMany({
      where: { nonce: parsed.nonce as string, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (spent.count !== 1) {
      throw ApiError.badRequest(
        ErrorCode.ChallengeInvalid,
        'This nonce is unknown, already used or expired: ask for a new one.',
      );
    }
    const token = newSecret(SESSION_TOKEN_PREFIX);
    const expiresAt = new Date(now.getTime() + this.config.siwe.sessionTtlSeconds * 1000);
    await this.prisma.session.create({
      data: { tokenHash: sha256Hex(token), address, expiresAt },
    });
    return { token, address, expiresAt };
  }

  /** The live session a token opens, or null. */
  async resolve(token: string): Promise<Omit<SessionPrincipal, 'isAdmin' | 'viaCookie'> | null> {
    if (!token.startsWith(SESSION_TOKEN_PREFIX)) return null;
    const row = await this.prisma.session.findUnique({ where: { tokenHash: sha256Hex(token) } });
    const now = Date.now();
    if (!row || row.revokedAt || row.expiresAt.getTime() <= now) return null;
    if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
      await this.prisma.session.updateMany({
        where: { id: row.id },
        data: { lastUsedAt: new Date(now) },
      });
    }
    return { sessionId: row.id, address: row.address, expiresAt: row.expiresAt };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
