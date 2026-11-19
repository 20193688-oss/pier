import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '@/config/config.module';
import { keyId, type AppConfig } from '@/config/env';

/** What a sealed value is: the field it fills. */
export type SealedField =
  | 'payment-method.details'
  | 'payment-method.holder'
  | 'order.payer'
  | 'order.beneficiary'
  | 'webhook-endpoint.secret';

const VERSION = 'v1';
const IV_BYTES = 12;

/**
 * Encryption at rest for personal data (payment methods, payers,
 * beneficiaries) and webhook signing secrets: AES-256-GCM with a fresh IV per
 * write, under `DATA_ENCRYPTION_KEY`, with the field and the row's id as
 * associated data, so a value copied to another row or field no longer opens.
 * Stored as `v1:<keyId>:<iv>:<ciphertext>:<tag>` (base64url parts).
 */
@Injectable()
export class DataCipher {
  private readonly key: Buffer;
  private readonly id: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = config.dataEncryptionKey;
    this.id = keyId(this.key);
  }

  seal(field: SealedField, rowId: string, value: unknown): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${field}:${rowId}`, 'utf8'));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [
      VERSION,
      this.id,
      iv.toString('base64url'),
      body.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join(':');
  }

  open<T>(field: SealedField, rowId: string, stored: string): T {
    const parts = stored.split(':');
    if (parts.length !== 5 || parts[0] !== VERSION) {
      throw new Error(`${field} of ${rowId} is not a sealed value`);
    }
    const [, id, iv, body, tag] = parts;
    if (id !== this.id) {
      throw new Error(`${field} of ${rowId} was sealed under another key (${id})`);
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`${field}:${rowId}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plain) as T;
  }

  /** A 32-byte subkey for another purpose (HMACs), derived so it never equals the sealing key. */
  derive(label: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.key, Buffer.alloc(0), label, 32));
  }
}
