import { Inject, Injectable } from '@nestjs/common';
import {
  newSecret,
  SESSION_TOKEN_PREFIX,
  sha256Hex,
  type SessionPrincipal,
} from '@/auth/auth.types';
import { Sep10Service, type ChallengeResponse } from '@/auth/sep10.service';
import { APP_CONFIG } from '@/config/config.module';
import type { AppConfig } from '@/config/env';
import { PrismaService } from '@/prisma/prisma.service';

/** A session's `lastUsedAt` is written at most this often. */
const TOUCH_EVERY_MS = 60 * 1000;

/**
 * Sign-in with SEP-10: a single-use challenge from the API, signed by the
 * account's signers, and a session whose token is shown once (cookie and
 * body) and stored only as its SHA-256.
 */
@Injectable()
export class SessionsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly sep10: Sep10Service,
  ) {}

  challenge(account: string): Promise<ChallengeResponse> {
    return this.sep10.challenge(account, 'session', this.sep10.signInNetwork());
  }

  /** Verifies a signed challenge and opens a session; the token is returned once. */
  async signIn(transaction: string): Promise<{ token: string; address: string; expiresAt: Date }> {
    const address = await this.sep10.verify(transaction, 'session', this.sep10.signInNetwork());
    const token = newSecret(SESSION_TOKEN_PREFIX);
    const expiresAt = new Date(Date.now() + this.config.sep10.sessionTtlSeconds * 1000);
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
