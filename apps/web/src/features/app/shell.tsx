/* The payments app's frame.
   - Phone: one column with the safe-area insets. The tab screens carry a top bar (your avatar,
     which opens the profile; the screen's name; your QR), except the home, whose keypad brings
     its own (the balance chip in the middle), and a bar docked at the foot with three places:
     Home (the keypad), the scanner (the centre) and Activity.
   - Tablet and up (768px): a top navigation bar with the logo, the sections, a "Move money" menu,
     the scanner and the avatar; the screens below it in a wide centred column.
   Every screen comes in with a short motion (forward from the right, back from the left, a tab
   switch fades); the banners for no connection and a new version. Also the screen layout (a top
   bar with back on a phone, a page header from a tablet up, and a step rail for the flows) and
   the home's action chips. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, useNavigationType } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Logo } from '@/components/ui/Logo';
import { applyUpdate, usePwa } from '@/lib/pwa';
import { useAppData } from '@/features/app/data';

export const TAB_PATHS = ['/app', '/app/activity', '/app/receive', '/app/me'];
const clean = (path: string) => path.replace(/\/+$/, '') || '/app';

/** How the new screen moves in: between tabs it fades, going back it comes from the left, any
    other step forward from the right. */
function useScreenMotion(pathname: string): 'fade' | 'forward' | 'back' {
  const type = useNavigationType();
  const prev = useRef(pathname);
  const from = prev.current;
  useEffect(() => {
    prev.current = pathname;
  }, [pathname]);
  if (from === pathname) return 'fade';
  if (TAB_PATHS.includes(clean(from)) && TAB_PATHS.includes(clean(pathname))) return 'fade';
  if (type === 'POP') return 'back';
  return type === 'REPLACE' ? 'fade' : 'forward';
}

/** Everything that moves money, as the Move money sheet and menu list it. */
function useMoveActions(): { to: string; icon: IconName; title: string; sub: string }[] {
  const { t } = useI18n();
  const m = t.app.move;
  return [
    { to: '/app/send', icon: 'send', title: m.send.title, sub: m.send.sub },
    { to: '/app/receive', icon: 'qr', title: m.receive.title, sub: m.receive.sub },
    { to: '/app/add', icon: 'plus', title: m.add.title, sub: m.add.sub },
    { to: '/app/withdraw', icon: 'bank', title: m.withdraw.title, sub: m.withdraw.sub },
    { to: '/app/scan', icon: 'scan', title: m.scan.title, sub: m.scan.sub },
  ];
}

