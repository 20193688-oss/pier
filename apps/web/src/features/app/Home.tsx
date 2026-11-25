/* Home, keypad first. The balance is a small chip at the top (it opens your balances: one row per
   coin, hide and refresh); the screen is the amount you type, in the app's coin with its local
   value under it, and a keypad. The amount then goes where you choose: request it, send it, add
   that much money or withdraw it (each screen opens with the amount filled in). On a phone your
   avatar (the profile) and your QR sit beside the chip; notices (a wallet to activate, an @handle
   to choose) come before the keypad. From a tablet up the keypad is a card on the left and the
   latest movements are on the right. The physical keyboard types too. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { Notice, Skeleton } from '@/components/ui/controls';
import { Dialog } from '@/components/ui/Dialog';
import { app } from '@/lib/api/app';
import { decimalsFrom } from '@/lib/p2p/normalize';
import { toBaseUnits } from '@/lib/p2p/amounts';
import { isDollarToken, localValue } from '@/lib/app/money';
import { useSession } from '@/lib/session';
import { useAppData } from '@/features/app/data';
import {
  ActivationCard,
  ActivityList,
  InstallBanner,
  useCurrencyPicker,
  useLocal,
  useUsd,
} from '@/features/app/parts';
import { CurrencyMark, TokenMark } from '@/components/p2p/parts';
import { Keypad, shownAmount, typedValue, useKeypad } from '@/features/app/keypad';
import type { ActivityItem } from '@/lib/app/types';

const HIDE_KEY = 'pier.app.hide-balance';

/** The amount's size for a text of this length: the longer, the smaller. */
function amountSize(text: string): string {
  const n = text.length;
  if (n <= 7) return 'text-[clamp(3.2rem,17vw,4.75rem)]';
  if (n <= 10) return 'text-[clamp(2.6rem,13vw,3.75rem)]';
  return 'text-[clamp(2rem,10vw,3rem)]';
}

