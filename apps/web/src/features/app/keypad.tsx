/* The app's keypad: how an amount is typed on the home and when asking for an amount. The typed
   text keeps a dot for the decimal mark ("12.5") and shows the language's ("12,5"); the
   physical keyboard types too (digits, "." or ",", Backspace, Escape to clear), unless a field
   or a dialog has the focus. */
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'];

/** The language's decimal mark (",", "."). */
export const decimalMark = (lang: string) =>
  new Intl.NumberFormat(lang).format(1.5).replace(/\d/g, '') || '.';

/** Typed text as people read it: the whole part grouped, the language's decimal mark. */
export function shownAmount(lang: string, typed: string): string {
  const [whole, frac] = typed.split('.');
  const grouped = new Intl.NumberFormat(lang, {
    maximumFractionDigits: 0,
    useGrouping: 'always',
  } as Intl.NumberFormatOptions).format(Number(whole || '0'));
  return frac === undefined ? grouped : `${grouped}${decimalMark(lang)}${frac}`;
}

/** The text of a typed amount without a trailing decimal mark ("12." is "12"), "" for zero. */
export const typedValue = (typed: string) =>
  typed && Number(typed) > 0 ? typed.replace(/\.$/, '') : '';

/** An amount typed on the keypad: up to `maxWhole` digits and `maxDecimals` decimals. */
export function useKeypad({
  initial = '',
  maxDecimals = 2,
  maxWhole = 9,
}: { initial?: string; maxDecimals?: number; maxWhole?: number } = {}) {
  const [typed, setTyped] = useState(initial);
  const press = useCallback(
    (key: string) => {
      setTyped((v) => {
        if (key === 'del') return v.slice(0, -1);
        if (key === '.') return maxDecimals === 0 || v.includes('.') ? v : `${v || '0'}.`;
        const [whole, frac] = v.split('.');
        if (frac !== undefined) return frac.length >= maxDecimals ? v : v + key;
        if (whole.length >= maxWhole) return v;
        return whole === '0' ? key : v + key;
      });
    },
    [maxDecimals, maxWhole],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (document.querySelector('dialog[open]')) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === '.' || e.key === ',') press('.');
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Escape') setTyped('');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  return { typed, setTyped, press };
}

/** The keys: 1 to 9, the decimal mark, 0 and delete. */
export function Keypad({
  onPress,
  decimals = true,
  className = '',
}: {
  onPress: (key: string) => void;
  /* False for a currency with no decimals: the decimal key does nothing. */
  decimals?: boolean;
  className?: string;
}) {
  const { t, lang } = useI18n();
  const h = t.app.home;
  return (
    <div className={`grid grid-cols-3 gap-1 ${className}`} role="group" aria-label={h.keypad}>
      {KEYS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onPress(k)}
          disabled={k === '.' && !decimals}
          aria-label={k === 'del' ? h.erase : k === '.' ? h.decimal : undefined}
          className="grid h-[58px] place-items-center rounded-[18px] text-[1.625rem] font-medium transition-[background-color,transform] duration-150 select-none hover:bg-well active:scale-95 active:bg-well disabled:opacity-30 disabled:hover:bg-transparent"
        >
          {k === 'del' ? <Icon name="back" size={24} /> : k === '.' ? decimalMark(lang) : k}
        </button>
      ))}
    </div>
  );
}
