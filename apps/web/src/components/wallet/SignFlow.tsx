/* Signing one or more transactions with the signed-in wallet. Each step's transaction is built by
   the API (or comes with the order), checked against what the screen promised (the decoded XDR:
   src/lib/p2p/tx-verify.ts), signed, handed back to the API to submit (it pays the network fee),
   and followed until the network settles it. A step that fails the check is never signed. Steps
   already settled are never sent again on a retry, so a sale never locks its tokens twice.

   A step the API answers as already done (`already_done`: the order already shows it, say after
   a retry from another tab or a page that had not caught up) counts as settled: nothing is signed
   and the flow finishes. A second tap while it runs is dropped (a ref, before any render).

   It never sends the person to sign in from the middle of a payment: while the wallet is coming
   back or the session is being renewed (src/lib/session.tsx) it waits, and without a session it
   is blocked. Only the dashboard (`allowConnect`) offers to sign in here. */
import { useRef, useState } from 'react';
import { fmt, useT, type Messages } from '@/i18n';
import { Notice, Spinner } from '@/components/ui/controls';
import { Icon } from '@/components/ui/Icon';
import { useToastWhen } from '@/components/ui/Toast';
import { ConnectDialog } from '@/components/wallet/ConnectDialog';
import { useSession } from '@/lib/session';
import { shortAddress } from '@/lib/format';
import { ApiError } from '@/lib/api/client';
import { WalletError } from '@/lib/wallet/types';
import type { P2pNetwork, P2pTransaction } from '@/lib/p2p/types';
import type { TxExpectation } from '@/lib/p2p/tx-verify';
import type { Submitter } from '@/lib/wallet/sign';

export interface TxStep {
  label: string;
  build: () => Promise<P2pTransaction>;
  /* Null: no trusted expectation, so the step is refused. */
  expect: TxExpectation | null;
  /* An expectation that can only be known once `build` ran (a sale's ref comes from the order
     `build` opened); it wins over `expect`. */
  expectFor?: () => TxExpectation | null;
  /* How many times a step the network refused is built again and re-sent on its own (a refused
     transaction changed nothing, so it is safe): for a step whose `build` simulates afresh, such
     as a sale's opening, whose footprint another order can make stale in the meantime. */
  retryOnFail?: number;
}

/** A signing failure in the reader's words. */
export function signError(common: Messages['common'], e: unknown): string {
  const s = common.sign;
  if (e instanceof Error && e.name === 'Refused') return s.mismatch;
  if (e instanceof Error && e.name === 'SubmitFailed') {
    const code = (e as Error & { contractError?: string | null }).contractError;
    return code ? fmt(s.revertedCode, { code }) : s.reverted;
  }
  if (e instanceof WalletError)
    return e.kind === 'rejected'
      ? common.wallet.rejected
      : e.kind === 'pending'
        ? common.wallet.pending
        : e.kind === 'unsupported'
          ? common.wallet.unsupported
          : e.kind === 'mismatch'
            ? common.wallet.mismatch
            : common.wallet.failed;
  if (e instanceof ApiError)
    return e.status === 0
      ? common.errors.network
      : e.status === 429
        ? common.errors.limited
        : e.code === 'bad_response'
          ? common.errors.badResponse
          : common.errors.generic;
  return common.wallet.failed;
}

