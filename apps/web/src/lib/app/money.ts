/* Dollars as the payments app shows them: USDC base units (7 decimals) to a dollar amount a person
   reads ("US$ 248,35" in Spanish, "$248.35" in English), what they type back to base units, and
   the local-money equivalent at a price. No floating point on the way to base units. Pure;
   tests/unit/app-money.test.ts. */
import { fromBaseUnits, parseDecimal, toBaseUnits } from '@/lib/p2p/amounts';
import { STELLAR_DECIMALS } from '@/lib/stellar/network';
import { fiatDecimals } from '@/lib/p2p/rails';

export const USDC_DECIMALS = STELLAR_DECIMALS;

/** A dollar figure: two decimals, rounded down so a balance is never shown bigger than it is. */
export function usdNumber(lang: string, units: string | bigint): string {
  const s = String(units);
  if (!/^\d+$/.test(s)) return s;
  const cents = BigInt(s) / 10n ** BigInt(USDC_DECIMALS - 2);
  const whole = cents / 100n;
  const frac = Number(cents % 100n);
  // Grouped from four digits up in every language ("US$ 5.000,00", "$5,000.00"); Spanish's
  // default would leave 5000 ungrouped.
  const grouped = new Intl.NumberFormat(lang, {
    maximumFractionDigits: 0,
    useGrouping: 'always',
  } as Intl.NumberFormatOptions).format(whole);
  const sep = new Intl.NumberFormat(lang).format(1.5).replace(/\d/g, '') || '.';
  return `${grouped}${sep}${String(frac).padStart(2, '0')}`;
}

/** "US$ 248,35" (es) or "$248.35" (en), from a template with `{amount}`. */
export function usd(lang: string, units: string | bigint, template: string): string {
  return template.replace('{amount}', usdNumber(lang, units));
}

/** What a person typed in dollars (up to 2 decimals, above zero) as base units, else null. */
export function dollarsToUnits(typed: string): string | null {
  const v = parseDecimal(typed, 2);
  if (v === null || !(Number(v) > 0)) return null;
  return toBaseUnits(v, USDC_DECIMALS);
}

/** Base units as a plain decimal ("12.5"), for links and SEP-7 requests. */
export const unitsToDecimal = (units: string) => fromBaseUnits(units, USDC_DECIMALS);

/** The local-money value of `units` at `price` (local money per USDC), as a decimal string with
    the currency's decimals. */
export function localValue(units: string, price: number, currency: string): string | null {
  if (!/^\d+$/.test(units) || !(price > 0)) return null;
  const n = (Number(BigInt(units)) / 10 ** USDC_DECIMALS) * price;
  return n.toFixed(fiatDecimals(currency));
}
