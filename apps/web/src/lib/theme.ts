/* The colour theme: the system's unless the person picked one (saved for next time). The choice
   is a `data-theme` attribute on <html>, set before first paint by index.html. */
import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'pier.theme';

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

const systemDark = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(read);
  const [dark, setDark] = useState(() => (choice === 'system' ? systemDark() : choice === 'dark'));
  useEffect(() => {
    const root = document.documentElement;
    if (choice === 'system') delete root.dataset.theme;
    else root.dataset.theme = choice;
    try {
      if (choice === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      /* the choice lasts for this page */
    }
    const update = () => setDark(choice === 'system' ? systemDark() : choice === 'dark');
    update();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [choice]);
  /** Flip to the other theme than the one showing. */
  const toggle = useCallback(() => setChoice(dark ? 'light' : 'dark'), [dark]);
  return { choice, dark, setChoice, toggle };
}
