/* Pieces several app screens share: an activity row and the list that groups rows by day, the
   activation card, a dollar amount with its local-money equivalent, a key/value list, and the
   local-currency picker. */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Notice, Skeleton } from '@/components/ui/controls';
import { useToast } from '@/components/ui/Toast';
import { StatusPill, Pill } from '@/components/ui/misc';
import { CurrencyMark, PickerSheet } from '@/components/p2p/parts';
import { SignFlow } from '@/components/wallet/SignFlow';
import { app, appSubmitter } from '@/lib/api/app';
import {
  currencyName,
  groupByDay,
  money,
  shortAddress,
  timeOnly,
  units as tokenUnits,
} from '@/lib/format';
import { isQrRail } from '@/lib/p2p/qr-pay';
import { hasUnseen } from '@/lib/p2p/chat';
import { seenAt } from '@/lib/p2p/chat-seen';
import { savedRecipient } from '@/lib/p2p/steps';
import { isDollarToken, localValue, usd } from '@/lib/app/money';
import { fromBaseUnits, toBaseUnits } from '@/lib/p2p/amounts';
import { useAppData } from '@/features/app/data';
import { useSession } from '@/lib/session';
import { install, usePwa } from '@/lib/pwa';
import type { ActivityItem, AppTransfer } from '@/lib/app/types';

/** An amount of the app's token (or of `symbol`) as a person reads it: dollars as "US$ 12,50",
    anything else in its own unit ("12,5 XLM"). */
export function useUsd() {
  const { t, lang } = useI18n();
  const { token } = useAppData();
  return (units: string | bigint, symbol: string | null = token?.symbol ?? null) =>
    !symbol || isDollarToken(symbol)
      ? usd(lang, units, t.app.usd)
      : tokenUnits(lang, fromBaseUnits(units, 7), symbol);
}

/** The local-money equivalent of `units` ("≈ 18.150,00 ARS"), or null without a price. */
export function useLocal() {
  const { t, lang } = useI18n();
  const { price, currency } = useAppData();
  return (units: string) => {
    const v = price ? localValue(units, price, currency) : null;
    return v ? fmt(t.app.approx, { amount: money(lang, v, currency) }) : null;
  };
}

/** The app's local currency and its picker sheet (every currency the market pays out in, each
    with its flag): `open` shows the sheet, `sheet` is rendered by the screen. */
export function useCurrencyPicker() {
  const { t, lang } = useI18n();
  const { market, currency, setCurrency } = useAppData();
  const [open, setOpen] = useState(false);
  const currencies = (market?.currencies ?? []).filter((c) => c.rails.some((r) => !isQrRail(r)));
  const sheet = open ? (
    <PickerSheet
      title={t.trade.pickCurrency}
      searchLabel={t.trade.searchCurrency}
      selected={currency}
      onClose={() => setOpen(false)}
      onPick={(code) => {
        setOpen(false);
        setCurrency(code);
      }}
      items={currencies.map((c) => ({
        key: c.code,
        mark: <CurrencyMark code={c.code} size={34} />,
        title: c.code,
        sub: currencyName(c.code, lang),
        search: `${c.code} ${currencyName(c.code, lang)}`,
      }))}
    />
  ) : null;
  return {
    currency,
    choices: currencies.length,
    open: () => setOpen(true),
    sheet,
    label: fmt(t.trade.changeCurrency, { currency: currencyName(currency, lang) }),
  };
}

/** Orders that ended without moving anything: their row is struck through. */
const VOID_STATUSES = new Set(['failed', 'cancelled', 'expired', 'rejected']);

const who = (handle: string | null, address: string, outside: string) =>
  handle ? `@${handle}` : address ? shortAddress(address) : outside;

const itemDate = (item: ActivityItem) =>
  item.type === 'transfer' ? item.transfer.createdAt : item.order.createdAt;
const itemKey = (item: ActivityItem) =>
  `${item.type}-${item.type === 'order' ? item.order.id : item.transfer.id}`;

