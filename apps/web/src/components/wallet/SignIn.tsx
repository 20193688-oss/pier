/* Sign in: the app's own screen for every way in.

   - Pollar (when this build has a publishable key): an email code, or Google. The dashboard also
     offers browser wallets (Freighter, Albedo) through Pollar.
   - Mock mode: the demo wallet, as one of the demo personas.
   - Development builds: a dev-stack secret key (src/lib/wallet/dev-key.ts, compiled out of
     production builds).

   Once a wallet is ready the session signs in with SEP-10 (src/lib/session.tsx); every step says
   what is happening. */
import { useState, type FormEvent } from 'react';
import { fmt, useT } from '@/i18n';
import { Field, Notice, Spinner } from '@/components/ui/controls';
import { Icon } from '@/components/ui/Icon';
import { MOCK } from '@/lib/env';
import { useSession, type SignInStep } from '@/lib/session';
import {
  getPollar,
  POLLAR_KEY,
  subscribePollar,
  usePollarApi,
  type ExternalWalletId,
} from '@/lib/wallet/pollar-store';
import { WalletError, type StellarWallet } from '@/lib/wallet/types';
import { ApiError } from '@/lib/api/client';
import type { Session } from '@/lib/api/types';

const DEV = import.meta.env.DEV;
/* Compile-time: a production build has neither the demo wallet nor the dev key, not even as a
   chunk (these constants fold to false and the imports below are dropped). */
const MOCK_BUILD = import.meta.env.DEV || import.meta.env.VITE_MOCK === '1';
const PERSONAS = ['user', 'merchant', 'business', 'fresh'] as const;
type Persona = (typeof PERSONAS)[number];

/** Pollar's wallet once it shows up after a login (it is published a moment later). */
function pollarWallet(timeoutMs = 20_000): Promise<StellarWallet> {
  return new Promise((resolve, reject) => {
    const now = getPollar()?.wallet;
    if (now) return resolve(now);
    const timer = setTimeout(() => {
      off();
      reject(new WalletError(getPollar()?.unsupported ? 'unsupported' : 'failed', 'no wallet'));
    }, timeoutMs);
    const off = subscribePollar(() => {
      const api = getPollar();
      if (api?.wallet) {
        clearTimeout(timer);
        off();
        resolve(api.wallet);
      } else if (api?.unsupported) {
        clearTimeout(timer);
        off();
        reject(new WalletError('unsupported'));
      }
    });
  });
}

