/* Sign in: the wallets this browser has (EIP-6963), one button each; the chosen one signs the
   sign-in message. Every step says what is happening in the wallet. */
import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Notice, Spinner } from '@/components/ui/controls';
import { Icon } from '@/components/ui/Icon';
import { fmt, useT } from '@/i18n';
import { useSession } from '@/lib/session';
import { MOCK } from '@/lib/env';
import { WalletError } from '@/lib/wallet/actions';
import { ApiError } from '@/lib/api/client';
import type { DiscoveredWallet } from '@/lib/wallet/eip6963';
import type { Session } from '@/lib/api/types';

export function walletName(w: DiscoveredWallet, fallback: string) {
  return w.info.name || fallback;
}

export function WalletList({
  wallets,
  onPick,
  busy,
}: {
  wallets: DiscoveredWallet[];
  onPick: (w: DiscoveredWallet) => void;
  busy?: boolean;
}) {
  const t = useT();
  return (
    <ul className="flex flex-col gap-2" role="list">
      {wallets.map((w) => (
        <li key={w.info.uuid}>
          <button
            type="button"
            disabled={busy}
            onClick={() => onPick(w)}
            className="flex w-full items-center gap-3 rounded-[14px] border border-line bg-paper px-4 py-3 text-left font-semibold transition-colors hover:border-ink disabled:opacity-60"
          >
            {w.info.icon ? (
              <img src={w.info.icon} alt="" width={32} height={32} className="rounded-[8px]" />
            ) : (
              <Icon name="wallet" size={28} />
            )}
            <span className="flex-1">{walletName(w, t.common.wallet.unnamed)}</span>
            <Icon name="chevronRight" size={18} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ConnectDialog({
  onClose,
  onSignedIn,
}: {
  onClose: () => void;
  onSignedIn?: (s: Session) => void;
}) {
  const t = useT();
  const w = t.common.wallet;
  const { wallets, walletsReady, signIn } = useSession();
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (wallet: DiscoveredWallet) => {
    setError(null);
    const name = walletName(wallet, w.unnamed);
    try {
      const s = await signIn(wallet, (step) =>
        setProgress(
          step === 'connecting'
            ? fmt(w.connecting, { wallet: name })
            : step === 'signing'
              ? fmt(w.signing, { wallet: name })
              : w.checking,
        ),
      );
      onSignedIn?.(s);
      onClose();
    } catch (e) {
      setProgress(null);
      if (e instanceof WalletError) setError(e.kind === 'rejected' ? w.rejected : w.failed);
      else if (e instanceof ApiError)
        setError(
          e.status === 0
            ? t.common.errors.network
            : e.status === 429
              ? t.common.errors.limited
              : t.common.errors.generic,
        );
      else setError(w.failed);
    }
  };

  return (
    <Dialog title={w.title} onClose={onClose}>
      <p className="mb-4 text-ink-2">{w.body}</p>
      {MOCK && <Notice className="mb-4">{w.demo}</Notice>}
      {progress ? (
        <div className="flex items-center gap-3 rounded-[14px] bg-well px-4 py-4" role="status">
          <Spinner />
          <span>{progress}</span>
        </div>
      ) : wallets.length ? (
        <>
          <h3 className="mb-2 text-[0.875rem] font-semibold text-ink-3">{w.pick}</h3>
          <WalletList wallets={wallets} onPick={pick} />
        </>
      ) : walletsReady ? (
        <Notice tone="warn">{w.none}</Notice>
      ) : (
        <div className="flex items-center gap-3 text-ink-3" role="status">
          <Spinner />
          {w.searching}
        </div>
      )}
      {error && (
        <Notice tone="error" className="mt-4">
          {error}
        </Notice>
      )}
    </Dialog>
  );
}
