/* The merchant / business dashboard (/dashboard/*): signed in with a Stellar wallet (SEP-10),
   scoped to one organization and one tier (test or live). A sticky top header: the bar (logo,
   organization, tier, account), the groups as pills and the active group's sections as tabs; on
   phones the bar folds into a menu. The market views, charges and payouts, the developer tools
   and the team. */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router';
import { useDocumentMeta, useI18n } from '@/i18n';
import { sessionGate, useSession } from '@/lib/session';
import { orgs as orgsApi } from '@/lib/api/endpoints';
import { errorMessage } from '@/lib/api/messages';
import { Logo } from '@/components/ui/Logo';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Field, Notice, Spinner } from '@/components/ui/controls';
import { Address } from '@/components/ui/misc';
import { useToast } from '@/components/ui/Toast';
import { SignIn } from '@/components/wallet/SignIn';
import { LangToggle, ThemeToggle } from '@/components/layout/SiteFrame';
import { DashProvider, useDash } from '@/features/dashboard/context';
import { OverviewView } from '@/features/dashboard/views/OverviewView';
import { LiquidityView } from '@/features/dashboard/views/LiquidityView';
import { OffersView } from '@/features/dashboard/views/OffersView';
import { MethodsView } from '@/features/dashboard/views/MethodsView';
import { OrdersView } from '@/features/dashboard/views/OrdersView';
import { ChargesView } from '@/features/dashboard/views/ChargesView';
import { PayoutsView } from '@/features/dashboard/views/PayoutsView';
import { KeysView } from '@/features/dashboard/views/KeysView';
import { WebhooksView } from '@/features/dashboard/views/WebhooksView';
import { TeamView } from '@/features/dashboard/views/TeamView';
import { useGuard } from '@/lib/use-action';

type Section = {
  path: string;
  key: keyof ReturnType<typeof useI18n>['t']['dash']['nav'];
  icon: IconName;
};
type Group = { key: 'market' | 'money' | 'developers' | 'org'; icon: IconName; items: Section[] };
const GROUPS: Group[] = [
  {
    key: 'market',
    icon: 'grid',
    items: [
      { path: 'overview', key: 'overview', icon: 'grid' },
      { path: 'liquidity', key: 'liquidity', icon: 'coins' },
      { path: 'offers', key: 'offers', icon: 'tag' },
      { path: 'methods', key: 'methods', icon: 'bank' },
      { path: 'orders', key: 'orders', icon: 'list' },
    ],
  },
  {
    key: 'money',
    icon: 'wallet',
    items: [
      { path: 'charges', key: 'charges', icon: 'qr' },
      { path: 'payouts', key: 'payouts', icon: 'send' },
    ],
  },
  {
    key: 'developers',
    icon: 'key',
    items: [
      { path: 'keys', key: 'keys', icon: 'key' },
      { path: 'webhooks', key: 'webhooks', icon: 'hook' },
    ],
  },
  { key: 'org', icon: 'users', items: [{ path: 'team', key: 'team', icon: 'users' }] },
];

/** The group the current path is in (the market when no section matches, as the routes send
    an unknown path to the overview). */
function groupOf(pathname: string): Group {
  const path = pathname.replace(/^\/dashboard\/?/, '').split('/')[0];
  return GROUPS.find((g) => g.items.some((s) => s.path === path)) ?? GROUPS[0];
}

/* The header's glass bar, and the width every row of the shell shares with the content. */
const BAR =
  'border-b border-[var(--glass-rim)] bg-[var(--bar)] shadow-[inset_0_-1px_0_var(--line)] backdrop-blur-2xl backdrop-saturate-150';
const WIDTH = 'mx-auto w-full max-w-6xl px-5 sm:px-6 lg:px-8';

