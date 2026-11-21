/* A bank account typed where the Send screen expects a person: an Argentine CBU, CVU or alias, a
   Peruvian CCI, a Mexican CLABE. It means "send to that account in its own currency", a sale whose
   beneficiary is someone else (src/features/app/Trade.tsx, `toOther`). An @handle never looks like
   one (handles have no dots or hyphens, and are not all digits of these lengths); a Stellar address
   neither. Other countries' accounts are picked from the bank-account screen, since a bare number
   does not say which country it is.

   Pure: tests/unit/bank-recipient.test.ts. */
import { checkCbu, checkClabe, type RailId } from '@/lib/p2p/rails';

export type BankRecipientKind = 'cbu' | 'cvu' | 'alias' | 'cci' | 'clabe';

export interface BankRecipient {
  kind: BankRecipientKind;
  currency: string;
  country: string;
  rail: RailId;
  /* The rail's detail it fills in (cbu, alias, cci or clabe), normalized. */
  details: Record<string, string>;
}

const ALIAS_RE = /^[a-z0-9.-]{6,20}$/;

export function bankRecipient(input: string): BankRecipient | null {
  const raw = (input ?? '').trim();
  if (!raw || raw.startsWith('@')) return null;
  const digits = raw.replace(/[\s.-]/g, '');
  if (/^\d+$/.test(digits)) {
    if (digits.length === 22 && checkCbu(digits) === null)
      return {
        kind: digits.startsWith('000') ? 'cvu' : 'cbu',
        currency: 'ARS',
        country: 'AR',
        rail: 'ar_bank_transfer',
        details: { cbu: digits },
      };
    if (digits.length === 20)
      return {
        kind: 'cci',
        currency: 'PEN',
        country: 'PE',
        rail: 'pe_bank_transfer',
        details: { cci: digits },
      };
    if (digits.length === 18 && checkClabe(digits) === null)
      return {
        kind: 'clabe',
        currency: 'MXN',
        country: 'MX',
        rail: 'mx_spei',
        details: { clabe: digits },
      };
    return null;
  }
  // An alias has letters and at least one dot or hyphen (an @handle has neither).
  const alias = raw.toLowerCase();
  if (ALIAS_RE.test(alias) && /[.-]/.test(alias) && /[a-z]/.test(alias))
    return {
      kind: 'alias',
      currency: 'ARS',
      country: 'AR',
      rail: 'ar_bank_transfer',
      details: { alias },
    };
  return null;
}

/** The bank-account send screen, filled in with what was typed. */
export function bankSendPath(r: Pick<BankRecipient, 'currency' | 'rail' | 'details'>): string {
  const q = new URLSearchParams({ currency: r.currency, rail: r.rail, ...r.details });
  return `/app/send/bank?${q.toString()}`;
}

/** The last characters of an account, the rest hidden: "••••9012". */
export const maskAccount = (v: string) => (v.length <= 4 ? v : `••••${v.slice(-4)}`);
