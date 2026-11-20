/* Welcome and sign-in: what the app does in three lines, then the way in (Pollar email or Google;
   the demo wallet in mock mode; a dev key in development). After sign-in the person lands where
   they were going. */
import { useLocation, useNavigate } from 'react-router';
import { useI18n } from '@/i18n';
import { LogoMark } from '@/components/ui/Logo';
import { Icon, type IconName } from '@/components/ui/Icon';
import { SignIn } from '@/components/wallet/SignIn';
import { LangToggle, ThemeToggle } from '@/components/layout/SiteFrame';
import { BRAND } from '@/lib/brand';

export default function Welcome() {
  const { t } = useI18n();
  const w = t.app.welcome;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const points: [IconName, string][] = [
    ['send', w.points.send],
    ['scan', w.points.qr],
    ['lock', w.points.safe],
  ];
  return (
    <div className="flex flex-1 flex-col px-5 pt-3">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2">
          <LogoMark size={30} />
          <b className="text-[1.25rem] tracking-[-0.03em]" style={{ fontStretch: '125%' }}>
            {BRAND.name}
          </b>
        </span>
        <span className="flex items-center gap-1">
          <LangToggle />
          <ThemeToggle />
        </span>
      </div>
      <h1 className="mt-10 text-[2.15rem] leading-[1.04]" style={{ fontStretch: '122%' }}>
        {w.title}
      </h1>
      <p className="mt-3 text-[1.0625rem] text-ink-2">{w.lede}</p>
      <ul className="mt-6 flex flex-col gap-3" role="list">
        {points.map(([icon, text]) => (
          <li key={text} className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-well" aria-hidden="true">
              <Icon name={icon} size={18} />
            </span>
            <span className="font-medium">{text}</span>
          </li>
        ))}
      </ul>
      <section className="sheet mt-8 mb-6 p-4" aria-labelledby="welcome-signin">
        <h2 id="welcome-signin" className="mb-3 text-[1.15rem]">
          {t.common.wallet.title}
        </h2>
        <SignIn
          variant="app"
          personas={['user', 'fresh']}
          onSignedIn={() => {
            if (pathname.replace(/\/+$/, '') === '/app/welcome') navigate('/app', { replace: true });
          }}
        />
      </section>
    </div>
  );
}
