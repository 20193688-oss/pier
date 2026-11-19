/* EIP-6963: every EVM wallet installed in the browser announces itself (name, icon, provider), so
   the page can list them all instead of guessing at `window.ethereum`. A browser with an older
   wallet that only injects `window.ethereum` still gets it, as one unnamed entry.

   No WalletConnect, no project id: only wallets in this browser. */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface WalletInfo {
  uuid: string;
  name: string;
  /* A data URI image (anything else is dropped: the page never loads a wallet's remote icon). */
  icon: string | null;
  rdns: string;
}

export interface DiscoveredWallet {
  info: WalletInfo;
  provider: Eip1193Provider;
}

interface AnnounceDetail {
  info?: Partial<WalletInfo>;
  provider?: Eip1193Provider;
}

const SAFE_ICON =
  /^data:image\/(png|svg\+xml|webp|jpeg|gif);base64,[A-Za-z0-9+/=]+$|^data:image\/svg\+xml,[^"]+$/;

/** A wallet's announcement, checked (a name, a provider with `request`, a data-URI icon at most). */
export function readAnnouncement(detail: unknown): DiscoveredWallet | null {
  const d = detail as AnnounceDetail | null;
  if (!d || typeof d !== 'object' || !d.provider || typeof d.provider.request !== 'function')
    return null;
  const info = d.info ?? {};
  const name = typeof info.name === 'string' ? info.name.trim().slice(0, 40) : '';
  const uuid = typeof info.uuid === 'string' ? info.uuid : '';
  if (!name || !uuid) return null;
  const icon =
    typeof info.icon === 'string' && info.icon.length < 200_000 && SAFE_ICON.test(info.icon)
      ? info.icon
      : null;
  return {
    info: { uuid, name, icon, rdns: typeof info.rdns === 'string' ? info.rdns : '' },
    provider: d.provider,
  };
}

/** Listen for wallets (those already there answer the request at once); `onChange` gets the whole
    list each time one more announces itself. Returns the unsubscribe. */
export function watchWallets(onChange: (wallets: DiscoveredWallet[]) => void): () => void {
  const found = new Map<string, DiscoveredWallet>();
  const emit = () => onChange([...found.values()]);
  const onAnnounce = (e: Event) => {
    const w = readAnnouncement((e as CustomEvent).detail);
    if (!w || found.has(w.info.uuid)) return;
    found.set(w.info.uuid, w);
    emit();
  };
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  // An older wallet that only injects window.ethereum, when nothing announced itself.
  const legacy = setTimeout(() => {
    const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
    if (!found.size && eth && typeof eth.request === 'function') {
      found.set('legacy', {
        info: { uuid: 'legacy', name: '', icon: null, rdns: '' },
        provider: eth,
      });
      emit();
    }
  }, 600);
  return () => {
    clearTimeout(legacy);
    window.removeEventListener('eip6963:announceProvider', onAnnounce);
  };
}
