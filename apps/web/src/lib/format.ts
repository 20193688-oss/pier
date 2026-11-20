/* Numbers, money, addresses and times as a person reads them, in their language. Pure;
   tests/unit/format.test.ts. */
import { fiatDecimals } from '@/lib/p2p/rails';
import { fmt } from '@/i18n/format';

export const NBSP = ' ';

/** Local money with its currency's decimals ("85.000,00 ARS" in Spanish). */
export function money(lang: string, value: string | number, currency: string): string {
  return `${amountOnly(lang, value, currency)}${NBSP}${currency}`;
}

/** The number alone: local money with its currency's decimals when `currency` is given, else a
    token amount (two decimals from 1 up, up to six below). */
export function amountOnly(lang: string, value: string | number, currency?: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (currency) {
    const d = fiatDecimals(currency);
    return new Intl.NumberFormat(lang, {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    }).format(n);
  }
  return new Intl.NumberFormat(lang, { maximumFractionDigits: Math.abs(n) >= 1 ? 2 : 6 }).format(n);
}

/** A token amount with its symbol ("59,42 USDC"). */
export function units(lang: string, value: string | number, symbol: string): string {
  return `${amountOnly(lang, value)}${NBSP}${symbol}`;
}

/** An exchange rate: two decimals from 100 up, four below ("1.488,50"). */
export function rate(lang: string, value: string | number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return new Intl.NumberFormat(lang, { maximumFractionDigits: n >= 100 ? 2 : 4 }).format(n);
}

/** The amount a person types into a bank app: digits and a point, no grouping ("150000.00"). */
export function plainAmount(value: string | number, currency: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(fiatDecimals(currency)) : String(value);
}

/** A currency's name in the reader's language ("Peso argentino"), else its code. */
export function currencyName(code: string, lang: string): string {
  try {
    const name = new Intl.DisplayNames([lang], { type: 'currency' }).of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(lang) + name.slice(1);
  } catch {
    /* an engine without display names: the code */
  }
  return code;
}

/** 0x1234…abcd */
export const shortAddress = (a: string) =>
  a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

/** A date and time ("19 nov 2026, 14:05"). */
export function dateTime(lang: string, iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A date alone ("19 nov 2026"). */
export function dateOnly(lang: string, iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(lang, { dateStyle: 'medium' });
}

/** A time of day alone ("14:05"). */
export function timeOnly(lang: string, iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(lang, { timeStyle: 'short' });
}

/** The day something happened, as a list heading: "Hoy" / "Today", "Ayer" / "Yesterday" (the
    words come from Intl), else the date ("18 de noviembre"), with the year when it is not this
    year's. Days are the reader's local days. Empty for a missing or broken date. */
export function dayLabel(lang: string, iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(d) - start(now)) / 86_400_000);
  if (days === 0 || days === -1) {
    const word = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(days, 'day');
    return word.charAt(0).toLocaleUpperCase(lang) + word.slice(1);
  }
  return d.toLocaleDateString(lang, {
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Items in their order, cut into runs that share a day heading (dayLabel). */
export function groupByDay<T>(
  items: readonly T[],
  dateOf: (item: T) => string | null | undefined,
  lang: string,
  now = new Date(),
): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dayLabel(lang, dateOf(item), now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

export interface TimeWords {
  seconds: string;
  minutes: string;
  hours: string;
  days: string;
}

/** A duration in its largest whole unit ("3 min", "2 h"). */
export function duration(seconds: number, words: TimeWords): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return fmt(words.seconds, { n: s });
  if (s < 3600) return fmt(words.minutes, { n: Math.round(s / 60) });
  if (s < 86400) return fmt(words.hours, { n: Math.round(s / 3600) });
  return fmt(words.days, { n: Math.round(s / 86400) });
}

/** How long ago `iso` was ("hace 3 min"), or "just now" under a minute. */
export function ago(
  iso: string | null | undefined,
  words: TimeWords & { justNow: string; ago: string },
  now = Date.now(),
): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = (now - t) / 1000;
  return s < 60 ? words.justNow : fmt(words.ago, { time: duration(s, words) });
}

/** A rate as a percent ("99,2 %" in Spanish). */
export function percent(lang: string, value: number): string {
  return new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}
