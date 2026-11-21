/* Short messages after an action: a confirmation ("Offer saved"), a note ("The price was updated")
   or an error. Every error a screen shows also comes up here (Notice raises it), so a failure is
   seen wherever the person is looking; the screen keeps its own line next to what failed.

   - On a phone they sit at the top, clear of the bottom bar; from tablets up, at the bottom.
   - They live in the browser's top layer (a manual popover), so they show above an open dialog.
   - The same message is not repeated while it is on screen, nor within a few seconds after.
   - Tapping one dismisses it. An error stays longer than a confirmation.
   - A screen that replaces the one that failed can clear its errors (`useClearErrors`): the
     sign-in after a session ended does. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';

export type ToastTone = 'ok' | 'info' | 'error';
type Toast = { id: number; text: string; tone: ToastTone; silent: boolean };
type Push = (text: string, tone?: ToastTone, opts?: { silent?: boolean }) => void;

const Ctx = createContext<Push>(() => {});
const ClearCtx = createContext<() => void>(() => {});

const LIFE: Record<ToastTone, number> = { ok: 3200, info: 4800, error: 6500 };
const ICON: Record<ToastTone, IconName> = { ok: 'check', info: 'info', error: 'alert' };
const LOOK: Record<ToastTone, string> = {
  ok: 'bg-ink text-on-ink',
  info: 'bg-ink text-on-ink',
  error: 'bg-bad text-white',
};
/** A message shown this recently is not shown again. */
const REPEAT_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const recent = useRef(new Map<string, number>());
  const layer = useRef<HTMLDivElement>(null);

  const drop = useCallback((id: number) => setToasts((x) => x.filter((t) => t.id !== id)), []);
  const push = useCallback<Push>(
    (text, tone = 'ok', opts = {}) => {
      const key = `${tone}:${text}`;
      const now = Date.now();
      const last = recent.current.get(key);
      if (!text || (last !== undefined && now - last < REPEAT_MS)) return;
      recent.current.set(key, now);
      const id = now + Math.random();
      setToasts((x) => [
        ...x.filter((t) => `${t.tone}:${t.text}` !== key).slice(-2),
        { id, text, tone, silent: !!opts.silent },
      ]);
      setTimeout(() => drop(id), LIFE[tone]);
    },
    [drop],
  );

  const clearErrors = useCallback(() => setToasts((x) => x.filter((t) => t.tone !== 'error')), []);

  // Shown again on every new toast, so it sits above a dialog opened after it.
  useEffect(() => {
    const el = layer.current as
      (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!el?.showPopover) return;
    try {
      if (el.matches(':popover-open')) el.hidePopover?.();
      if (toasts.length) el.showPopover();
    } catch {
      /* an older browser: the fixed layer below still shows them */
    }
  }, [toasts]);

  return (
    <Ctx.Provider value={push}>
      <ClearCtx.Provider value={clearErrors}>{children}</ClearCtx.Provider>
      <div
        ref={layer}
        // A manual popover lives in the top layer, above modal dialogs; without the API it is a
        // fixed layer like any other.
        {...{ popover: 'manual' }}
        aria-live="polite"
        className="toast-layer pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+12px)] bottom-auto z-[60] m-0 flex w-full max-w-none flex-col items-center gap-2 overflow-visible border-0 bg-transparent p-0 px-4 md:top-auto md:bottom-6"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast pointer-events-auto flex max-w-[min(32rem,100%)] cursor-pointer items-start gap-2.5 rounded-[14px] px-4 py-3 text-[0.9375rem] shadow-[0_10px_30px_rgb(8_18_15/0.28)] ${LOOK[t.tone]}`}
            onClick={() => drop(t.id)}
            // An error a screen already announces (its Notice) is not read twice.
            {...(t.silent
              ? { 'aria-hidden': true }
              : { role: t.tone === 'error' ? 'alert' : 'status' })}
          >
            <Icon name={ICON[t.tone]} size={18} className="mt-0.5 shrink-0" />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
/** A toast once, when `when` turns true (a state a screen opens in: the session ended), instead
    of a line on the screen. */
export function useToastWhen(when: boolean, text: string, tone: ToastTone = 'info') {
  const push = useContext(Ctx);
  useEffect(() => {
    if (when) push(text, tone);
  }, [when, text, tone, push]);
}

/** Takes the error toasts off the screen (they belong to a screen that is gone). */
export const useClearErrors = () => useContext(ClearCtx);