/** One movement: what it was, who, when, the amount signed in or out. */
export function ActivityRow({ item }: { item: ActivityItem }) {
  const { t, lang } = useI18n();
  const a = t.app.activity;
  const fmtUsd = useUsd();
  const { token } = useAppData();
  const decimals = token?.decimals ?? 7;
  let icon: IconName;
  let title: string;
  let sub: string;
  let amount: string;
  let incoming: boolean;
  let to: string;
  let pill: ReactNode = null;
  let unread = false;
  // Nothing moved (a cancelled, expired or refused order, a failed transfer): the row is struck
  // through in red and says why in plain words instead of a pill.
  let voided: string | null = null;
  if (item.type === 'transfer') {
    const tr: AppTransfer = item.transfer;
    incoming = tr.direction === 'in';
    icon = incoming ? 'arrowDown' : 'arrowUp';
    title = incoming
      ? fmt(a.received, { who: who(tr.fromHandle, tr.from, a.outside) })
      : fmt(a.sent, { who: who(tr.toHandle, tr.to, a.outside) });
    sub = [tr.note, timeOnly(lang, tr.createdAt)].filter(Boolean).join(' · ');
    amount = fmtUsd(tr.amount, tr.token || null);
    to = `/app/activity/transfer/${tr.id}`;
    if (tr.status === 'FAILED') voided = a.transferStatus.FAILED;
    else if (tr.status !== 'COMPLETED')
      pill = <Pill tone="pend">{a.transferStatus[tr.status]}</Pill>;
  } else {
    const o = item.order;
    incoming = o.kind === 'BUY';
    icon = o.kind === 'BUY' ? 'plus' : o.kind === 'QR_PAY' ? 'store' : 'bank';
    // A send to someone else's bank account names them (kept on this device when it was sent).
    const recipient = o.kind === 'SELL' ? savedRecipient(o.id) : null;
    title = recipient
      ? fmt(a.sent, { who: recipient })
      : ((a.kinds as Record<string, string>)[o.kind] ?? o.kind);
    sub = [money(lang, o.fiatAmount, o.currency), timeOnly(lang, o.createdAt)]
      .filter(Boolean)
      .join(' · ');
    amount = fmtUsd(toBaseUnits(o.tokenAmount, decimals) ?? '0');
    to = `/app/activity/order/${o.id}`;
    unread = !!o.chat && hasUnseen(o.chat, 'creator', seenAt('app', o.id));
    if (VOID_STATUSES.has(o.status))
      voided = (t.p2p.status as Record<string, string>)[o.status] ?? o.status;
    else if (o.status !== 'completed')
      pill = (
        <StatusPill status={o.status}>
          {(t.p2p.status as Record<string, string>)[o.status] ?? o.status}
        </StatusPill>
      );
  }
  const struck = voided ? 'line-through decoration-bad decoration-[1.5px] text-ink-3' : '';
  return (
    <Link
      to={to}
      data-voided={voided ? '' : undefined}
      className="-mx-3 flex min-h-[68px] items-center gap-3 rounded-[16px] px-3 py-2 transition-[background-color,transform] duration-200 hover:bg-well active:scale-[0.99]"
    >
      <span className={`icon-tile ${voided ? 'opacity-50' : ''}`} aria-hidden="true">
        <Icon name={icon} size={19} strokeWidth={2.1} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <b className={`truncate font-medium ${struck}`}>{title}</b>
        <span className="flex min-w-0 items-center gap-1.5 text-[0.8125rem] text-ink-3">
          {unread && (
            <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-info">
              <Icon name="chat" size={13} strokeWidth={2.2} />
              {t.p2p.chat.unread}
            </span>
          )}
          <span className={`truncate ${struck}`}>{sub}</span>
        </span>
      </span>
      <span className="flex flex-col items-end gap-1">
        <b className={`num font-medium ${voided ? struck : incoming ? 'text-ok' : ''}`}>
          {incoming ? '+' : '−'}
          {amount}
        </b>
        {voided ? <span className="text-[0.8125rem] font-medium text-bad">{voided}</span> : pill}
      </span>
    </Link>
  );
}

