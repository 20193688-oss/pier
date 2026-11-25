/* Welcome, sign-up and sign-in. The welcome says what the app is for, lists what it does (send,
   add money, pay by QR) as rows, and ends with two ways in (create an account, sign in); from a
   tablet up the brand panel (the symbol in a glass lens) sits on the right. Each opens a plain page with the form (src/components/
   wallet/SignIn.tsx). From a tablet up both are split in two: the aura with the slid P on the
   left, the words and the way in on the right. The screen stays on the route the person was going
   to, so after signing in they land there (a payment link opens the send screen). */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useI18n } from '@/i18n';
import { Logo, LogoGlyph } from '@/components/ui/Logo';
import { Icon } from '@/components/ui/Icon';
import { SignIn, type AuthMode } from '@/components/wallet/SignIn';
import { LangToggle, ThemeToggle } from '@/components/layout/SiteFrame';
import { useSession } from '@/lib/session';
import { useClearErrors } from '@/components/ui/Toast';

export default function Welcome() {
  const { expired } = useSession();
  // A session that ended opens on the sign-in (its form says so). The errors it caused on the
  // screen left behind ("could not load your balance") are not this screen's: they go.
  const [mode, setMode] = useState<AuthMode | null>(expired ? 'signin' : null);
  const clearErrors = useClearErrors();
  useEffect(() => {
    if (expired) clearErrors();
  }, [expired, clearErrors]);
  if (mode) return <Auth mode={mode} onMode={setMode} onBack={() => setMode(null)} />;
  return <Intro onMode={setMode} />;
}

/** The brand panel of the welcome on a wide screen (on the right): the symbol in a glass lens. */
function AuraPanel() {
  return (
    <div className="tone-dark aura-card m-4 hidden flex-col overflow-hidden rounded-[32px] p-10 text-ink md:flex">
      <div className="flex flex-1 items-center justify-center">
        <span className="glass-lens size-[min(300px,60%)] max-w-[300px]">
          <LogoGlyph size={140} />
        </span>
      </div>
    </div>
  );
}

const FEATURE_ICONS = ['send', 'plus', 'scan'] as const;

/** What the app does, a row each: its glyph, its name and one line. */
function Features() {
  const { t } = useI18n();
  return (
    <ul className="flex flex-col gap-2.5" role="list">
      {t.app.welcome.features.map((f, i) => (
        <li key={f.title} className="glass flex items-center gap-3.5 rounded-[20px] px-4 py-3.5">
          <span className="icon-tile" aria-hidden="true">
            <Icon name={FEATURE_ICONS[i] ?? 'send'} size={19} />
          </span>
          <span className="flex min-w-0 flex-col">
            <b className="font-semibold">{f.title}</b>
            <span className="text-[0.875rem] text-ink-3">{f.body}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Intro({ onMode }: { onMode: (m: AuthMode) => void }) {
  const { t } = useI18n();
  const w = t.app.welcome;
  const a = t.common.wallet;
  const buttons = (
    <>
      <button type="button" className="btn btn-ink btn-lg w-full" onClick={() => onMode('signup')}>
        {a.createAccount}
      </button>
      <button type="button" className="btn btn-line btn-lg w-full" onClick={() => onMode('signin')}>
        {a.signIn}
      </button>
    </>
  );
  return (
    <>
      {/* From a tablet up: the words, what the app does and the way in, with the brand panel on
          the right. */}
      <div className="hidden min-h-dvh md:grid md:grid-cols-[minmax(440px,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col px-12 py-8 lg:px-16">
          <div className="flex items-center justify-between gap-1">
            <Logo size={32} />
            <span className="flex items-center gap-1">
              <LangToggle />
              <ThemeToggle />
            </span>
          </div>
          <div className="flex max-w-[520px] flex-1 flex-col justify-center gap-8">
            <div>
              <h1 className="display text-[clamp(2.4rem,4.4vw,3.5rem)]">{w.title}</h1>
              <p className="mt-4 text-[1.125rem] text-ink-2">{w.lede}</p>
            </div>
            <Features />
            <div className="flex max-w-sm flex-col gap-3">{buttons}</div>
          </div>
        </div>
        <AuraPanel />
      </div>
      {/* Phone: the logo and the toggles, the words, what the app does, the way in at the foot. */}
      <div className="flex flex-1 flex-col px-5 pt-3 pb-[calc(20px+env(safe-area-inset-bottom,0px))] md:hidden">
        <div className="flex items-center justify-between">
          <Logo size={32} />
          <span className="flex items-center gap-1">
            <LangToggle />
            <ThemeToggle />
          </span>
        </div>
        <div className="mt-10">
          <h1 className="display text-[clamp(2rem,10vw,2.6rem)]">{w.title}</h1>
          <p className="mt-3 text-[1.0625rem] text-ink-2">{w.lede}</p>
        </div>
        <div className="mt-8">
          <Features />
        </div>
        <div className="mt-auto flex flex-col gap-2 pt-8">{buttons}</div>
      </div>
    </>
  );
}

function Auth({
  mode,
  onMode,
  onBack,
}: {
  mode: AuthMode;
  onMode: (m: AuthMode) => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const a = t.common.wallet;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const signup = mode === 'signup';
  return (
    <div className="flex flex-1 flex-col md:grid md:min-h-dvh md:grid-cols-[minmax(440px,1fr)_minmax(0,1fr)]">
      <div className="flex flex-1 flex-col px-5 pt-3 md:px-12 md:py-8 lg:px-16">
        <div className="flex items-center justify-between">
          <button
            type="button"
            className="btn btn-orb btn-icon -ml-1.5"
            onClick={onBack}
            aria-label={t.app.back}
          >
            <Icon name="back" size={20} />
          </button>
          <span className="flex items-center gap-1">
            <LangToggle />
            <ThemeToggle />
          </span>
        </div>
        <div className="flex flex-col md:my-auto md:w-full md:max-w-[440px]">
          <div className="mt-8 md:mt-0">
            <LogoGlyph size={40} className="text-ink" />
          </div>
          <h1 className="mt-5 text-[1.875rem]">{signup ? a.signUpTitle : a.signInTitle}</h1>
          <p className="mt-2 text-ink-2">{signup ? a.signUpBody : a.signInBody}</p>
          <div className="mt-7">
            {/* A new instance per mode: switching starts the form over. */}
            <SignIn
              key={mode}
              variant="app"
              mode={mode}
              onSignedIn={() => {
                if (pathname.replace(/\/+$/, '') === '/app/welcome')
                  navigate('/app', { replace: true });
              }}
            />
          </div>
        </div>
        <p className="mt-auto pt-10 pb-2 text-center text-ink-2 md:mt-0 md:max-w-[440px] md:text-left">
          {signup ? a.haveAccount : a.noAccount}{' '}
          <button
            type="button"
            className="font-semibold text-ink underline underline-offset-4"
            onClick={() => onMode(signup ? 'signin' : 'signup')}
          >
            {signup ? a.signIn : a.createAccount}
          </button>
        </p>
      </div>
      <AuraPanel />
    </div>
  );
}