export function SignFlow({
  network,
  signer,
  steps,
  via,
  onDone,
  startLabel,
  onError,
  sponsored = true,
  allowConnect = false,
}: {
  network: P2pNetwork;
  /* The address that must sign (the order's seller, the registered wallet...). */
  signer: string;
  steps: TxStep[];
  /* Where signed envelopes go: the app's or the organization's submit route. */
  via: Submitter;
  onDone: (hashes: string[]) => void;
  startLabel?: string;
  onError?: (e: unknown) => void;
  /* Whether the API pays the network fee (the market's `sponsor.enabled`). */
  sponsored?: boolean;
  /* Offer to sign in when no wallet is at hand (the dashboard); the app blocks instead. */
  allowConnect?: boolean;
}) {
  const t = useT();
  const s = t.common.sign;
  const { wallet, walletReady, expired, renewing } = useSession();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const sent = useRef<string[]>([]);
  const running = useRef(false);
  const [doneCount, setDoneCount] = useState(0);
  const wrongWallet = !!wallet && wallet.address !== signer;
  // Nothing to sign with (the session ended, or the wallet is gone): said in a toast.
  const stuck = (!wallet || expired) && walletReady && !renewing;
  useToastWhen(
    stuck,
    allowConnect && !expired ? t.common.wallet.reconnect : s.blocked,
    allowConnect && !expired ? 'info' : 'error',
  );

  const run = async () => {
    if (!wallet || wrongWallet || running.current || sent.current.length >= steps.length) return;
    running.current = true;
    setBusy(true);
    setError('');
    setPending(false);
    try {
      const { signAndSubmit } = await import('@/lib/wallet/sign');
      for (let i = sent.current.length; i < steps.length; i++) {
        const step = steps[i];
        let r: Awaited<ReturnType<typeof signAndSubmit>>;
        let already = false;
        for (let attempt = 0; ; attempt++) {
          setProgress(attempt ? s.refreshing : s.preparing);
          let tx: P2pTransaction;
          try {
            tx = await step.build();
          } catch (e) {
            // Already done (a retry): settled, with no transaction of its own.
            if (e instanceof ApiError && e.code === 'already_done') {
              already = true;
              break;
            }
            throw e;
          }
          try {
            r = await signAndSubmit({
              wallet,
              network,
              tx,
              expect: step.expectFor ? step.expectFor() : step.expect,
              via,
              onStep: (st) =>
                setProgress(
                  st === 'checking'
                    ? s.checking
                    : st === 'signing'
                      ? fmt(s.signing, { wallet: wallet.label })
                      : st === 'submitting'
                        ? s.submitting
                        : s.waiting,
                ),
            });
            break;
          } catch (e) {
            const refused = e instanceof Error && e.name === 'SubmitFailed';
            if (!refused || attempt >= (step.retryOnFail ?? 0)) throw e;
          }
        }
        if (already) sent.current.push('');
        else {
          if (r!.status === 'PENDING') setPending(true);
          sent.current.push(r!.hash);
        }
        setDoneCount(sent.current.length);
      }
      setProgress('');
      onDone(sent.current.filter(Boolean));
    } catch (e) {
      setProgress('');
      setError(signError(t.common, e));
      if (e instanceof ApiError) onError?.(e);
    } finally {
      running.current = false;
      setBusy(false);
    }
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
      {!wallet || expired ? (
        !walletReady || renewing ? (
          <button type="button" className="btn btn-ink btn-lg w-full" disabled>
            <Spinner />
            {s.connecting}
          </button>
        ) : allowConnect && !expired ? (
          <>
            <button
              type="button"
              className="btn btn-ink btn-lg w-full"
              onClick={() => setSigningIn(true)}
            >
              <Icon name="wallet" />
              {t.common.wallet.connect}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-ink btn-lg w-full" disabled>
              <Icon name="lock" />
              {startLabel ?? s.start}
            </button>
          </>
        )
      ) : wrongWallet ? (
        <Notice tone="warn">{fmt(s.wrongAccount, { address: shortAddress(signer) })}</Notice>
      ) : (
        <button
          type="button"
          className="btn btn-ink btn-lg w-full"
          disabled={busy || doneCount === steps.length}
          onClick={() => void run()}
        >
          {busy ? <Spinner /> : <Icon name="wallet" />}
          {busy ? progress : error ? s.retry : (startLabel ?? s.start)}
        </button>
      )}
      <p className="text-[0.8125rem] text-ink-3">
        {fmt(s.signer, { address: shortAddress(signer) })}. {s.nonCustodial}
        {sponsored ? ` ${s.gasless}` : ''}
      </p>
      {pending && <Notice>{s.stillPending}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {signingIn && <ConnectDialog onClose={() => setSigningIn(false)} />}
    </div>
  );
}
