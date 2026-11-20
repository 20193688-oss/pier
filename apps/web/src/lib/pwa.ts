/* The installable app: the install prompt (Android's `beforeinstallprompt`, held until the person
   asks; an iOS hint where Safari has no prompt), the service worker (/sw.js, production builds
   only: it caches the app shell and hashed assets and never /v1) and its update prompt, and the
   connection state. */
import { useSyncExternalStore } from 'react';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface PwaState {
  canInstall: boolean;
  installed: boolean;
  /* iOS Safari, not yet on the home screen: it has no prompt, only "Add to Home Screen". */
  iosHint: boolean;
  updateReady: boolean;
  online: boolean;
}

let deferred: InstallPromptEvent | null = null;
let waiting: ServiceWorker | null = null;
const listeners = new Set<() => void>();

const standalone = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true);
const isIos = () =>
  typeof navigator !== 'undefined' &&
  /iphone|ipad|ipod/i.test(navigator.userAgent) &&
  !/crios|fxios|edgios/i.test(navigator.userAgent);

let state: PwaState = {
  canInstall: false,
  installed: false,
  iosHint: false,
  updateReady: false,
  online: true,
};

function set(next: Partial<PwaState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

let started = false;

/** Listen for the install prompt, the connection and (production builds) the service worker. */
export function initPwa() {
  if (started || typeof window === 'undefined') return;
  started = true;
  set({
    installed: standalone(),
    iosHint: isIos() && !standalone(),
    online: navigator.onLine !== false,
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    set({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    set({ canInstall: false, installed: true, iosHint: false });
  });
  window.addEventListener('online', () => set({ online: true }));
  window.addEventListener('offline', () => set({ online: false }));
  if (import.meta.env.PROD && 'serviceWorker' in navigator) void registerWorker();
}

async function registerWorker() {
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const watch = (w: ServiceWorker | null) => {
      if (!w) return;
      w.addEventListener('statechange', () => {
        // A new worker installed while an old one controls the page: offer the update.
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          waiting = w;
          set({ updateReady: true });
        }
      });
    };
    if (reg.waiting && navigator.serviceWorker.controller) {
      waiting = reg.waiting;
      set({ updateReady: true });
    }
    watch(reg.installing);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  } catch {
    /* no worker: the app works online only */
  }
}

/** Show the browser's install prompt (Android, desktop Chrome/Edge). */
export async function install(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  set({ canInstall: false });
  return outcome === 'accepted';
}

/** Switch to the waiting version (the page reloads when it takes over). */
export function applyUpdate() {
  waiting?.postMessage({ type: 'SKIP_WAITING' });
}

export function usePwa(): PwaState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => state,
    () => state,
  );
}
