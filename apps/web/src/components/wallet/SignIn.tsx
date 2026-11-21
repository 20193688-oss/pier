/* Sign up and sign in, the way any app does it: an email and the 6-digit code sent to it, or
   Google. Both make or open the person's wallet behind the scenes (Pollar); `mode` only changes
   the words. The dashboard also offers browser wallets (Freighter, Albedo) through Pollar.

   - Mock mode stands in for the email: any address and any 6-digit code sign in as a demo
     persona (src/lib/mock/wallet.ts, personaForEmail). Nothing on screen says it is a demo.
   - Development builds keep a dev-stack secret key as a way in, out of sight unless the URL has
     `?dev` or there is no Pollar key (src/lib/wallet/dev-key.ts, compiled out of production).

   Once a wallet is ready the session signs in with SEP-10 (src/lib/session.tsx); every step says
   what is happening. */
import { useState, type FormEvent } from 'react';
import { fmt, useT } from '@/i18n';
import { Field, Notice, Spinner } from '@/components/ui/controls';
import { Icon } from '@/components/ui/Icon';
import { MOCK } from '@/lib/env';
import { rememberEmail } from '@/lib/app/remember';
import { useSession, type SignInStep } from '@/lib/session';
import {
  getPollar,
  POLLAR_KEY,
  subscribePollar,
  usePollarApi,
  type ExternalWalletId,
} from '@/lib/wallet/pollar-store';
import { WalletError, type StellarWallet } from '@/lib/wallet/types';
import { EMAIL_CODE_LENGTH, emailCode } from '@/lib/wallet/email-code';
import { ApiError } from '@/lib/api/client';
import type { Session } from '@/lib/api/types';
import { useGuard } from '@/lib/use-action';
import { useToastWhen } from '@/components/ui/Toast';

const DEV = import.meta.env.DEV;
/* Compile-time: a production build has neither the demo wallet nor the dev key, not even as a
   chunk (these constants fold to false and the imports below are dropped). */
const MOCK_BUILD = import.meta.env.DEV || import.meta.env.VITE_MOCK === '1';

export type AuthMode = 'signin' | 'signup';

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