export function SignIn({
  variant = 'app',
  onSignedIn,
  personas = PERSONAS,
}: {
  variant?: 'app' | 'dashboard';
  onSignedIn?: (s: Session) => void;
  personas?: readonly Persona[];
}) {
  const t = useT();
  const w = t.common.wallet;
  const { signIn, expired } = useSession();
  const pollar = usePollarApi();
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [devOpen, setDevOpen] = useState(false);
  const [secret, setSecret] = useState('');
  const [secretError, setSecretError] = useState<string | null>(null);

  const stepText = (name: string) => (step: SignInStep) =>
    setProgress(
      step === 'challenge'
        ? w.challenge
        : step === 'signing'
          ? fmt(w.signing, { wallet: name })
          : w.checking,
    );

  const explain = (e: unknown) => {
    setProgress(null);
    if (e instanceof WalletError) {
      if (e.message.startsWith('challenge:')) return setError(w.badChallenge);
      setError(
        e.kind === 'rejected'
          ? codeFor
            ? w.badCode
            : w.rejected
          : e.kind === 'pending'
            ? w.pending
            : e.kind === 'unsupported'
              ? w.unsupported
              : e.kind === 'mismatch'
                ? w.mismatch
                : w.failed,
      );
    } else if (e instanceof ApiError)
      setError(
        e.status === 0
          ? t.common.errors.network
          : e.status === 429
            ? t.common.errors.limited
            : t.common.errors.generic,
      );
    else setError(w.failed);
  };

  const finish = async (wallet: StellarWallet) => {
    const s = await signIn(wallet, stepText(wallet.label));
    setProgress(null);
    onSignedIn?.(s);
  };

  const run = async (label: string, get: () => Promise<StellarWallet>) => {
    setError(null);
    setProgress(fmt(w.connecting, { wallet: label }));
    try {
      await finish(await get());
    } catch (e) {
      explain(e);
    }
  };

  const demo = (p: Persona) => {
    if (!MOCK_BUILD) return;
    void run('Demo', async () => (await import('@/lib/mock/wallet')).demoWallet(p));
  };

  const sendCode = async (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return setError(w.badEmail);
    setError(null);
    setProgress(w.loadingPollar);
    try {
      await pollar!.sendEmailCode(value);
      setCodeFor(value);
      setProgress(null);
    } catch (err) {
      explain(err);
    }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    await run('Pollar', async () => {
      await pollar!.verifyEmailCode(code.trim());
      return pollarWallet();
    });
  };

  const external = (id: ExternalWalletId, label: string) =>
    run(label, async () => {
      await pollar!.external(id);
      return pollarWallet();
    });

  const submitDevKey = async (e: FormEvent) => {
    e.preventDefault();
    if (!import.meta.env.DEV) return;
    const m = await import('@/lib/wallet/dev-key');
    if (!m.isDevSecret(secret)) return setSecretError(w.devKeyInvalid);
    setSecretError(null);
    const wallet = m.devKeyWallet(secret);
    setSecret('');
    await run(w.devKey, async () => wallet);
  };

  if (progress)
    return (
      <div className="flex items-center gap-3 rounded-[16px] bg-well px-4 py-5" role="status">
        <Spinner />
        <span>{progress}</span>
      </div>
    );

  const pollarReady = !!pollar?.ready;
  return (
    <div className="flex flex-col gap-4">
      {expired && <Notice tone="warn">{w.expired}</Notice>}
      {MOCK_BUILD && MOCK && (
        <div className="flex flex-col gap-2">
          <Notice>{w.demo}</Notice>
          <p className="text-[0.875rem] font-semibold text-ink-3">{w.demoAs}</p>
          <ul className="flex flex-col gap-2" role="list">
            {personas.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  onClick={() => demo(p)}
                  className="flex min-h-[56px] w-full items-center gap-3 rounded-[16px] border border-line bg-paper px-4 py-3 text-left font-semibold transition-colors hover:border-ink"
                >
                  <Icon name={p === 'user' ? 'wallet' : p === 'fresh' ? 'plus' : 'users'} />
                  <span className="flex-1">{w.personas[p]}</span>
                  <Icon name="chevronRight" size={18} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!MOCK && POLLAR_KEY && !pollarReady && (
        <div className="flex items-center gap-3 text-ink-3" role="status">
          <Spinner />
          {w.loadingPollar}
        </div>
      )}

      {!MOCK && POLLAR_KEY && pollarReady && (
        <>
          {codeFor ? (
            <form className="flex flex-col gap-3" onSubmit={verify}>
              <p className="text-ink-2">{fmt(w.codeSent, { email: codeFor })}</p>
              <Field
                label={w.code}
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
              />
              <button type="submit" className="btn btn-ink btn-lg w-full" disabled={!code.trim()}>
                {w.verify}
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setCodeFor(null);
                  setCode('');
                }}
              >
                {w.otherEmail}
              </button>
            </form>
          ) : (
            <form className="flex flex-col gap-3" onSubmit={sendCode}>
              <Field
                label={w.email}
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder={w.emailPlaceholder}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button type="submit" className="btn btn-ink btn-lg w-full">
                {w.sendCode}
              </button>
              <div className="flex items-center gap-3 text-[0.8125rem] text-ink-3" aria-hidden="true">
                <span className="h-px flex-1 bg-line" />
                {w.or}
                <span className="h-px flex-1 bg-line" />
              </div>
              <button
                type="button"
                className="btn btn-line btn-lg w-full"
                onClick={() =>
                  void run('Google', async () => {
                    await pollar!.google();
                    return pollarWallet();
                  })
                }
              >
                {w.google}
              </button>
            </form>
          )}
          {variant === 'dashboard' && !codeFor && (
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <p className="font-semibold">{w.external}</p>
              <p className="text-[0.875rem] text-ink-3">{w.externalBody}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-line" onClick={() => external('freighter', w.freighter)}>
                  {w.freighter}
                </button>
                <button type="button" className="btn btn-line" onClick={() => external('albedo', w.albedo)}>
                  {w.albedo}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {!MOCK && !POLLAR_KEY && <Notice tone="warn">{w.noPollar}</Notice>}

      {DEV && !MOCK && (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <button
            type="button"
            className="btn btn-quiet justify-start px-0"
            aria-expanded={devOpen}
            onClick={() => setDevOpen((v) => !v)}
          >
            <Icon name="key" size={18} />
            {w.devKey}
          </button>
          {devOpen && (
            <form className="flex flex-col gap-2" onSubmit={submitDevKey}>
              <p className="text-[0.875rem] text-ink-3">{w.devKeyBody}</p>
              <Field
                label={w.devKeyField}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={secret}
                error={secretError}
                onChange={(e) => setSecret(e.target.value)}
              />
              <button type="submit" className="btn btn-line">
                {w.devKeyUse}
              </button>
            </form>
          )}
        </div>
      )}

      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
