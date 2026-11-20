/* Me: the @handle (change it), the address with copy, the network and wallet, local currency,
   language, theme, installing the app, the wallet provider's recovery and export (Pollar, when the
   wallet has them), the merchants' dashboard, and sign out. */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { LogoGlyph } from '@/components/ui/Logo';
import { CopyRow } from '@/components/ui/misc';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { LangToggle, ThemeToggle } from '@/components/layout/SiteFrame';
import { currencyName, shortAddress } from '@/lib/format';
import { install, usePwa } from '@/lib/pwa';
import { isQrRail } from '@/lib/p2p/qr-pay';
import { useSession } from '@/lib/session';
import { useAppData } from '@/features/app/data';
import { Screen } from '@/features/app/shell';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[56px] items-center justify-between gap-4 py-2">
      <span className="text-ink-2">{label}</span>
      <span className="flex items-center gap-2 text-right font-semibold">{children}</span>
    </div>
  );
}

export default function Me() {
  const { t, lang } = useI18n();
  const m = t.app.me;
  const navigate = useNavigate();
  const { session, wallet, signOut } = useSession();
  const { profile, network, market, currency, setCurrency } = useAppData();
  const pwa = usePwa();
  const [leaving, setLeaving] = useState(false);
  const currencies = (market?.currencies ?? []).filter((c) => c.rails.some((r) => !isQrRail(r)));

  return (
    <Screen title={m.title}>
      <div className="flex flex-col gap-5 pb-6">
        {/* Who I am, as a wallet card: the aura from ice to night. */}
        <section className="tone-dark aura-card grain flex min-h-[208px] flex-col overflow-hidden rounded-[24px] p-5 text-ink shadow-[var(--shadow-float)]">
          <div className="flex items-start justify-between gap-3">
            <span
              className="grid size-12 shrink-0 place-items-center rounded-full bg-white text-[1.25rem] font-bold text-[#0a0b0e] uppercase"
              aria-hidden="true"
            >
              {profile?.handle ? (
                profile.handle.slice(0, 1)
              ) : (
                <Icon name="user" size={20} strokeWidth={2.2} />
              )}
            </span>
            <Link to="/app/handle" className="btn btn-white btn-sm">
              {profile?.handle ? m.change : m.choose}
            </Link>
          </div>
          <div className="mt-auto pt-10">
            <p className="text-[0.8125rem] text-ink-2">{m.handle}</p>
            <p className="truncate text-[1.6rem] leading-tight font-semibold tracking-[-0.02em]">
              {profile?.handle ? `@${profile.handle}` : m.noHandle}
            </p>
            <div className="mt-2 flex items-center justify-between gap-3 text-ink-2">
              <span className="num text-[0.9375rem]">
                {session ? shortAddress(session.address) : ''}
              </span>
              <LogoGlyph size={22} className="text-ink" />
            </div>
          </div>
        </section>

        <div className="sheet divide-y divide-line px-4">
          {session && <CopyRow label={m.address} value={session.address} />}
          <Row label={m.network}>{network?.name ?? '-'}</Row>
          <Row label={m.wallet}>{wallet?.label ?? '-'}</Row>
        </div>

        <div className="sheet divide-y divide-line px-4">
          <Row label={m.currency}>
            <select
              className="field min-h-[44px] w-auto py-2"
              aria-label={m.currency}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} · {currencyName(c.code, lang)}
                </option>
              ))}
            </select>
          </Row>
          <Row label={m.language}>
            <LangToggle />
          </Row>
          <Row label={m.theme}>
            <ThemeToggle />
          </Row>
        </div>

        <section className="sheet px-4 py-3">
          <h2 className="text-[1.05rem]">{m.install}</h2>
          {pwa.installed ? (
            <p className="mt-1 text-ink-3">{m.installed}</p>
          ) : pwa.canInstall ? (
            <>
              <p className="mt-1 text-ink-3">{m.installBody}</p>
              <button type="button" className="btn btn-ink mt-3" onClick={() => void install()}>
                <Icon name="download" size={18} />
                {t.app.pwa.install}
              </button>
            </>
          ) : (
            <p className="mt-1 text-ink-3">{pwa.iosHint ? m.iosHint : m.installBody}</p>
          )}
        </section>

        {wallet?.openRecovery && (
          <button
            type="button"
            className="sheet flex min-h-[64px] items-center gap-3 px-4 text-left hover:border-ink"
            onClick={wallet.openRecovery}
          >
            <Icon name="key" size={22} />
            <span className="flex flex-1 flex-col">
              <b>{m.recovery}</b>
              <span className="text-[0.875rem] text-ink-3">{m.recoveryBody}</span>
            </span>
            <Icon name="chevronRight" size={18} />
          </button>
        )}

        <Link
          to="/dashboard"
          className="sheet flex min-h-[56px] items-center gap-3 px-4 hover:border-ink"
        >
          <Icon name="grid" size={22} />
          <span className="flex-1 font-semibold">{m.dashboard}</span>
          <Icon name="chevronRight" size={18} />
        </Link>

        <button
          type="button"
          className="btn btn-line btn-lg text-bad"
          onClick={() => setLeaving(true)}
        >
          {m.signOut}
        </button>
      </div>
      {leaving && (
        <ConfirmDialog
          title={m.signOut}
          body={fmt(m.signOutConfirm, { brand: t.common.brand })}
          confirmLabel={m.signOut}
          danger
          onConfirm={async () => {
            await signOut();
            setLeaving(false);
            navigate('/app', { replace: true });
          }}
          onClose={() => setLeaving(false)}
        />
      )}
    </Screen>
  );
}