/** The list of money moves: a row each with its glyph, what it does and a chevron. */
function MoveList({ onPick }: { onPick: () => void }) {
  const actions = useMoveActions();
  return (
    <ul className="flex flex-col gap-2" role="list">
      {actions.map((a) => (
        <li key={a.to}>
          <Link
            to={a.to}
            onClick={onPick}
            className="glass glass-hover flex min-h-[64px] items-center gap-3.5 rounded-[18px] px-4 py-3"
          >
            <span className="icon-tile" aria-hidden="true">
              <Icon name={a.icon} size={19} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <b className="font-semibold">{a.title}</b>
              <span className="text-[0.8125rem] text-ink-3">{a.sub}</span>
            </span>
            <Icon name="chevronRight" size={18} className="shrink-0 text-ink-3" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The signed-in person's initial in a glass circle. */
function Avatar({ size = 36 }: { size?: number }) {
  const { profile } = useAppData();
  return (
    <span
      className="glass-strong grid shrink-0 place-items-center rounded-full font-bold text-ink uppercase"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {profile?.handle ? (
        profile.handle.slice(0, 1)
      ) : (
        <Icon name="user" size={size * 0.48} strokeWidth={2.2} />
      )}
    </span>
  );
}

export function AppFrame({
  children,
  tabs,
  nav,
}: {
  children: ReactNode;
  /* The phone's bars (the tab screens). */
  tabs: boolean;
  /* Signed in: the top navigation on every screen from a tablet up. */
  nav: boolean;
}) {
  const { t } = useI18n();
  const pwa = usePwa();
  const { pathname } = useLocation();
  const motion = useScreenMotion(pathname);
  return (
    <div className="app-backdrop min-h-dvh">
      {nav && <TopNav />}
      <div className="app-column relative mx-auto flex min-h-dvh w-full max-w-[460px] flex-col md:min-h-0 md:max-w-none">
        <div className="app-top-inset md:hidden" />
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
        {tabs && clean(pathname) !== '/app' && <PhoneTopBar path={clean(pathname)} />}
        <main
          id="main"
          className={`flex flex-1 flex-col ${tabs ? 'app-with-tabs' : 'app-without-tabs'}`}
        >
          <div key={pathname} data-motion={motion} className="screen flex w-full flex-1 flex-col">
            {children}
          </div>
        </main>
        {tabs && <TabBar />}
      </div>
    </div>
  );
}

/** The phone's top bar on the tab screens: the avatar (the profile), the screen's name, the
    scanner. */
function PhoneTopBar({ path }: { path: string }) {
  const { t } = useI18n();
  const tb = t.app.tabs;
  const names: Record<string, string> = {
    '/app/activity': tb.activity,
    '/app/receive': tb.receive,
    '/app/me': tb.me,
  };
  const name = names[path];
  return (
    <div className="sticky top-0 z-20 flex h-[60px] items-center gap-3 bg-[var(--bar)] px-5 backdrop-blur-2xl backdrop-saturate-150 md:hidden">
      <Link to="/app/me" aria-label={tb.me} className="rounded-full">
        <Avatar />
      </Link>
      <div className="flex min-w-0 flex-1 justify-center">
        {name ? (
          <h1 className="truncate text-[1.0625rem]">{name}</h1>
        ) : (
          <Logo size={31} label={t.common.brand} />
        )}
      </div>
      <Link to="/app/receive" aria-label={tb.receive} className="btn btn-orb btn-icon">
        <Icon name="qr" size={19} />
      </Link>
    </div>
  );
}

function BarItem({
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
      className={({ isActive }) =>
        `flex min-w-0 flex-1 flex-col items-center gap-1 py-1 text-[0.75rem] font-semibold transition-colors duration-200 ${isActive ? 'text-ink' : 'text-ink-3 hover:text-ink'}`
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={`grid h-8 w-14 place-items-center rounded-full transition-[background-color,transform] duration-200 ${isActive ? 'tab-on glass-strong' : ''}`}
          >
            <Icon name={icon} size={21} strokeWidth={isActive ? 2.3 : 1.9} />
          </span>
          {label}
        </>
      )}
    </NavLink>
  );
}

/** The phone's bar at the foot: Home (the keypad), the scanner at its centre, and Activity. */
export function TabBar() {
  const { t } = useI18n();
  const tb = t.app.tabs;
  return (
    <nav
      aria-label={tb.label}
      className="app-dock fixed inset-x-3 z-20 flex items-end justify-between rounded-[26px] px-3 pt-2 pb-2 md:hidden"
    >
      <BarItem to="/app" end icon="dollar" label={tb.home} />
      <NavLink
        to="/app/scan"
        className="flex min-w-0 flex-1 flex-col items-center gap-1 text-[0.75rem] font-semibold text-ink"
      >
        <span className="-mt-7 grid size-[58px] place-items-center rounded-full bg-primary text-on-primary shadow-[inset_0_1px_0_rgb(255_255_255/0.4),0_12px_26px_-10px_rgb(3_6_20/0.75)] transition-transform duration-150 active:scale-90">
          <Icon name="scan" size={24} strokeWidth={2.2} />
        </span>
        {tb.scan}
      </NavLink>
      <BarItem to="/app/activity" icon="list" label={tb.activity} />
    </nav>
  );
}

/** From a tablet up: the top navigation (logo, sections, Move money, scanner, avatar). */
function TopNav() {
  const { t } = useI18n();
  const tb = t.app.tabs;
  const links = [
    { to: '/app', label: tb.home, end: true },
    { to: '/app/activity', label: tb.activity },
    { to: '/app/receive', label: tb.receive },
  ];
  return (
    <header className="sticky top-0 z-30 hidden border-b border-[var(--glass-rim)] bg-[var(--bar)] backdrop-blur-2xl backdrop-saturate-150 md:block">
      <div className="mx-auto flex h-[68px] max-w-[1180px] items-center gap-6 px-10">
        <Link to="/app" aria-label={tb.home} className="shrink-0 rounded-[10px]">
          <Logo size={32} />
        </Link>
        <nav aria-label={tb.label} className="flex items-center gap-1">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                `rounded-full px-4 py-2 font-semibold transition-colors duration-200 ${isActive ? 'glass-strong text-ink' : 'border border-transparent text-ink-2 hover:text-ink'}`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <span className="flex-1" />
        <MoveMenu />
        <Link to="/app/scan" aria-label={tb.scan} title={tb.scan} className="btn btn-orb btn-icon">
          <Icon name="scan" size={20} />
        </Link>
        <Link to="/app/me" aria-label={tb.me} title={tb.me} className="rounded-full">
          <Avatar size={40} />
        </Link>
      </div>
    </header>
  );
}

/** "Move money": a button that opens the list of money moves under it. */
function MoveMenu() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        className="btn btn-ink"
        aria-expanded={open}
        aria-controls="move-menu"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="swap" size={18} strokeWidth={2.2} />
        {t.app.move.label}
        <Icon
          name="chevron"
          size={16}
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div
          id="move-menu"
          className="absolute top-[calc(100%+10px)] right-0 z-40 w-[380px] rounded-[24px] border border-[var(--glass-rim)] bg-[var(--glass-dialog)] p-3 shadow-[inset_0_1px_0_var(--glass-hi),var(--shadow-float)] backdrop-blur-2xl backdrop-saturate-150"
        >
          <p className="px-2 pt-1 pb-3 text-[0.875rem] font-semibold text-ink-3">
            {t.app.move.title}
          </p>
          <MoveList onPick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** A screen: its header and its body.
    - Phone: a screen you came to (`back`) has a top bar with back, its title and an optional
      action; a tab screen has its title in the frame's top bar, so its own header is for a
      tablet up only.
    - Tablet and up: a page header (back as a link above a large title), up to 720px wide for a
      form (`width="form"`, the default) or 1180px for a page with columns (`width="page"`).
    - A flow (`steps`) shows where it is: a progress bar with "Step 2 of 3" on a phone, a step
      rail beside the form from a tablet up.
    - A form with an `aside` (the wallet's balance) shows it beside the form from 1280px. */
export function Screen({
  title,
  back,
  action,
  children,
  wide = false,
  width = 'form',
  aside,
  steps,
}: {
  title?: ReactNode;
  /* Where back goes: a path, or true for the previous screen. */
  back?: string | true;
  action?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  width?: 'form' | 'page';
  aside?: ReactNode;
  /* The flow's steps and the one on screen (from 0). */
  steps?: { labels: string[]; current: number };
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
  const pad = wide ? '' : 'px-5 md:px-10';
  const maxWidth =
    width === 'page'
      ? 'md:max-w-[1180px]'
      : steps
        ? aside
          ? 'md:max-w-[960px] xl:max-w-[1180px]'
          : 'md:max-w-[960px]'
        : aside
          ? 'md:max-w-[720px] xl:max-w-[1120px]'
          : 'md:max-w-[720px]';
  const hasHeader = !!(title || back || action);
  // A tab screen has its name in the frame's top bar on a phone.
  const isTab = TAB_PATHS.includes(clean(location.pathname));
  const body = aside ? (
    <div className="flex flex-1 flex-col xl:grid xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start xl:gap-10">
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      <aside className="hidden xl:sticky xl:top-24 xl:block">{aside}</aside>
    </div>
  ) : (
    children
  );
  return (
    <div className={`flex flex-1 flex-col md:mx-auto md:w-full md:pb-8 ${maxWidth}`}>
      {/* Phone: the top bar of a screen you came to (back, its title, an action). */}
      {!isTab && hasHeader && (
        <div className="sticky top-0 z-20 flex h-[60px] items-center gap-2 border-b border-[var(--glass-rim)] bg-[var(--bar)] px-3 backdrop-blur-2xl backdrop-saturate-150 md:hidden">
          {back ? (
            <button
              type="button"
              className="btn btn-quiet btn-icon"
              onClick={goBack}
              aria-label={t.app.back}
            >
              <Icon name="back" size={22} />
            </button>
          ) : (
            <span className="w-11" />
          )}
          <h1 className="min-w-0 flex-1 truncate text-center text-[1.0625rem]">{title}</h1>
          <span className="flex min-w-11 justify-end">{action}</span>
        </div>
      )}
      {steps && <StepBar steps={steps} />}
      {/* Tablet and up: the page header. */}
      {hasHeader && (
        <header className={`hidden flex-col gap-3 pt-10 pb-6 md:flex ${wide ? 'px-10' : pad}`}>
          {back && (
            <button
              type="button"
              className="inline-flex items-center gap-1 self-start text-[0.9375rem] font-semibold text-ink-3 transition-colors hover:text-ink"
              onClick={goBack}
            >
              <Icon name="back" size={16} />
              {t.app.back}
            </button>
          )}
          <div className="flex items-end gap-4">
            {title && <h1 className="flex-1 text-[2.25rem] leading-tight">{title}</h1>}
            {!title && <span className="flex-1" />}
            {action}
          </div>
        </header>
      )}
      {isTab && hasHeader && <div className="h-2 md:hidden" />}
      {steps ? (
        <div
          className={`flex flex-1 flex-col pt-5 md:grid md:grid-cols-[12rem_minmax(0,1fr)] md:gap-10 md:pt-0 ${pad}`}
        >
          <StepRail steps={steps} />
          <div className="flex min-w-0 flex-1 flex-col">{body}</div>
        </div>
      ) : (
        <div className={`flex flex-1 flex-col ${isTab ? '' : 'pt-5 md:pt-0'} ${pad}`}>{body}</div>
      )}
    </div>
  );
}

/** The flow's progress on a phone: one segment per step, and "Step 2 of 3 · Amount". */
function StepBar({ steps }: { steps: { labels: string[]; current: number } }) {
  const { t } = useI18n();
  const { labels, current } = steps;
  return (
    <div className="px-5 pt-4 md:hidden">
      <div className="flex gap-1.5" aria-hidden="true">
        {labels.map((l, i) => (
          <span
            key={l}
            className={`h-1 flex-1 rounded-full ${i <= current ? 'bg-primary' : 'bg-line-2'}`}
          />
        ))}
      </div>
      <p className="mt-2 text-[0.8125rem] font-semibold text-ink-3">
        {fmt(t.app.stepOf, { n: current + 1, total: labels.length })} · {labels[current]}
      </p>
    </div>
  );
}

/** The flow's steps beside the form, from a tablet up: the current one marked on the line. */
function StepRail({ steps }: { steps: { labels: string[]; current: number } }) {
  const { t } = useI18n();
  return (
    <ol
      className="hidden flex-col gap-1 md:sticky md:top-24 md:flex md:self-start"
      aria-label={t.app.steps}
    >
      {steps.labels.map((l, i) => {
        const now = i === steps.current;
        const done = i < steps.current;
        return (
          <li
            key={l}
            aria-current={now ? 'step' : undefined}
            className={`flex items-center gap-2.5 border-l-2 py-2 pl-3.5 text-[0.9375rem] ${now ? 'border-primary font-semibold text-ink' : done ? 'border-line-2 text-ink-2' : 'border-line text-ink-3'}`}
          >
            {done && <Icon name="check" size={15} strokeWidth={2.6} className="text-ok" />}
            {l}
          </li>
        );
      })}
    </ol>
  );
}

/** An action on the home's balance card (send, receive, add, withdraw): a glass chip with its
    glyph and its name. */
export function ActionTile({ to, icon, label }: { to: string; icon: IconName; label: string }) {
  return (
    <NavLink
      to={to}
      className="glass glass-hover flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-[0.9375rem] font-semibold whitespace-nowrap"
    >
      <Icon name={icon} size={17} strokeWidth={2.2} />
      {label}
    </NavLink>
  );
}