export default function DashboardApp() {
  const { t } = useI18n();
  useDocumentMeta(t.dash.metaTitle);
  const auth = useSession();
  const { session, refresh } = auth;
  const gate = sessionGate(auth);
  if (gate === 'loading')
    return (
      <div className="flex min-h-dvh items-center justify-center gap-3 text-ink-3" role="status">
        <Spinner />
        {t.dash.state.loading}
      </div>
    );
  // Without a session, or one that could not be renewed silently: the sign-in.
  if (gate === 'signin' || !session) return <SignInGate />;
  if (!session.organizations.length) return <CreateOrg onCreated={() => void refresh()} />;
  return (
    <DashProvider orgs={session.organizations}>
      <Shell />
    </DashProvider>
  );
}

function Bare({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4 sm:px-8">
        <Link to="/" aria-label={t.common.nav.home}>
          <Logo />
        </Link>
        <div className="flex items-center gap-1">
          <LangToggle />
          <ThemeToggle />
        </div>
      </header>
      <main
        id="main"
        className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 pb-24"
      >
        {children}
      </main>
    </div>
  );
}

function SignInGate() {
  const { t } = useI18n();
  return (
    <Bare>
      <div className="sheet mx-auto flex w-full max-w-md flex-col gap-2 p-6 sm:p-8">
        <h1 className="text-[1.75rem]">{t.dash.signIn.title}</h1>
        <p className="mb-4 text-ink-2">{t.dash.signIn.body}</p>
        <SignIn variant="dashboard" mode="signin" />
        <Link to="/" className="btn btn-quiet mt-2 self-center">
          {t.dash.signIn.back}
        </Link>
      </div>
    </Bare>
  );
}

function CreateOrg({ onCreated }: { onCreated: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const valid = name.trim().length >= 2 && name.trim().length <= 60;
  const guard = useGuard();
  return (
    <Bare>
      <form
        className="sheet flex flex-col gap-4 p-6 sm:p-8"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!valid) return;
          // One organization per tap: a second submit while it is being made is dropped.
          void guard(async () => {
            setBusy(true);
            setError('');
            try {
              await orgsApi.create(name.trim());
              toast(t.dash.orgs.created);
              onCreated();
            } catch (err) {
              setError(errorMessage(t.common, err));
            } finally {
              setBusy(false);
            }
          });
        }}
      >
        <h1 className="text-[1.75rem]">{t.dash.orgs.createTitle}</h1>
        <p className="text-ink-2">{t.dash.orgs.createBody}</p>
        <Field
          label={t.dash.orgs.name}
          value={name}
          placeholder={t.dash.orgs.namePlaceholder}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched(true)}
          error={touched && !valid ? t.dash.orgs.nameError : null}
          maxLength={60}
        />
        <button type="submit" className="btn btn-ink btn-lg" disabled={busy}>
          {busy && <Spinner />}
          {busy ? t.dash.orgs.creating : t.dash.orgs.create}
        </button>
        {error && <Notice tone="error">{error}</Notice>}
      </form>
    </Bare>
  );
}

