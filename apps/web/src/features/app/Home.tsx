/* Home. On a phone: on the night aura, the logo, who is signed in, the balance in dollars and in
   local money and the four actions (send, receive, add money, withdraw); on the sheet that rises over it, a banner when the
   wallet needs activation, the scan shortcut and the latest movements by day. From a tablet up the
   page has its own margins: the balance as a card, and on a wide screen two columns (the balance
   and the movements on the left, the shortcuts, your QR and notices on the right, from 1280px). */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { Logo } from '@/components/ui/Logo';
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
  useCurrencyPicker,
  useLocal,
  useUsd,
} from '@/features/app/parts';
import { CurrencyMark } from '@/components/p2p/parts';
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
    token,
    profile,
    balances,
    balance,
    needsActivation,
    currency,
    price,
    offline,
    refresh,
    setToken,
  } = useAppData();
  const fmtUsd = useUsd();
  const local = useLocal();
  const picker = useCurrencyPicker();
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
    // On a phone the sheet runs to the screen's foot under the dock: it takes back the frame's
    // bottom padding.
    <div className="mb-[calc(-104px-env(safe-area-inset-bottom,0px))] flex flex-1 flex-col md:mx-auto md:mb-0 md:w-full md:max-w-[1180px] md:gap-6 md:px-10 md:pt-8 md:pb-6 xl:grid xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)] xl:content-start xl:items-start xl:gap-8">
      <section
        className="tone-dark aura-night grain px-6 pt-3 pb-12 text-ink md:rounded-[28px] md:px-8 md:pt-6 md:pb-8 xl:col-start-1 xl:row-start-1"
        aria-labelledby="balance-h"
      >
        <header className="flex min-h-11 items-center gap-1">
          <Logo size={20} className="block text-ink md:hidden" />
          <span className="flex-1" />
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

        <Link
          to="/app/me"
          className="mt-4 inline-flex min-h-11 max-w-full items-center gap-2.5 rounded-full bg-well py-1.5 pr-4 pl-1.5 transition-colors hover:bg-line"
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

        <h2 id="balance-h" className="mt-7 text-[0.875rem] font-medium tracking-normal text-ink-3">
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
        {/* The local value with its currency's flag: tapping it changes the currency. */}
        <button
          type="button"
          className="num mt-2 -ml-1 flex min-h-[1.75em] items-center gap-2 rounded-full py-0.5 pr-2 pl-1 text-left text-ink-2 transition-[background-color,transform] duration-200 hover:bg-well active:scale-[0.98] disabled:hover:bg-transparent"
          onClick={picker.open}
          aria-haspopup="dialog"
          disabled={picker.choices < 2}
        >
          <CurrencyMark code={currency} size={20} />
          <span>
            {hidden
              ? currency
              : (localText ??
                (balances && price === null ? fmt(h.noRate, { currency }) : currency))}
          </span>
          {picker.choices > 1 && <Icon name="chevron" size={14} aria-hidden="true" />}
          <span className="sr-only">{picker.label}</span>
        </button>
        {picker.sheet}

        {network && network.tokens.length > 1 && (
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label={h.tokens}>
            {network.tokens.map((tk) => {
              const held = balances?.tokens.find(
                (x) => x.contract === tk.contract || x.symbol === tk.symbol,
              );
              const active = tk.symbol === token?.symbol;
              return (
                <button
                  key={tk.contract}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setToken(tk.symbol)}
                  className={`inline-flex min-h-9 items-center gap-2 rounded-full px-3.5 text-[0.875rem] font-semibold transition-[background-color,color,transform] duration-200 active:scale-95 ${active ? 'bg-ink text-on-ink' : 'bg-well text-ink-2 hover:bg-line hover:text-ink'}`}
                >
                  {tk.symbol}
                  {held && /^\d+$/.test(held.amount) && BigInt(held.amount) > 0n && (
                    <span className="num font-medium opacity-75">
                      {fmtUsd(held.amount, tk.symbol)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <nav
          className="mt-7 grid grid-cols-4 gap-2 max-[359px]:grid-cols-2 md:gap-3"
          aria-label={t.app.tabs.label}
        >
          <ActionTile to="/app/send" icon="arrowUp" label={h.actions.send} />
          <ActionTile to="/app/receive" icon="arrowDown" label={h.actions.receive} />
          <ActionTile to="/app/add" icon="plus" label={h.actions.add} />
          <ActionTile to="/app/withdraw" icon="bank" label={h.actions.withdraw} />
        </nav>
      </section>

      <div className="rise flex flex-1 flex-col gap-6 px-6 pt-7 pb-[calc(112px+env(safe-area-inset-bottom,0px))] md:mt-0 md:rounded-none md:bg-transparent md:p-0 xl:contents">
        <div className="flex flex-col gap-4 xl:col-start-2 xl:row-span-2 xl:row-start-1">
          {balances === null && (
            <Notice tone="error" stay>{offline ? t.app.pwa.offline : h.loadError}</Notice>
          )}
          {needsActivation && <ActivationCard />}
          {profile && !profile.handle && (
            <Link
              to="/app/handle"
              className="lift flex items-center gap-3 rounded-[16px] border border-dashed border-line-2 px-4 py-3 font-medium"
            >
              <span className="icon-tile" aria-hidden="true">
                <Icon name="user" size={19} />
              </span>
              <span className="flex-1">{h.claimHandle}</span>
              <Icon name="chevronRight" size={18} className="chev" />
            </Link>
          )}

          <Link
            to="/app/scan"
            className="lift flex min-h-[72px] items-center gap-3 rounded-[18px] bg-well px-4 py-3"
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
            <Icon name="chevronRight" size={18} className="chev text-ink-3" />
          </Link>

          {profile?.handle && (
            <Link
              to="/app/receive"
              className="lift hidden min-h-[72px] items-center gap-3 rounded-[18px] border border-line bg-sheet px-4 py-3 md:flex"
            >
              <span className="icon-tile" aria-hidden="true">
                <Icon name="qr" size={20} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <b className="font-semibold">{h.qrTitle}</b>
                <span className="truncate text-[0.875rem] text-ink-3">@{profile.handle}</span>
              </span>
              <Icon name="chevronRight" size={18} className="chev text-ink-3" />
            </Link>
          )}

          <InstallBanner />
        </div>

        <section
          aria-labelledby="recent-h"
          className="pb-2 md:rounded-[20px] md:border md:border-line md:bg-sheet md:p-6 md:shadow-[var(--shadow-sheet)] xl:col-start-1 xl:row-start-2"
        >
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
          {items === null && <Notice tone="error" stay>{t.app.activity.loadError}</Notice>}
          {items && items.length === 0 && <p className="mt-2 text-ink-3">{h.empty}</p>}
          {items && items.length > 0 && <ActivityList items={items} />}
        </section>
      </div>
    </div>
  );
}