/** Google's "G", as its sign-in buttons show it. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}

export function SignIn({
  variant = 'app',
  mode = 'signin',
  onSignedIn,
}: {
  variant?: 'app' | 'dashboard';
  mode?: AuthMode;
  onSignedIn?: (s: Session) => void;
}) {
  const t = useT();
  const w = t.common.wallet;
  const { signIn, expired } = useSession();
  const pollar = usePollarApi();
  useToastWhen(expired, w.expired);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [devOpen, setDevOpen] = useState(false);
  const [secret, setSecret] = useState('');
  const [secretError, setSecretError] = useState<string | null>(null);

  const mock = MOCK_BUILD && MOCK;
  const emailReady = mock || (!!POLLAR_KEY && !!pollar?.ready);
  const showDevKey =
    DEV && !MOCK && (!POLLAR_KEY || new URLSearchParams(location.search).has('dev'));
  const finalLabel = mode === 'signup' ? w.createAccount : w.signIn;

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
    // Cancelled from the waiting screen: back to the form, nothing to say.
    if (e instanceof WalletError && e.message === 'cancelled') return;
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
                : // A wallet's own reason (Pollar's error code) helps whoever reports it.
                  e.message && e.message !== e.kind
                  ? `${w.failed} ${fmt(w.detail, { code: e.message })}`
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

  // One sign-in at a time: a second tap while a wallet is opening is dropped. The forms (the email,
  // its code, a development key) have their own guard: a code's check goes on to open the wallet.
  const guard = useGuard();
  const formGuard = useGuard();
  const run = (first: string, get: () => Promise<StellarWallet>) =>
    guard(async () => {
      setError(null);
      setProgress(first);
      try {
        await finish(await get());
      } catch (e) {
        explain(e);
      }
    });

  /** The demo wallet for this email (mock mode only). */
  const demoFor = async (address: string | null) => {
    if (!MOCK_BUILD) throw new WalletError('unsupported');
    const m = await import('@/lib/mock/wallet');
    return m.demoWallet(m.personaForEmail(address, mode, variant));
  };

  const sendCode = (e: FormEvent) => {
    e.preventDefault();
    return formGuard(async () => {
      e.preventDefault();
      const value = email.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return setError(w.badEmail);
      setError(null);
      // Kept on this device: it suggests the @handle and fills email fields later.
      rememberEmail(value);
      if (mock) {
        setCodeFor(value);
        return;
      }
      setProgress(w.loadingPollar);
      try {
        await pollar!.sendEmailCode(value);
        setCodeFor(value);
        setProgress(null);
      } catch (err) {
        explain(err);
      }
    });
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    return formGuard(async () => {
      e.preventDefault();
      // A code pasted from an email can carry spaces, dashes or invisible characters; it has six.
      const value = emailCode(code);
      if (!value) return;
      if (value.length !== EMAIL_CODE_LENGTH) return setError(w.codeLength);
      if (mock) {
        await run(w.checking, () => demoFor(codeFor));
        return;
      }
      await run(w.checking, async () => {
        await pollar!.verifyEmailCode(value);
        return pollarWallet();
      });
    });
  };

  const google = () =>
    mock
      ? run(fmt(w.connecting, { wallet: 'Google' }), () => demoFor(null))
      : run(fmt(w.connecting, { wallet: 'Google' }), async () => {
          await pollar!.google();
          return pollarWallet();
        });

  const external = (id: ExternalWalletId, label: string) =>
    run(fmt(w.connecting, { wallet: label }), async () => {
      await pollar!.external(id);
      return pollarWallet();
    });

  const submitDevKey = (e: FormEvent) => {
    e.preventDefault();
    return formGuard(async () => {
      e.preventDefault();
      if (!import.meta.env.DEV) return;
      const m = await import('@/lib/wallet/dev-key');
      if (!m.isDevSecret(secret)) return setSecretError(w.devKeyInvalid);
      setSecretError(null);
      const wallet = m.devKeyWallet(secret);
      setSecret('');
      await run(fmt(w.connecting, { wallet: w.devKey }), async () => wallet);
    });
  };

  if (progress)
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3 rounded-[16px] bg-well px-4 py-5" role="status">
          <Spinner />
          <span>{progress}</span>
        </div>
        {/* A Pollar login (Google's window, a wallet) can be dropped instead of waited out. */}
        {!mock && pollar && (
          <button type="button" className="btn btn-quiet self-start" onClick={() => pollar.cancel()}>
            {t.common.actions.cancel}
          </button>
        )}
      </div>
    );

  return (
    <div className="flex flex-col gap-4">

      {!mock && POLLAR_KEY && !pollar?.ready && (
        <div className="flex items-center gap-3 text-ink-3" role="status">
          <Spinner />
          {w.loadingPollar}
        </div>
      )}

      {emailReady &&
        (codeFor ? (
          <form className="flex flex-col gap-3" onSubmit={verify}>
            <p className="text-ink-2">{fmt(w.codeSent, { email: codeFor })}</p>
            <Field
              label={w.code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={EMAIL_CODE_LENGTH + 8}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
            <button type="submit" className="btn btn-ink btn-lg w-full" disabled={!code.trim()}>
              {finalLabel}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setCodeFor(null);
                setCode('');
                setError(null);
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
              {w.continue}
            </button>
            <div className="flex items-center gap-3 text-[0.8125rem] text-ink-3" aria-hidden="true">
              <span className="h-px flex-1 bg-line" />
              {w.or}
              <span className="h-px flex-1 bg-line" />
            </div>
            <button
              type="button"
              className="btn btn-line btn-lg w-full"
              onClick={() => void google()}
            >
              <GoogleMark />
              {w.google}
            </button>
          </form>
        ))}

      {variant === 'dashboard' && !codeFor && !mock && POLLAR_KEY && pollar?.ready && (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <p className="font-semibold">{w.external}</p>
          <p className="text-[0.875rem] text-ink-3">{w.externalBody}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-line"
              onClick={() => external('freighter', w.freighter)}
            >
              {w.freighter}
            </button>
            <button
              type="button"
              className="btn btn-line"
              onClick={() => external('albedo', w.albedo)}
            >
              {w.albedo}
            </button>
          </div>
        </div>
      )}

      {!mock && !POLLAR_KEY && <Notice tone="warn">{w.noPollar}</Notice>}

      {showDevKey && (
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