function Shell() {
  const { t } = useI18n();
  const d = t.dash;
  const { tier } = useDash();
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  const group = groupOf(loc.pathname);
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-[10px] focus:bg-ink focus:px-4 focus:py-2 focus:text-on-ink"
      >
        {t.common.skip}
      </a>
      <header className={`sticky top-0 z-30 ${BAR}`}>
        <div className={`${WIDTH} flex h-16 items-center gap-3 xl:gap-4`}>
          <Link to="/" aria-label={t.common.nav.home} className="shrink-0 rounded-[10px]">
            <Logo />
          </Link>
          <div className="hidden min-w-0 items-center gap-3 lg:flex xl:gap-4">
            <span aria-hidden="true" className="h-6 w-px shrink-0 bg-line" />
            <OrgSwitch id="dash-org" compact />
            <TierSwitch id="dash-tier" compact />
          </div>
          <div className="ml-auto hidden shrink-0 items-center gap-1 lg:flex">
            <Account compact />
            <span aria-hidden="true" className="mx-1.5 h-6 w-px bg-line" />
            <LangToggle />
            <ThemeToggle />
            <Link to="/" className="btn btn-quiet btn-sm px-2.5">
              <Icon name="home" size={18} className="xl:hidden" />
              <span className="sr-only xl:not-sr-only">{d.nav.site}</span>
            </Link>
          </div>
          <button
            type="button"
            className="btn btn-quiet btn-sm ml-auto px-2 lg:hidden"
            aria-expanded={menu}
            aria-controls="dash-menu"
            aria-label={menu ? d.nav.close : d.nav.menu}
            onClick={() => setMenu((m) => !m)}
          >
            <Icon name={menu ? 'close' : 'menu'} />
          </button>
        </div>
        {menu && (
          <div
            id="dash-menu"
            className="max-h-[calc(100dvh-4rem)] overflow-y-auto border-t border-line lg:hidden"
          >
            <MenuPanel group={group} />
          </div>
        )}
        <nav aria-label={d.nav.label} className="hidden border-t border-line md:block">
          <div className={WIDTH}>
            <ul
              className="-mx-1 flex gap-1.5 overflow-x-auto px-1 py-2 [scrollbar-width:none]"
              role="list"
            >
              {GROUPS.map((g) => {
                const on = g.key === group.key;
                return (
                  <li key={g.key} className="shrink-0">
                    <Link
                      to={`/dashboard/${g.items[0].path}`}
                      aria-current={on ? 'true' : undefined}
                      className={`inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-full border px-3.5 text-[0.875rem] font-semibold transition-colors ${on ? 'glass-strong text-ink' : 'border-transparent text-ink-2 hover:bg-well hover:text-ink'}`}
                    >
                      <Icon name={g.icon} size={16} />
                      {d.nav.groups[g.key]}
                    </Link>
                  </li>
                );
              })}
            </ul>
            <ul className="flex gap-6 overflow-x-auto [scrollbar-width:none]" role="list">
              {group.items.map((s) => (
                <li key={s.path} className="shrink-0">
                  <NavLink
                    to={`/dashboard/${s.path}`}
                    className={({ isActive }) =>
                      `inline-flex h-11 items-center whitespace-nowrap border-b-2 text-[0.9375rem] font-semibold transition-colors focus-visible:-outline-offset-2 ${isActive ? 'border-primary text-ink' : 'border-transparent text-ink-2 hover:border-line-2 hover:text-ink'}`
                    }
                  >
                    {d.nav[s.key] as string}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        </nav>
      </header>
      {tier === 'test' && (
        <div className="border-b border-line bg-warn-soft">
          <p className={`${WIDTH} py-2 text-[0.875rem] font-semibold text-warn`}>
            {d.tier.testBanner}
          </p>
        </div>
      )}
      <main id="main" className={`${WIDTH} flex-1 py-8`}>
        <Routes>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewView />} />
          <Route path="liquidity" element={<LiquidityView />} />
          <Route path="offers" element={<OffersView />} />
          <Route path="methods" element={<MethodsView />} />
          <Route path="orders" element={<OrdersView />} />
          <Route path="charges" element={<ChargesView />} />
          <Route path="payouts" element={<PayoutsView />} />
          <Route path="keys" element={<KeysView />} />
          <Route path="webhooks" element={<WebhooksView />} />
          <Route path="team" element={<TeamView />} />
          <Route path="*" element={<Navigate to="overview" replace />} />
        </Routes>
      </main>
    </div>
  );
}

/** The menu under the bar below lg: the organization and the tier, every group with its
    sections (on phones; from md up the tabs show them), then the account and the site's
    toggles. */
function MenuPanel({ group }: { group: Group }) {
  const { t } = useI18n();
  const d = t.dash;
  return (
    <div className={`${WIDTH} flex flex-col gap-5 py-5`}>
      <div className="grid gap-4 sm:grid-cols-2">
        <OrgSwitch id="dash-org-menu" />
        <TierSwitch id="dash-tier-menu" />
      </div>
      <nav aria-label={d.nav.label} className="flex flex-col gap-4 md:hidden">
        {GROUPS.map((g) => (
          <div key={g.key} className="flex flex-col gap-2">
            <p
              className={`caps flex items-center gap-1.5 ${g.key === group.key ? 'text-ink' : 'text-ink-3'}`}
            >
              <Icon name={g.icon} size={14} />
              {d.nav.groups[g.key]}
            </p>
            <ul className="flex flex-wrap gap-2" role="list">
              {g.items.map((s) => (
                <li key={s.path}>
                  <NavLink
                    to={`/dashboard/${s.path}`}
                    className={({ isActive }) =>
                      `inline-flex min-h-10 items-center gap-2 rounded-full border px-3.5 text-[0.9375rem] font-semibold transition-colors ${isActive ? 'glass-strong text-ink' : 'border-line text-ink-2 hover:bg-well hover:text-ink'}`
                    }
                  >
                    <Icon name={s.icon} size={16} />
                    {d.nav[s.key] as string}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <Account />
        <div className="flex items-center gap-1">
          <LangToggle />
          <ThemeToggle />
          <Link to="/" className="btn btn-quiet btn-sm ml-auto px-2.5">
            {d.nav.site}
          </Link>
        </div>
      </div>
    </div>
  );
}

/** The organization switcher: a compact one in the bar, a full-width one in the menu. */
function OrgSwitch({ id, compact = false }: { id: string; compact?: boolean }) {
  const { t } = useI18n();
  const d = t.dash;
  const { org, orgs, setOrg } = useDash();
  return (
    <div className={compact ? 'flex min-w-0 items-center gap-2' : 'flex flex-col gap-1.5'}>
      <label
        htmlFor={id}
        className={
          compact ? 'caps shrink-0 text-ink-3' : 'px-1 text-[0.8125rem] font-semibold text-ink-3'
        }
      >
        {d.orgs.label}
      </label>
      <select
        id={id}
        className={
          compact
            ? 'field min-h-9 w-auto min-w-0 max-w-[15rem] rounded-full py-1.5 pl-3.5 text-[0.875rem]'
            : 'field min-h-11 py-2'
        }
        value={org.id}
        onChange={(e) => setOrg(e.target.value)}
      >
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} ({d.orgs.roles[o.role]})
          </option>
        ))}
      </select>
    </div>
  );
}

/** Test or live. In the bar the two segments say it and the label is for assistive tech only
    (the bar keeps its room for the organization's name). */
function TierSwitch({ id, compact = false }: { id: string; compact?: boolean }) {
  const { t } = useI18n();
  const d = t.dash;
  const { tier, setTier } = useDash();
  return (
    <div className={compact ? 'shrink-0' : 'flex flex-col gap-1.5'}>
      <span
        id={id}
        className={compact ? 'sr-only' : 'px-1 text-[0.8125rem] font-semibold text-ink-3'}
      >
        {d.tier.label}
      </span>
      <div className="seg" role="group" aria-labelledby={id}>
        {(['test', 'live'] as const).map((x) => (
          <button
            key={x}
            type="button"
            aria-pressed={tier === x}
            onClick={() => setTier(x)}
            className={compact ? 'min-h-8 px-3.5 text-[0.875rem]' : undefined}
          >
            {d.tier[x]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The signed-in wallet and its sign-out: a glass chip in the bar, a row in the menu. */
function Account({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { session, signOut } = useSession();
  if (!session) return null;
  return (
    <div
      className={`flex items-center gap-2 ${compact ? 'glass rounded-full py-1 pr-1 pl-3' : 'justify-between'}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon name="wallet" size={16} className="shrink-0 text-ink-3" />
        <Address value={session.address} />
      </span>
      <button
        type="button"
        className={`btn btn-quiet btn-sm px-3 ${compact ? 'min-h-8' : ''}`}
        onClick={() => void signOut()}
      >
        {t.common.wallet.signOut}
      </button>
    </div>
  );
}
