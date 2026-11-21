/* One action behind a button (send, pay, release, save...). It runs once at a time whatever the
   clicks: the guard is a ref, so a second tap in the same frame is dropped too, before any render.
   `busy` drives the button's spinner and disabled state. With `once`, an action that went through
   stays done: the button stays off until the screen moves on (the server's state changes), so the
   same order is never sent twice. The action says it did NOT go through by returning `false` (it
   showed its own error); throwing counts the same and the error goes on to the caller. */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface Action<A extends unknown[]> {
  run: (...args: A) => Promise<void>;
  busy: boolean;
  /* With `once`: the action went through. */
  done: boolean;
  /* Allow it again (the screen moved on to something new). */
  reset: () => void;
}

export function useAction<A extends unknown[]>(
  fn: (...args: A) => Promise<unknown> | unknown,
  opts: { once?: boolean } = {},
): Action<A> {
  const running = useRef(false);
  const doneRef = useRef(false);
  const latest = useRef(fn);
  const once = !!opts.once;
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    latest.current = fn;
  });

  const run = useCallback(
    async (...args: A) => {
      if (running.current || doneRef.current) return;
      running.current = true;
      setBusy(true);
      try {
        const ok = await latest.current(...args);
        if (once && ok !== false) {
          doneRef.current = true;
          setDone(true);
        }
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [once],
  );
  const reset = useCallback(() => {
    doneRef.current = false;
    setDone(false);
  }, []);
  return { run, busy, done, reset };
}

/** A guard for a handler that keeps its own busy state: drops a call while one is running. */
export function useGuard() {
  const running = useRef(false);
  return useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    try {
      return await fn();
    } finally {
      running.current = false;
    }
  }, []);
}
