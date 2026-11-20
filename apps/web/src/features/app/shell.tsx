/* The payments app's frame: a phone-width column (centred on a desktop), safe-area insets, the
   bottom tab bar with the scan button in the middle, a screen header with a back button, and the
   banners for demo mode, no connection and a new version. */
import type { ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { useI18n } from '@/i18n';
import { Icon, type IconName } from '@/components/ui/Icon';
import { MockBanner } from '@/components/layout/SiteFrame';
import { applyUpdate, usePwa } from '@/lib/pwa';

export function AppFrame({ children, tabs }: { children: ReactNode; tabs: boolean }) {
  const { t } = useI18n();
  const pwa = usePwa();
  return (
    <div className="app-backdrop min-h-dvh">
      <div className="app-column relative mx-auto flex min-h-dvh w-full max-w-[460px] flex-col bg-paper">
        <div className="app-top-inset" />
        <MockBanner />
        {!pwa.online && (
          <p className="bg-warn-soft px-4 py-2 text-center text-[0.875rem] font-semibold text-warn" role="status">
            {t.app.pwa.offline}
          </p>
        )}
        {pwa.updateReady && (
          <div className="flex items-center justify-between gap-3 bg-info-soft px-4 py-2 text-[0.875rem] text-info" role="status">
            <span className="font-semibold">{t.app.pwa.update}</span>
            <button type="button" className="btn btn-sm btn-line" onClick={applyUpdate}>
              {t.app.pwa.reload}
            </button>
          </div>
        )}
        <main id="main" className={`flex flex-1 flex-col ${tabs ? 'app-with-tabs' : 'app-without-tabs'}`}>
          {children}
        </main>
        {tabs && <TabBar />}
      </div>
    </div>
  );
}

function Tab({ to, icon, label, end }: { to: string; icon: IconName; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-[0.75rem] font-semibold ${isActive ? 'text-ink' : 'text-ink-3'}`
      }
    >
      {({ isActive }) => (
        <>
          <Icon name={icon} size={24} strokeWidth={isActive ? 2.3 : 1.9} />
          <span>{label}</span>
        </>
      )}
    </NavLink>
  );
}

export function TabBar() {
  const { t } = useI18n();
  const tb = t.app.tabs;
  return (
    <nav aria-label={tb.label} className="app-tabbar fixed bottom-0 left-1/2 z-20 w-full max-w-[460px] -translate-x-1/2 border-t border-line bg-sheet/95 backdrop-blur">
      <div className="flex items-end px-2">
        <Tab to="/app" end icon="home" label={tb.home} />
        <Tab to="/app/activity" icon="list" label={tb.activity} />
        <div className="flex flex-1 justify-center">
          <NavLink
            to="/app/scan"
            aria-label={tb.scan}
            className="-mt-6 grid size-[64px] place-items-center rounded-full bg-ink text-on-ink shadow-[0_6px_0_-2px_var(--line-2)] ring-4 ring-paper transition-transform active:scale-95"
          >
            <Icon name="scan" size={28} strokeWidth={2.2} />
          </NavLink>
        </div>
        <Tab to="/app/receive" icon="qr" label={tb.receive} />
        <Tab to="/app/me" icon="user" label={tb.me} />
      </div>
    </nav>
  );
}

/** A screen: its header (back, title, an optional action) and its body. */
export function Screen({
  title,
  back,
  action,
  children,
  wide = false,
}: {
  title?: ReactNode;
  /* Where back goes: a path, or true for the previous screen. */
  back?: string | true;
  action?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const goBack = () => {
    if (back === true) {
      if (location.key !== 'default') navigate(-1);
      else navigate('/app');
    } else if (back) navigate(back);
  };
  return (
    <div className={`flex flex-1 flex-col ${wide ? '' : 'px-4'}`}>
      {(title || back || action) && (
        <header className={`flex min-h-[56px] items-center gap-2 ${wide ? 'px-4' : ''}`}>
          {back && (
            <button
              type="button"
              className="btn btn-quiet -ml-2 size-11 px-0"
              onClick={goBack}
              aria-label={t.app.back}
            >
              <Icon name="back" size={22} />
            </button>
          )}
          {title && <h1 className="flex-1 truncate text-[1.25rem]">{title}</h1>}
          {!title && <span className="flex-1" />}
          {action}
        </header>
      )}
      {children}
    </div>
  );
}

/** A big action button with an icon above its label (the home screen's actions). */
export function ActionTile({
  to,
  icon,
  label,
}: {
  to: string;
  icon: IconName;
  label: string;
}) {
  return (
    <NavLink
      to={to}
      className="flex min-h-[84px] flex-col items-center justify-center gap-1.5 rounded-[18px] border border-line bg-sheet px-2 py-3 text-[0.875rem] font-semibold transition-colors hover:border-ink active:bg-well"
    >
      <span className="grid size-10 place-items-center rounded-full bg-well" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      {label}
    </NavLink>
  );
}
