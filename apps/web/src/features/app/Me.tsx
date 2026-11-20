/* Me: the @handle (change it), the address with copy, the network and wallet, local currency,
   language, theme, installing the app, the wallet provider's recovery and export (Pollar, when the
   wallet has them), the merchants' dashboard, and sign out. */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { CopyRow } from '@/components/ui/misc';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { LangToggle, ThemeToggle } from '@/components/layout/SiteFrame';
import { currencyName } from '@/lib/format';
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
        <section className="flex items-center gap-4 rounded-[20px] border border-line bg-sheet p-4">
          <span className="grid size-14 shrink-0 place-items-center rounded-full bg-ink text-[1.5rem] font-bold text-on-ink uppercase" aria-hidden="true">
            {(profile?.handle ?? 'u').slice(0, 1)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[0.8125rem] text-ink-3">{m.handle}</p>
            <p className="truncate text-[1.25rem] font-bold">{profile?.handle ? `@${profile.handle}` : m.noHandle}</p>
          </div>
          <Link to="/app/handle" className="btn btn-line btn-sm">
            {profile?.handle ? m.change : m.choose}
          </Link>
        </section>

        <div className="divide-y divide-line rounded-[18px] bg-well px-4">
          {session && <CopyRow label={m.address} value={session.address} />}
          <Row label={m.network}>{network?.name ?? '-'}</Row>
          <Row label={m.wallet}>{wallet?.label ?? '-'}</Row>
        </div>

        <div className="divide-y divide-line rounded-[18px] border border-line px-4">
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

        <section className="rounded-[18px] border border-line px-4 py-3">
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
            className="flex min-h-[64px] items-center gap-3 rounded-[18px] border border-line px-4 text-left hover:border-ink"
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

        <Link to="/dashboard" className="flex min-h-[56px] items-center gap-3 rounded-[18px] border border-line px-4 hover:border-ink">
          <Icon name="grid" size={22} />
          <span className="flex-1 font-semibold">{m.dashboard}</span>
          <Icon name="chevronRight" size={18} />
        </Link>

        <button type="button" className="btn btn-line btn-lg text-bad" onClick={() => setLeaving(true)}>
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
