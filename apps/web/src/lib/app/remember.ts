/* What this device remembers to fill forms in again, so a person types things once: the payer
   (name and document) per currency, the payout account per rail, and the email last used to sign
   in (which also suggests an @handle). Kept in localStorage under `midpoint.fill.*` and cleared on
   sign-out (src/lib/session.tsx). Unreadable or malformed entries count as nothing remembered.
   Pure apart from storage; tests/unit/remember.test.ts. */
import { normalizeHandle } from '@midpoint/payment-qr';

const PREFIX = 'midpoint.fill.';

export function remember(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* nothing remembered */
  }
}

export function recall<T>(key: string, check: (v: unknown) => v is T): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw);
    return check(v) ? v : null;
  } catch {
    return null;
  }
}

/** Everything this device remembered (on sign-out). */
export function forgetFilled(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* nothing to forget */
  }
}

const isString = (v: unknown): v is string => typeof v === 'string';

export interface Payer {
  name: string;
  document: string;
}
export const isPayer = (v: unknown): v is Payer =>
  !!v && typeof v === 'object' && isString((v as Payer).name) && isString((v as Payer).document);

export interface Account {
  holderName: string;
  document: string;
  details: Record<string, string>;
}
export const isAccount = (v: unknown): v is Account =>
  !!v &&
  typeof v === 'object' &&
  isString((v as Account).holderName) &&
  isString((v as Account).document) &&
  !!(v as Account).details &&
  typeof (v as Account).details === 'object' &&
  Object.values((v as Account).details).every(isString);

export const rememberEmail = (email: string) => remember('email', email.trim());
export const recallEmail = () => recall('email', isString);

/** An @handle to offer from an email: its local part in the handle's alphabet (lowercase letters,
    digits, underscore; accents dropped, dots and dashes as underscores), or '' when nothing
    valid is left. */
export function suggestHandle(email: string | null | undefined): string {
  const local = (email ?? '').split('@')[0] ?? '';
  const candidate = local
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.\-+ ]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20)
    .replace(/_+$/, '');
  return normalizeHandle(candidate) ?? '';
}
