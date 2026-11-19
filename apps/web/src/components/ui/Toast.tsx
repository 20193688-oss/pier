/* Short confirmations after an action ("Offer saved"), read out politely and gone after a few
   seconds. Errors stay next to what failed instead of here. */
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';

type Toast = { id: number; text: string };
const Ctx = createContext<(text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x.slice(-2), { id, text }]);
    setTimeout(() => setToasts((x) => x.filter((t) => t.id !== id)), 3200);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-center gap-2 rounded-[14px] bg-ink px-4 py-3 text-on-ink shadow-[0_8px_24px_rgb(8_18_15/0.25)]"
          >
            <Icon name="check" size={18} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
