/* Welcome, sign-up and sign-in. The welcome sits on the aura over the whole screen: the mark's
   slid M drawn large in the ice, then, where the aura turns to night, what the app is for and two
   ways in (create an account, sign in). Each opens a plain page with the form (src/components/
   wallet/SignIn.tsx). The screen stays on the route the person was going to, so after signing in
   they land there (a payment link opens the send screen). */
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useI18n } from '@/i18n';
import { LogoGlyph, LogoMark } from '@/components/ui/Logo';
import { Icon } from '@/components/ui/Icon';
import { SignIn, type AuthMode } from '@/components/wallet/SignIn';
import { LangToggle, ThemeToggle } from '@/components/layout/SiteFrame';
import { useSession } from '@/lib/session';
import { BRAND } from '@/lib/brand';

export default function Welcome() {
  const { expired } = useSession();
  const [mode, setMode] = useState<AuthMode | null>(expired ? 'signin' : null);
  if (mode) return <Auth mode={mode} onMode={setMode} onBack={() => setMode(null)} />;
  return <Intro onMode={setMode} />;
}

function Intro({ onMode }: { onMode: (m: AuthMode) => void }) {
  const { t } = useI18n();
  const w = t.app.welcome;
  const a = t.common.wallet;
  return (
    // The aura runs to the screen's foot: it takes back the frame's bottom padding.
    <div className="aura-screen grain mb-[calc(-16px-env(safe-area-inset-bottom,0px))] flex flex-1 flex-col pb-[calc(28px+env(safe-area-inset-bottom,0px))]">
      <div className="tone-light flex items-center justify-between px-5 pt-3 text-ink">
        <span className="inline-flex items-center gap-2">
          <LogoMark size={28} />
          <b className="display text-[1.1rem]">{BRAND.name}</b>
        </span>
        <span className="flex items-center gap-1">
          <LangToggle />
          <ThemeToggle />
        </span>
      </div>

      <div className="flex min-h-[200px] flex-1 items-center justify-center text-[#0a0b0e]">
        <LogoGlyph size={136} />
      </div>

      <div className="tone-dark flex flex-col px-5 text-ink">
        <h1 className="display text-[clamp(2rem,10vw,2.7rem)]">{w.title}</h1>
        <p className="mt-3 text-[1.0625rem] text-ink-2">{w.lede}</p>
        <div className="mt-8 flex flex-col gap-2">
          <button
            type="button"
            className="btn btn-white btn-lg w-full"
            onClick={() => onMode('signup')}
          >
            {a.createAccount}
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-lg w-full text-ink"
            onClick={() => onMode('signin')}
          >
            {a.signIn}
          </button>
        </div>
      </div>
    </div>
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
    <div className="flex flex-1 flex-col px-5 pt-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          className="btn btn-quiet btn-icon -ml-1.5 bg-sheet shadow-[var(--shadow-sheet)]"
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
      <div className="mt-8">
        <LogoMark size={44} />
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
      <p className="mt-auto pt-10 pb-2 text-center text-ink-2">
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
  );
}
