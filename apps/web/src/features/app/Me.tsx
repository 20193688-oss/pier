/* Me: who you are at the top (your initial, your @handle with a way to change it, your short
   address), then grouped settings: your wallet (the address with copy, the network, the wallet
   provider), your preferences (local currency with its flag, language, theme) and the app
   (installing it, the wallet provider's recovery and export when it has them, the merchants'
   dashboard); sign out at the end. */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { CopyRow } from '@/components/ui/misc';
import { CurrencyMark } from '@/components/p2p/parts';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { LangToggle, ThemeToggle } from '@/components/layout/SiteFrame';
import { shortAddress } from '@/lib/format';
import { install, usePwa } from '@/lib/pwa';
import { useSession } from '@/lib/session';
import { useAppData } from '@/features/app/data';
import { Screen } from '@/features/app/shell';
import { useCurrencyPicker } from '@/features/app/parts';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[56px] items-center justify-between gap-4 py-2">
      <span className="text-ink-2">{label}</span>
      <span className="flex items-center gap-2 text-right font-semibold">{children}</span>
    </div>
  );
}

/** A group of settings under its name. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="caps px-1 text-ink-3">{title}</h2>
      <div className="sheet divide-y divide-line px-5">{children}</div>
    </section>
  );
}

/** A settings row that opens something. */
function LinkRow({
  icon,
  title,
  sub,
  ...rest
}: { icon: React.ComponentProps<typeof Icon>['name']; title: string; sub?: string } & (
  { to: string; onClick?: never } | { to?: never; onClick: () => void }
)) {
  const inner = (
    <>
      <span className="icon-tile size-9" aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <b className="font-semibold">{title}</b>
        {sub && <span className="text-[0.875rem] text-ink-3">{sub}</span>}
      </span>
      <Icon name="chevronRight" size={18} className="chev shrink-0 text-ink-3" />
    </>
  );
  const cls =
    'lift -mx-5 flex min-h-[64px] w-[calc(100%+2.5rem)] items-center gap-3 px-5 py-2 text-left';
  return 'to' in rest && rest.to ? (
    <Link to={rest.to} className={cls}>
      {inner}
    </Link>
  ) : (
    <button type="button" className={cls} onClick={rest.onClick}>
      {inner}
    </button>
  );
}

export default function Me() {
  const { t } = useI18n();
  const m = t.app.me;
  const navigate = useNavigate();
  const { session, wallet, signOut } = useSession();
  const { profile, network } = useAppData();
  const pwa = usePwa();
  const [leaving, setLeaving] = useState(false);
  const picker = useCurrencyPicker();

  return (
    <Screen title={m.title}>
      <div className="flex flex-col gap-7 pb-6">
        <section
          className="flex flex-col items-center gap-3 pt-2 text-center"
          aria-label={m.handle}
        >
          <span
            className="glass-strong grid size-[84px] place-items-center rounded-full text-[2.25rem] font-semibold text-ink uppercase"
            aria-hidden="true"
          >
            {profile?.handle ? (
              profile.handle.slice(0, 1)
            ) : (
              <Icon name="user" size={34} strokeWidth={2} />
            )}
          </span>
          <div>
            <p className="truncate text-[1.75rem] leading-tight font-semibold tracking-[-0.02em]">
              {profile?.handle ? `@${profile.handle}` : m.noHandle}
            </p>
            <p className="num mt-1 text-[0.9375rem] text-ink-3">
              {session ? shortAddress(session.address) : ''}
            </p>
          </div>
          <Link to="/app/handle" className="btn btn-line btn-sm">
            {profile?.handle ? m.changeHandle : m.chooseHandle}
          </Link>
        </section>

        <Group title={m.groups.wallet}>
          {session && <CopyRow label={m.address} value={session.address} />}
          <Row label={m.network}>{network?.name ?? '-'}</Row>
          <Row label={m.wallet}>{wallet?.label ?? '-'}</Row>
        </Group>

        <Group title={m.groups.preferences}>
          <Row label={m.currency}>
            <button
              type="button"
              className="flex items-center gap-2 rounded-full border border-line py-1.5 pr-3 pl-1.5 transition-[border-color,transform] duration-200 hover:border-line-2 active:scale-[0.97]"
              onClick={picker.open}
              aria-haspopup="dialog"
              aria-label={picker.label}
              disabled={picker.choices < 2}
            >
              <CurrencyMark code={picker.currency} size={26} />
              <span>{picker.currency}</span>
              {picker.choices > 1 && <Icon name="chevron" size={16} />}
            </button>
          </Row>
          <Row label={m.language}>
            <LangToggle />
          </Row>
          <Row label={m.theme}>
            <ThemeToggle />
          </Row>
        </Group>

        <Group title={m.groups.app}>
          <div className="flex flex-col gap-1 py-4">
            <b className="font-semibold">{m.install}</b>
            {pwa.installed ? (
              <p className="text-[0.9375rem] text-ink-3">{m.installed}</p>
            ) : pwa.canInstall ? (
              <>
                <p className="text-[0.9375rem] text-ink-3">{m.installBody}</p>
                <button
                  type="button"
                  className="btn btn-ink btn-sm mt-2 self-start"
                  onClick={() => void install()}
                >
                  <Icon name="download" size={16} />
                  {t.app.pwa.install}
                </button>
              </>
            ) : (
              <p className="text-[0.9375rem] text-ink-3">
                {pwa.iosHint ? m.iosHint : m.installBody}
              </p>
            )}
          </div>
          {wallet?.openRecovery && (
            <LinkRow
              icon="key"
              title={m.recovery}
              sub={m.recoveryBody}
              onClick={wallet.openRecovery}
            />
          )}
          <LinkRow icon="grid" title={m.dashboard} to="/dashboard" />
        </Group>

        <button
          type="button"
          className="btn btn-line btn-lg text-bad"
          onClick={() => setLeaving(true)}
        >
          {m.signOut}
        </button>
      </div>
      {picker.sheet}
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