export default function Home() {
  const { t, lang } = useI18n();
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
  const { typed, press } = useKeypad();
  const [coins, setCoins] = useState(false);
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

  const amount = typedValue(typed);
  const units = toBaseUnits(amount || '0', token?.decimals ?? 7) ?? '0';
  const over =
    !!amount && /^\d+$/.test(balance) && /^\d+$/.test(units) && BigInt(units) > BigInt(balance);
  const dollars = !token || isDollarToken(token.symbol);
  const figure = dollars
    ? t.app.usd.replace('{amount}', shownAmount(lang, typed || '0'))
    : `${shownAmount(lang, typed || '0')} ${token.symbol}`;
  const localText = local(units);
  const addAmount = amount && price ? localValue(units, price, currency) : null;
  const q = (path: string, extra: Record<string, string>) => {
    const s = new URLSearchParams(extra).toString();
    return s ? `${path}?${s}` : path;
  };
  const balanceText = fmtUsd(balance);
  const held = (symbol: string, contract: string) =>
    balances?.tokens.find((x) => x.contract === contract || x.symbol === symbol);

  const chip = (
    <button
      type="button"
      className="glass inline-flex min-h-11 max-w-full items-center gap-2 rounded-full py-1.5 pr-3 pl-1.5 transition-colors hover:bg-well"
      onClick={() => setCoins(true)}
      aria-haspopup="dialog"
      aria-label={h.balanceLabel}
    >
      {token && <TokenMark symbol={token.symbol} size={26} />}
      {balances === undefined ? (
        <Skeleton className="h-5 w-24" />
      ) : (
        <span className="num truncate font-semibold" data-testid="balance" aria-live="polite">
          {hidden ? '••••••' : balanceText}
        </span>
      )}
      <Icon name="chevron" size={15} className="shrink-0 text-ink-3" />
    </button>
  );

  return (
    <div className="flex flex-1 flex-col md:mx-auto md:w-full md:max-w-[1180px] md:px-10 md:pt-10 md:pb-8">
      <div className="flex flex-1 flex-col md:grid md:grid-cols-[minmax(0,460px)_minmax(0,1fr)] md:items-start md:gap-10">
        <section className="keypad-card flex flex-1 flex-col" aria-labelledby="amount-h">
          {/* The top: your avatar, the balance chip, your QR (a phone); the chip alone from a
              tablet up, where the navigation carries the rest. */}
          <div className="flex h-[60px] items-center gap-3 px-5 md:h-auto md:justify-center md:px-0">
            <Link to="/app/me" aria-label={t.app.tabs.me} className="rounded-full md:hidden">
              <span
                className="glass-strong grid size-9 place-items-center rounded-full text-[0.9375rem] font-bold text-ink uppercase"
                aria-hidden="true"
              >
                {profile?.handle ? (
                  profile.handle.slice(0, 1)
                ) : (
                  <Icon name="user" size={17} strokeWidth={2.2} />
                )}
              </span>
            </Link>
            <div className="flex min-w-0 flex-1 justify-center">{chip}</div>
            <Link
              to="/app/receive"
              aria-label={t.app.tabs.receive}
              className="btn btn-orb btn-icon md:hidden"
            >
              <Icon name="qr" size={19} />
            </Link>
          </div>

          {(balances === null || needsActivation || (profile && !profile.handle)) && (
            <div className="flex flex-col gap-3 px-5 pt-2 md:px-0">
              {balances === null && (
                <Notice tone="error" stay>
                  {offline ? t.app.pwa.offline : h.loadError}
                </Notice>
              )}
              {needsActivation && <ActivationCard />}
              {profile && !profile.handle && (
                <Link
                  to="/app/handle"
                  className="lift glass flex items-center gap-3 rounded-[20px] border-dashed px-4 py-3 font-medium"
                >
                  <span className="icon-tile" aria-hidden="true">
                    <Icon name="user" size={19} />
                  </span>
                  <span className="flex-1">{h.claimHandle}</span>
                  <Icon name="chevronRight" size={18} className="chev" />
                </Link>
              )}
            </div>
          )}

          {/* The amount you type, and its local value. */}
          <div className="flex flex-1 flex-col items-center justify-center px-5 py-6 text-center md:py-10">
            <p className="text-[0.9375rem] text-ink-3">
              {profile?.handle ? fmt(h.greeting, { handle: profile.handle }) : h.greetingNoHandle}
            </p>
            <h2 id="amount-h" className="sr-only">
              {h.amount}
            </h2>
            <p
              className={`figure mt-2 ${amountSize(figure)} ${typed ? 'text-ink' : 'text-ink-3'}`}
              aria-live="polite"
              data-testid="keypad-amount"
            >
              {figure}
            </p>
            <button
              type="button"
              className="num mt-3 flex min-h-[1.75em] items-center gap-2 rounded-full py-0.5 pr-2.5 pl-1 text-ink-2 transition-[background-color,transform] duration-200 hover:bg-well active:scale-[0.98] disabled:hover:bg-transparent"
              onClick={picker.open}
              aria-haspopup="dialog"
              disabled={picker.choices < 2}
            >
              <CurrencyMark code={currency} size={20} />
              <span>
                {localText ?? (balances && price === null ? fmt(h.noRate, { currency }) : currency)}
              </span>
              {picker.choices > 1 && <Icon name="chevron" size={14} aria-hidden="true" />}
              <span className="sr-only">{picker.label}</span>
            </button>
            {picker.sheet}
            <p
              className={`mt-1 min-h-[1.25rem] text-[0.875rem] font-medium text-warn ${over ? '' : 'invisible'}`}
            >
              {t.app.send.tooMuch}
            </p>
          </div>

          {/* The keypad. */}
          <Keypad onPress={press} className="px-6 md:px-2" />

          {/* Where the amount goes. */}
          <nav
            className="flex flex-col gap-2 px-5 pt-4 pb-2 md:px-0 md:pb-0"
            aria-label={t.app.tabs.label}
          >
            <div className="grid grid-cols-2 gap-2.5">
              <Link
                to={q('/app/receive', amount ? { tab: 'ask', amount } : { tab: 'ask' })}
                className="btn btn-line btn-lg"
              >
                {h.request}
              </Link>
              <Link to={q('/app/send', amount ? { amount } : {})} className="btn btn-ink btn-lg">
                {h.actions.send}
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <Link
                to={q('/app/add', addAmount ? { currency, amount: addAmount } : {})}
                className="btn btn-quiet btn-sm"
              >
                <Icon name="plus" size={16} />
                {h.actions.add}
              </Link>
              <Link
                to={q('/app/withdraw', amount ? { amount } : {})}
                className="btn btn-quiet btn-sm"
              >
                <Icon name="bank" size={16} />
                {h.actions.withdraw}
              </Link>
            </div>
          </nav>
        </section>

        {/* From a tablet up: the latest movements beside the keypad. */}
        <div className="hidden flex-col gap-6 md:flex">
          <section aria-labelledby="recent-h" className="sheet px-6 pt-5 pb-2">
            <div className="flex items-center justify-between">
              <h2 id="recent-h" className="text-[1.125rem]">
                {h.recent}
              </h2>
              <Link
                to="/app/activity"
                className="text-[0.9375rem] font-semibold text-ink-3 hover:text-ink"
              >
                {h.all}
              </Link>
            </div>
            {items === undefined && (
              <div className="mt-3 mb-3 flex flex-col gap-2">
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
              </div>
            )}
            {items === null && (
              <Notice tone="error" stay>
                {t.app.activity.loadError}
              </Notice>
            )}
            {items && items.length === 0 && <p className="mt-2 mb-3 text-ink-3">{h.empty}</p>}
            {items && items.length > 0 && <ActivityList items={items} />}
          </section>
          <InstallBanner />
        </div>
      </div>

      {coins && (
        <Dialog title={h.coins} onClose={() => setCoins(false)}>
          <div className="flex flex-col gap-1" role="group" aria-label={h.tokens}>
            {(network?.tokens ?? []).map((tk) => {
              const own = held(tk.symbol, tk.contract);
              const active = tk.symbol === token?.symbol;
              return (
                <button
                  key={tk.contract}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setToken(tk.symbol);
                    setCoins(false);
                  }}
                  className={`flex min-h-[64px] items-center gap-3 rounded-[16px] px-3 text-left transition-[background-color,border-color] duration-200 ${active ? 'glass-strong' : 'border border-transparent hover:bg-well'}`}
                >
                  <TokenMark symbol={tk.symbol} size={36} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <b className="font-semibold">{tk.symbol}</b>
                    <span className="truncate text-[0.8125rem] text-ink-3">
                      {active ? h.coinActive : network?.name}
                    </span>
                  </span>
                  <span className="num font-medium">
                    {hidden
                      ? '••••'
                      : own && /^\d+$/.test(own.amount)
                        ? fmtUsd(own.amount, tk.symbol)
                        : fmtUsd('0', tk.symbol)}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn btn-line"
              onClick={toggleHidden}
              aria-pressed={hidden}
            >
              <Icon name={hidden ? 'eye' : 'eyeOff'} size={17} />
              {hidden ? h.show : h.hide}
            </button>
            <button
              type="button"
              className="btn btn-line"
              onClick={() => {
                refresh();
                setCoins(false);
              }}
            >
              <Icon name="refresh" size={17} />
              {h.refresh}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
