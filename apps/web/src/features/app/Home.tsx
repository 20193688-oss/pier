/* Home: the balance in dollars and in local money, the four actions (send, receive, add money,
   withdraw), the scan button, a banner when the wallet needs activation, and the latest movements. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { Notice, Skeleton } from '@/components/ui/controls';
import { figureSize } from '@/components/ui/misc';
import { app } from '@/lib/api/app';
import { decimalsFrom } from '@/lib/p2p/normalize';
import { useSession } from '@/lib/session';
import { useAppData } from '@/features/app/data';
import { ActionTile } from '@/features/app/shell';
import { ActivationCard, ActivityRow, InstallBanner, useLocal, useUsd } from '@/features/app/parts';
import type { ActivityItem } from '@/lib/app/types';

const HIDE_KEY = 'pedospe.app.hide-balance';

export default function Home() {
  const { t } = useI18n();
  const h = t.app.home;
  const { session } = useSession();
  const { market, network, profile, balances, balance, needsActivation, currency, price, offline, refresh } =
    useAppData();
  const fmtUsd = useUsd();
  const local = useLocal();
  const [items, setItems] = useState<ActivityItem[] | null | undefined>(undefined);
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDE_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!network || !session) return;
    let alive = true;
    app
      .activity(network.id, { limit: 5 }, decimalsFrom(market))
      .then((p) => alive && setItems(p.items))
      .catch(() => alive && setItems(null));
    return () => {
      alive = false;
    };
  }, [network, session, market, balances]);

  const toggleHidden = () => {
    setHidden((v) => {
      try {
        localStorage.setItem(HIDE_KEY, v ? '0' : '1');
      } catch {
        /* this page only */
      }
      return !v;
    });
  };

  const amountText = fmtUsd(balance);
  const localText = local(balance);
  return (
    <div className="flex flex-1 flex-col gap-5 px-4 pt-4">
      <header className="flex items-center justify-between gap-3">
        <p className="truncate text-[1.0625rem] font-semibold">
          {profile?.handle ? fmt(h.greeting, { handle: profile.handle }) : h.greetingNoHandle}
        </p>
        <button type="button" className="btn btn-quiet size-11 px-0" onClick={refresh} aria-label={t.common.actions.retry}>
          <Icon name="refresh" size={20} />
        </button>
      </header>

      <section className="sheet px-5 pt-5 pb-4" aria-labelledby="balance-h">
        <div className="flex items-center justify-between">
          <h2 id="balance-h" className="text-[0.9375rem] font-semibold text-ink-3" style={{ fontStretch: '100%' }}>
            {h.balance}
          </h2>
          <button type="button" className="btn btn-quiet btn-sm -mr-2 px-2" onClick={toggleHidden} aria-label={hidden ? h.show : h.hide} aria-pressed={hidden}>
            <Icon name={hidden ? 'eye' : 'eyeOff'} size={18} />
          </button>
        </div>
        {balances === undefined ? (
          <Skeleton className="mt-2 h-12 w-2/3" />
        ) : (
          <p className={`figure mt-2 ${figureSize(amountText)}`} data-testid="balance" aria-live="polite">
            {hidden ? <span aria-label={h.balanceHidden}>••••</span> : amountText}
          </p>
        )}
        <p className="num mt-1.5 min-h-[1.5em] text-ink-3">
          {hidden ? '' : (localText ?? (balances && price === null ? fmt(h.noRate, { currency }) : ''))}
        </p>
      </section>

      {balances === null && <Notice tone="error">{offline ? t.app.pwa.offline : h.loadError}</Notice>}
      {needsActivation && <ActivationCard />}
      {profile && !profile.handle && (
        <Link to="/app/handle" className="flex items-center gap-3 rounded-[16px] border border-dashed border-line-2 px-4 py-3 font-semibold hover:border-ink">
          <Icon name="user" size={20} />
          <span className="flex-1">{h.claimHandle}</span>
          <Icon name="chevronRight" size={18} />
        </Link>
      )}

      <nav className="grid grid-cols-4 gap-2" aria-label={t.app.tabs.label}>
        <ActionTile to="/app/send" icon="arrowUp" label={h.actions.send} />
        <ActionTile to="/app/receive" icon="arrowDown" label={h.actions.receive} />
        <ActionTile to="/app/add" icon="plus" label={h.actions.add} />
        <ActionTile to="/app/withdraw" icon="bank" label={h.actions.withdraw} />
      </nav>

      <Link
        to="/app/scan"
        className="flex min-h-[72px] items-center gap-4 rounded-[20px] bg-ink px-5 py-4 text-on-ink transition-transform active:scale-[0.99]"
      >
        <span className="grid size-12 place-items-center rounded-full bg-on-ink/10" aria-hidden="true">
          <Icon name="scan" size={26} strokeWidth={2.2} />
        </span>
        <span className="flex flex-1 flex-col">
          <b className="text-[1.125rem]" style={{ fontStretch: '112%' }}>
            {h.scan}
          </b>
          <span className="text-[0.875rem] opacity-80">{h.scanSub}</span>
        </span>
        <Icon name="chevronRight" size={20} />
      </Link>

      <InstallBanner />

      <section aria-labelledby="recent-h" className="pb-2">
        <div className="flex items-center justify-between">
          <h2 id="recent-h" className="text-[1.15rem]">
            {h.recent}
          </h2>
          <Link to="/app/activity" className="btn btn-quiet btn-sm">
            {h.all}
          </Link>
        </div>
        {items === undefined && (
          <div className="mt-2 flex flex-col gap-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        )}
        {items === null && <Notice tone="error">{t.app.activity.loadError}</Notice>}
        {items && items.length === 0 && <p className="mt-2 text-ink-3">{h.empty}</p>}
        {items && items.length > 0 && (
          <ul className="mt-1 flex flex-col" role="list">
            {items.map((it) => (
              <li key={`${it.type}-${it.type === 'order' ? it.order.id : it.transfer.id}`}>
                <ActivityRow item={it} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
