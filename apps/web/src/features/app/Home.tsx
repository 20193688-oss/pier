/* Home: on the night aura, who is signed in, the balance in dollars and in local money and the four
   actions (send, receive, add money, withdraw); on the sheet that rises over it, a banner when the
   wallet needs activation, the scan shortcut and the latest movements by day. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { Notice, Skeleton } from '@/components/ui/controls';
import { app } from '@/lib/api/app';
import { decimalsFrom } from '@/lib/p2p/normalize';
import { useSession } from '@/lib/session';
import { useAppData } from '@/features/app/data';
import { ActionTile } from '@/features/app/shell';
import {
  ActivationCard,
  ActivityList,
  InstallBanner,
  useLocal,
  useUsd,
} from '@/features/app/parts';
import type { ActivityItem } from '@/lib/app/types';

const HIDE_KEY = 'midpoint.app.hide-balance';

/** The balance's size for a text of this length: the longer the text, the smaller the cut. */
function balanceSize(text: string): string {
  const n = text.length;
  if (n <= 11) return 'text-[clamp(2.4rem,12vw,3.25rem)]';
  if (n <= 14) return 'text-[clamp(2rem,10vw,2.8rem)]';
  if (n <= 17) return 'text-[clamp(1.7rem,8vw,2.3rem)]';
  return 'text-[clamp(1.4rem,6.4vw,1.9rem)]';
}

export default function Home() {
  const { t } = useI18n();
  const h = t.app.home;
  const { session } = useSession();
  const {
    market,
    network,
    profile,
    balances,
    balance,
    needsActivation,
    currency,
    price,
    offline,
    refresh,
  } = useAppData();
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
    // The sheet runs to the screen's foot under the dock: it takes back the frame's bottom padding.
    <div className="mb-[calc(-104px-env(safe-area-inset-bottom,0px))] flex flex-1 flex-col">
      <section
        className="tone-dark aura-night grain px-4 pt-3 pb-12 text-ink"
        aria-labelledby="balance-h"
      >
        <header className="flex items-center gap-2">
          <Link
            to="/app/me"
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-well py-1.5 pr-4 pl-1.5 transition-colors hover:bg-line"
          >
            <span
              className="grid size-8 shrink-0 place-items-center rounded-full bg-ink text-[0.9375rem] font-bold text-on-ink uppercase"
              aria-hidden="true"
            >
              {profile?.handle ? (
                profile.handle.slice(0, 1)
              ) : (
                <Icon name="user" size={16} strokeWidth={2.2} />
              )}
            </span>
            <span className="truncate font-medium">
              {profile?.handle ? fmt(h.greeting, { handle: profile.handle }) : h.greetingNoHandle}
            </span>
          </Link>
          <button
            type="button"
            className="btn btn-quiet btn-icon"
            onClick={toggleHidden}
            aria-label={hidden ? h.show : h.hide}
            aria-pressed={hidden}
          >
            <Icon name={hidden ? 'eye' : 'eyeOff'} size={20} />
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-icon"
            onClick={refresh}
            aria-label={t.common.actions.retry}
          >
            <Icon name="refresh" size={20} />
          </button>
        </header>

        <h2 id="balance-h" className="mt-8 text-[0.875rem] font-medium tracking-normal text-ink-3">
          {h.balance}
        </h2>
        {balances === undefined ? (
          <Skeleton className="mt-2 h-12 w-2/3" />
        ) : (
          <p
            className={`figure mt-1.5 ${balanceSize(amountText)}`}
            data-testid="balance"
            aria-live="polite"
          >
            {hidden ? <span aria-label={h.balanceHidden}>••••••</span> : amountText}
          </p>
        )}
        <p className="num mt-2 min-h-[1.5em] text-ink-2">
          {hidden
            ? ''
            : (localText ?? (balances && price === null ? fmt(h.noRate, { currency }) : ''))}
        </p>

        <nav className="mt-7 grid grid-cols-4 gap-2" aria-label={t.app.tabs.label}>
          <ActionTile to="/app/send" icon="arrowUp" label={h.actions.send} />
          <ActionTile to="/app/receive" icon="arrowDown" label={h.actions.receive} />
          <ActionTile to="/app/add" icon="plus" label={h.actions.add} />
          <ActionTile to="/app/withdraw" icon="bank" label={h.actions.withdraw} />
        </nav>
      </section>

      <div className="rise flex flex-1 flex-col gap-4 px-4 pt-5 pb-[calc(112px+env(safe-area-inset-bottom,0px))]">
        {balances === null && (
          <Notice tone="error">{offline ? t.app.pwa.offline : h.loadError}</Notice>
        )}
        {needsActivation && <ActivationCard />}
        {profile && !profile.handle && (
          <Link
            to="/app/handle"
            className="flex items-center gap-3 rounded-[16px] border border-dashed border-line-2 px-3 py-2.5 font-medium hover:border-ink"
          >
            <span className="icon-tile" aria-hidden="true">
              <Icon name="user" size={19} />
            </span>
            <span className="flex-1">{h.claimHandle}</span>
            <Icon name="chevronRight" size={18} />
          </Link>
        )}

        <Link
          to="/app/scan"
          className="flex min-h-[68px] items-center gap-3 rounded-[18px] bg-well px-3 py-3 transition-colors hover:bg-line"
        >
          <span
            className="grid size-11 shrink-0 place-items-center rounded-[12px] bg-ink text-on-ink"
            aria-hidden="true"
          >
            <Icon name="scan" size={22} strokeWidth={2.2} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <b className="font-semibold">{h.scan}</b>
            <span className="truncate text-[0.875rem] text-ink-3">{h.scanSub}</span>
          </span>
          <Icon name="chevronRight" size={18} className="text-ink-3" />
        </Link>

        <InstallBanner />

        <section aria-labelledby="recent-h" className="pb-2">
          <div className="flex items-center justify-between">
            <h2 id="recent-h" className="text-[1.125rem]">
              {h.recent}
            </h2>
            <Link to="/app/activity" className="text-[0.9375rem] text-ink-3 hover:text-ink">
              {h.all}
            </Link>
          </div>
          {items === undefined && (
            <div className="mt-3 flex flex-col gap-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          )}
          {items === null && <Notice tone="error">{t.app.activity.loadError}</Notice>}
          {items && items.length === 0 && <p className="mt-2 text-ink-3">{h.empty}</p>}
          {items && items.length > 0 && <ActivityList items={items} />}
        </section>
      </div>
    </div>
  );
}
