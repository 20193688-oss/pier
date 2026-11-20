/* Pollar's email login codes: exactly six characters. A code copied from an email can carry
   spaces, dashes or invisible characters (a zero-width space, a full-width digit), which Pollar
   answers with a validation error before it even checks the code; only letters and digits are
   kept, after Unicode compatibility normalisation. Pure; tests/unit/wallet.test.ts. */

export const EMAIL_CODE_LENGTH = 6;

export function emailCode(input: string): string {
  return input.normalize('NFKC').replace(/[^0-9A-Za-z]/g, '');
}