/** Movements under a heading per day ("Hoy", "Ayer", "18 de noviembre"), each day its own list. */
export function ActivityList({ items, level = 3 }: { items: ActivityItem[]; level?: 2 | 3 }) {
  const { lang } = useI18n();
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className="flex flex-col">
      {groupByDay(items, itemDate, lang).map((g) => (
        <section key={`${g.label}-${itemKey(g.items[0])}`}>
          {g.label && (
            <Heading className="mt-3 mb-0.5 text-[0.8125rem] font-medium tracking-normal text-ink-3">
              {g.label}
            </Heading>
          )}
          <ul className="flex flex-col" role="list">
            {g.items.map((it) => (
              <li key={itemKey(it)}>
                <ActivityRow item={it} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The wallet's sponsored activation (a missing account or trustline): one signature, free. */
export function ActivationCard() {
  const { t } = useI18n();
  const a = t.app.activate;
  const { network, token, market, refresh } = useAppData();
  const { session } = useSession();
  const toast = useToast();
  const [done, setDone] = useState(false);
  if (!network || !token || !session) return null;
  if (done) return <Notice tone="ok">{a.done}</Notice>;
  return (
    <section className="sheet p-4" aria-labelledby="activate-h">
      <div className="flex items-start gap-3">
        <span className="tile-icon mt-0.5 shrink-0" aria-hidden="true">
          <Icon name="bolt" size={15} strokeWidth={2.3} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="activate-h" className="text-[1.0625rem]">
            {a.title}
          </h2>
          <p className="mt-1 mb-3 text-[0.9375rem] text-ink-2">{a.body}</p>
        </div>
      </div>
      <SignFlow
        network={network}
        signer={session.address}
        via={appSubmitter}
        sponsored={market?.sponsor.enabled ?? true}
        startLabel={a.cta}
        steps={[
          {
            label: a.step,
            build: async () => {
              const tx = await app.activate(network.id, token.symbol);
              if (!tx) throw Object.assign(new Error('nothing to do'), { name: 'Nothing' });
              return tx;
            },
            expect: { action: 'activate', token: token.symbol },
          },
        ]}
        onDone={() => {
          setDone(true);
          toast(a.done);
          refresh();
        }}
      />
    </section>
  );
}

/** A list of labelled values (a receipt): the label quiet on the left, the value on the right. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="sheet px-4 py-1">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-start justify-between gap-4 py-3">
          <dt className="text-ink-3">{k}</dt>
          <dd className="num min-w-0 text-right font-medium break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const INSTALL_KEY = 'pier.app.install-dismissed';

/** Install the app: Android's prompt when the browser offers one, else iOS's "Add to Home
    Screen" hint; dismissed for good with "Not now". */
export function InstallBanner() {
  const { t } = useI18n();
  const p = t.app.pwa;
  const pwa = usePwa();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(INSTALL_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (dismissed || pwa.installed || (!pwa.canInstall && !pwa.iosHint)) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(INSTALL_KEY, '1');
    } catch {
      /* this page only */
    }
  };
  return (
    <section
      className="glass flex items-start gap-3 rounded-[22px] p-4"
      aria-labelledby="install-h"
    >
      <span className="tile-icon mt-0.5 shrink-0" aria-hidden="true">
        <Icon name="download" size={15} strokeWidth={2.3} />
      </span>
      <div className="flex-1">
        <h2 id="install-h" className="text-[1.0625rem]">
          {pwa.canInstall ? p.installTitle : p.iosTitle}
        </h2>
        <p className="mt-0.5 text-[0.9375rem] text-ink-2">
          {pwa.canInstall ? p.installBody : p.iosBody}
        </p>
        <div className="mt-3 flex gap-2">
          {pwa.canInstall && (
            <button type="button" className="btn btn-ink btn-sm" onClick={() => void install()}>
              {p.install}
            </button>
          )}
          <button type="button" className="btn btn-quiet btn-sm" onClick={dismiss}>
            {p.later}
          </button>
        </div>
      </div>
    </section>
  );
}

const positive = (v: string | null | undefined) => !!v && /^\d+$/.test(v) && BigInt(v) > 0n;

/** The wallet at a glance, beside a form on a wide screen: the balance in the app's token, its
    local value, and the other coins the wallet holds (other tokens, and XLM). */
export function WalletSummary() {
  const { t, lang } = useI18n();
  const h = t.app.home;
  const { balance, balances, token, network } = useAppData();
  const fmtUsd = useUsd();
  const local = useLocal();
  const decimalsOf = (symbol: string) =>
    network?.tokens.find((x) => x.symbol === symbol)?.decimals ?? 7;
  const others = (balances?.tokens ?? []).filter(
    (b) => b.symbol !== token?.symbol && b.trustline && positive(b.amount),
  );
  const xlm =
    positive(balances?.xlm) && !others.some((b) => b.symbol === 'XLM') && token?.symbol !== 'XLM'
      ? balances!.xlm
      : null;
  return (
    <section
      className="tone-dark aura-card overflow-hidden rounded-[26px] p-6 text-ink"
      aria-label={h.balance}
    >
      <p className="text-[0.875rem] font-medium text-ink-3">{h.balance}</p>
      {balances === undefined ? (
        <Skeleton className="mt-3 h-10 w-2/3" />
      ) : (
        <p className="figure mt-2 text-[2.25rem]">{fmtUsd(balance)}</p>
      )}
      <p className="num mt-2 min-h-[1.5em] text-ink-2">{local(balance) ?? ''}</p>
      {(others.length > 0 || xlm) && (
        <ul
          className="mt-5 flex flex-col gap-2 border-t border-line pt-4 text-[0.9375rem]"
          role="list"
        >
          {others.map((b) => (
            <li key={b.contract} className="flex items-center justify-between gap-3">
              <span className="text-ink-2">{b.symbol}</span>
              <span className="num font-medium">
                {tokenUnits(lang, fromBaseUnits(b.amount, decimalsOf(b.symbol)), b.symbol)}
              </span>
            </li>
          ))}
          {xlm && (
            <li className="flex items-center justify-between gap-3">
              <span className="text-ink-2">XLM</span>
              <span className="num font-medium">
                {tokenUnits(lang, fromBaseUnits(xlm, 7), 'XLM')}
              </span>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
