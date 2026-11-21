/* Claim (or change) the @handle people find you by. Right after the first sign-in it is the next
   step (the app sends a person without one here, then on to where they were going), offered
   already filled from the email they signed in with. */
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { normalizeHandle } from '@pier/payment-qr';
import { fmt, useI18n } from '@/i18n';
import { app } from '@/lib/api/app';
import { ApiError } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/messages';
import { Notice, Spinner } from '@/components/ui/controls';
import { useToast } from '@/components/ui/Toast';
import { useAppData } from '@/features/app/data';
import { Screen } from '@/features/app/shell';
import { recallEmail, suggestHandle } from '@/lib/app/remember';
import { useGuard } from '@/lib/use-action';

/** Where to go after the handle: an app path the redirect named, else home. */
const nextPath = (raw: string | null) =>
  raw && raw.startsWith('/app') && !raw.startsWith('/app/handle') ? raw : '/app';

export default function HandleScreen() {
  const { t } = useI18n();
  const h = t.app.handle;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const toast = useToast();
  const { profile, setProfile } = useAppData();
  const [value, setValue] = useState(() => profile?.handle ?? suggestHandle(recallEmail()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const handle = normalizeHandle(value);

  const done = () => navigate(nextPath(params.get('next')), { replace: true });

  const guard = useGuard();
  const save = (e: FormEvent) => {
    e.preventDefault();
    return guard(async () => {
      e.preventDefault();
      if (!handle) return setError(h.invalid);
      setBusy(true);
      setError('');
      try {
        const p = await app.claimHandle(handle);
        setProfile(p);
        toast(fmt(h.saved, { handle: p.handle ?? handle }));
        done();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) setError(fmt(h.taken, { handle }));
        else if (err instanceof ApiError && err.code === 'handle_reserved')
          setError(fmt(h.reserved, { handle }));
        else if (err instanceof ApiError && err.status === 422) setError(h.invalid);
        else setError(errorMessage(t.common, err));
      } finally {
        setBusy(false);
      }
    });
  };

  return (
    <Screen back={profile?.handle ? '/app/me' : undefined}>
      <form className="flex flex-1 flex-col pt-6" onSubmit={save}>
        <h1 className="text-[1.9rem] leading-[1.08]" style={{ fontStretch: '120%' }}>
          {h.title}
        </h1>
        <p className="mt-2 text-ink-2">{h.body}</p>
        <label htmlFor="handle" className="mt-8 text-[0.875rem] font-semibold text-ink-2">
          {h.label}
        </label>
        <div className="mt-1.5 flex items-center rounded-[14px] border border-transparent bg-well px-4 focus-within:border-ink focus-within:bg-sheet">
          <span className="text-[1.5rem] font-bold text-ink-3" aria-hidden="true">
            @
          </span>
          <input
            id="handle"
            className="min-h-[56px] w-full bg-transparent pl-1 text-[1.5rem] font-bold outline-none"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            spellCheck={false}
            maxLength={21}
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/^@/, '').toLowerCase())}
            aria-invalid={error ? true : undefined}
            aria-describedby="handle-msg"
          />
        </div>
        <p
          id="handle-msg"
          className={`mt-1.5 text-[0.8125rem] ${error ? 'text-bad' : 'text-ink-3'}`}
        >
          {error || h.hint}
        </p>
        <div className="mt-auto flex flex-col gap-2 pt-8 pb-4">
          <button type="submit" className="btn btn-ink btn-lg w-full" disabled={busy || !value}>
            {busy && <Spinner />}
            {h.save}
          </button>
        </div>
        {!handle && value.length > 2 && !error && <Notice tone="warn">{h.invalid}</Notice>}
      </form>
    </Screen>
  );
}
