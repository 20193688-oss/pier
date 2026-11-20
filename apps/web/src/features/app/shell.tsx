/* The payments app's frame: a phone-width column (centred on a desktop), safe-area insets, the
   floating dock with the scan button in the middle, a screen header with a back button, and the
   banners for no connection and a new version. */
import type { ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { useI18n } from '@/i18n';
import { Icon, type IconName } from '@/components/ui/Icon';
import { applyUpdate, usePwa } from '@/lib/pwa';

export function AppFrame({ children, tabs }: { children: ReactNode; tabs: boolean }) {
  const { t } = useI18n();
  const pwa = usePwa();
  return (
    <div className="app-backdrop min-h-dvh">
      <div className="app-column relative mx-auto flex min-h-dvh w-full max-w-[460px] flex-col bg-paper">
        <div className="app-top-inset" />
        {!pwa.online && (
          <p
            className="bg-warn-soft px-4 py-2 text-center text-[0.875rem] font-semibold text-warn"
            role="status"
          >
            {t.app.pwa.offline}
          </p>
        )}
        {pwa.updateReady && (
          <div
            className="flex items-center justify-between gap-3 bg-info-soft px-4 py-2 text-[0.875rem] text-info"
            role="status"
          >
            <span className="font-semibold">{t.app.pwa.update}</span>
            <button type="button" className="btn btn-sm btn-line" onClick={applyUpdate}>
              {t.app.pwa.reload}
            </button>
          </div>
        )}
        <main
          id="main"
          className={`flex flex-1 flex-col ${tabs ? 'app-with-tabs' : 'app-without-tabs'}`}
        >
          {children}
        </main>
        {tabs && <TabBar />}
      </div>
    </div>
  );
}

function Tab({
  to,
  icon,
  label,
  end,
}: {
  to: string;
  icon: IconName;
  label: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
      title={label}
      className={({ isActive }) =>
        `grid size-12 place-items-center rounded-full transition-colors ${isActive ? 'bg-well text-ink' : 'text-ink-3 hover:text-ink'}`
      }
    >
      {({ isActive }) => <Icon name={icon} size={22} strokeWidth={isActive ? 2.3 : 1.9} />}
    </NavLink>
  );
}

/** The tabs: one floating pill, the scan button at its centre. */
export function TabBar() {
  const { t } = useI18n();
  const tb = t.app.tabs;
  return (
    <nav
      aria-label={tb.label}
      className="app-dock fixed left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full p-1.5"
    >
      <Tab to="/app" end icon="home" label={tb.home} />
      <Tab to="/app/activity" icon="list" label={tb.activity} />
      <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
      <NavLink
        to="/app/scan"
        aria-label={tb.scan}
        title={tb.scan}
        className="grid size-[52px] place-items-center rounded-full bg-ink text-on-ink transition-transform active:scale-95"
      >
        <Icon name="scan" size={24} strokeWidth={2.2} />
      </NavLink>
      <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
      <Tab to="/app/receive" icon="qr" label={tb.receive} />
      <Tab to="/app/me" icon="user" label={tb.me} />
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
        <header className={`flex min-h-[60px] items-center gap-2 pt-1 ${wide ? 'px-4' : ''}`}>
          {back && (
            <button
              type="button"
              className="btn btn-quiet btn-icon -ml-1.5 bg-sheet shadow-[var(--shadow-sheet)]"
              onClick={goBack}
              aria-label={t.app.back}
            >
              <Icon name="back" size={20} />
            </button>
          )}
          {title && <h1 className="flex-1 truncate text-[1.375rem]">{title}</h1>}
          {!title && <span className="flex-1" />}
          {action}
        </header>
      )}
      {children}
    </div>
  );
}

/** An action on the aura (the home screen's send, receive, add, withdraw): a pale tile with a
    black icon tile and a tracked capital label. */
export function ActionTile({ to, icon, label }: { to: string; icon: IconName; label: string }) {
  return (
    <NavLink to={to} className="tile">
      <span className="tile-icon" aria-hidden="true">
        <Icon name={icon} size={16} strokeWidth={2.3} />
      </span>
      <span className="caps truncate">{label}</span>
    </NavLink>
  );
}
