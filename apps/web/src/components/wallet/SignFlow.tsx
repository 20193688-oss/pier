/* Signing one or more transactions in the person's own wallet. Each step's transaction is built
   by the API (or comes with the order), then checked against what the screen promised (the
   target, the chain, and the decoded call: tx-verify.ts) before the wallet is asked; a step that
   fails the check is never sent. Steps already sent are never sent again on a retry, so a sale
   never locks its tokens twice. */
import { useRef, useState } from 'react';
import { fmt, useT } from '@/i18n';
import { Notice, Spinner } from '@/components/ui/controls';
import { Icon } from '@/components/ui/Icon';
import { WalletList, walletName } from '@/components/wallet/ConnectDialog';
import { useSession } from '@/lib/session';
import {
  ensureChain,
  sendTransaction,
  waitForTransaction,
  WalletError,
} from '@/lib/wallet/actions';
import { evmChainOf } from '@/lib/p2p/tx-check';
import { shortAddress } from '@/lib/format';
import { ApiError } from '@/lib/api/client';
import type { DiscoveredWallet } from '@/lib/wallet/eip6963';
import type { P2pNetwork, P2pTransaction } from '@/lib/p2p/types';
import type { TxExpectation } from '@/lib/p2p/tx-verify';

export interface TxStep {
  label: string;
  build: () => Promise<P2pTransaction>;
  expect: TxExpectation;
}

class Refused extends Error {}

export function SignFlow({
  network,
  signer,
  steps,
  onDone,
  startLabel,
  onError,
}: {
  network: P2pNetwork;
  /* The address that must sign (the order's seller, the registered wallet...). */
  signer: string;
  steps: TxStep[];
  onDone: (hashes: string[]) => void;
  startLabel?: string;
  onError?: (e: unknown) => void;
}) {
  const t = useT();
  const s = t.common.sign;
  const { wallet: sessionWallet, wallets } = useSession();
  const [picked, setPicked] = useState<DiscoveredWallet | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const sent = useRef<string[]>([]);
  const [doneCount, setDoneCount] = useState(0);
  const wallet = picked ?? sessionWallet;

  const run = async (w: DiscoveredWallet) => {
    setBusy(true);
    setError('');
    const name = walletName(w, t.common.wallet.unnamed);
    try {
      const { verifyTransaction } = await import('@/lib/p2p/tx-verify');
      const accounts = (await w.provider.request({ method: 'eth_requestAccounts' })) as string[];
      const from = accounts.find((a) => a.toLowerCase() === signer.toLowerCase());
      if (!from) throw new Refused(fmt(s.wrongAccount, { address: shortAddress(signer) }));
      for (let i = sent.current.length; i < steps.length; i++) {
        const step = steps[i];
        setProgress(s.preparing);
        const tx = await step.build();
        setProgress(s.checking);
        if (verifyTransaction(tx, network, step.expect)) throw new Refused(s.mismatch);
        setProgress(fmt(s.switching, { network: network.name }));
        await ensureChain(w.provider, network.chainId, evmChainOf(network));
        setProgress(fmt(s.confirm, { wallet: name }));
        const hash = await sendTransaction(w.provider, from as `0x${string}`, tx);
        sent.current.push(hash);
        setProgress(s.mining);
        await waitForTransaction(w.provider, hash);
        setDoneCount(sent.current.length);
      }
      setProgress('');
      onDone([...sent.current]);
    } catch (e) {
      setProgress('');
      if (e instanceof Refused) setError(e.message);
      else if (e instanceof WalletError)
        setError(
          e.kind === 'rejected'
            ? t.common.wallet.rejected
            : e.kind === 'chain'
              ? fmt(s.chain, { network: network.name })
              : e.kind === 'reverted'
                ? s.reverted
                : t.common.wallet.failed,
        );
      else if (e instanceof ApiError) {
        setError(
          e.status === 0
            ? t.common.errors.network
            : e.status === 429
              ? t.common.errors.limited
              : t.common.errors.generic,
        );
        onError?.(e);
      } else setError(t.common.wallet.failed);
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    if (wallet) void run(wallet);
    else setChoosing(true);
  };

  return (
    <div className="flex flex-col gap-3">
      {steps.length > 1 && (
        <ol className="flex flex-col gap-2" aria-label={s.title}>
          {steps.map((st, i) => {
            const state = i < doneCount ? 'done' : i === doneCount ? 'active' : 'todo';
            return (
              <li key={st.label} className="flex items-center gap-3">
                <span
                  className={`grid size-7 shrink-0 place-items-center rounded-full text-[0.8125rem] font-bold ${state === 'done' ? 'bg-ok text-on-ink' : state === 'active' ? 'bg-marker text-marker-ink' : 'bg-well text-ink-3'}`}
                  aria-hidden="true"
                >
                  {state === 'done' ? <Icon name="check" size={16} /> : i + 1}
                </span>
                <span className={state === 'todo' ? 'text-ink-3' : ''}>
                  <span className="sr-only">
                    {fmt(s.step, { n: i + 1, total: steps.length })}:{' '}
                  </span>
                  {st.label}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {choosing && !busy && !wallet ? (
        <div>
          <p className="mb-2 text-[0.875rem] font-semibold text-ink-3">{t.common.wallet.pick}</p>
          {wallets.length ? (
            <WalletList
              wallets={wallets}
              onPick={(w) => {
                setPicked(w);
                setChoosing(false);
                void run(w);
              }}
            />
          ) : (
            <Notice tone="warn">{t.common.wallet.none}</Notice>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-ink btn-lg w-full"
          disabled={busy || doneCount === steps.length}
          onClick={start}
        >
          {busy ? <Spinner /> : <Icon name="wallet" />}
          {busy ? progress : error ? s.retry : (startLabel ?? s.start)}
        </button>
      )}
      <p className="text-[0.8125rem] text-ink-3">
        {fmt(s.signer, { address: shortAddress(signer) })}. {s.nonCustodial}
      </p>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
