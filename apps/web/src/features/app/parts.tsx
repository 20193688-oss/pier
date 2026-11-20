/* Pieces several app screens share: an activity row and the list that groups rows by day, the
   activation card, a dollar amount with its local-money equivalent, and a key/value list. */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Notice } from '@/components/ui/controls';
import { useToast } from '@/components/ui/Toast';
import { StatusPill, Pill } from '@/components/ui/misc';
import { SignFlow } from '@/components/wallet/SignFlow';
import { app, appSubmitter } from '@/lib/api/app';
import { groupByDay, money, shortAddress, timeOnly } from '@/lib/format';
import { localValue, usd } from '@/lib/app/money';
import { toBaseUnits } from '@/lib/p2p/amounts';
import { useAppData } from '@/features/app/data';
import { useSession } from '@/lib/session';
import { install, usePwa } from '@/lib/pwa';
import type { ActivityItem, AppTransfer } from '@/lib/app/types';

/** "US$ 12,50" in the reader's language. */
export function useUsd() {
  const { t, lang } = useI18n();
  return (units: string | bigint) => usd(lang, units, t.app.usd);
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
  if (item.type === 'transfer') {
    const tr: AppTransfer = item.transfer;
    incoming = tr.direction === 'in';
    icon = incoming ? 'arrowDown' : 'arrowUp';
    title = incoming
      ? fmt(a.received, { who: who(tr.fromHandle, tr.from, a.outside) })
      : fmt(a.sent, { who: who(tr.toHandle, tr.to, a.outside) });
    sub = [tr.note, timeOnly(lang, tr.createdAt)].filter(Boolean).join(' · ');
    amount = fmtUsd(tr.amount);
    to = `/app/activity/transfer/${tr.id}`;
    if (tr.status !== 'COMPLETED')
      pill = (
        <Pill tone={tr.status === 'FAILED' ? 'fail' : 'pend'}>{a.transferStatus[tr.status]}</Pill>
      );
  } else {
    const o = item.order;
    incoming = o.kind === 'BUY';
    icon = o.kind === 'BUY' ? 'plus' : o.kind === 'QR_PAY' ? 'store' : 'bank';
    title = (a.kinds as Record<string, string>)[o.kind] ?? o.kind;
    sub = [money(lang, o.fiatAmount, o.currency), timeOnly(lang, o.createdAt)]
      .filter(Boolean)
      .join(' · ');
    amount = fmtUsd(toBaseUnits(o.tokenAmount, decimals) ?? '0');
    to = `/app/activity/order/${o.id}`;
    if (o.status !== 'completed')
      pill = (
        <StatusPill status={o.status}>
          {(t.p2p.status as Record<string, string>)[o.status] ?? o.status}
        </StatusPill>
      );
  }
  return (
    <Link
      to={to}
      className="-mx-2 flex min-h-[64px] items-center gap-3 rounded-[14px] px-2 py-2 transition-colors hover:bg-well"
    >
      <span className="icon-tile" aria-hidden="true">
        <Icon name={icon} size={19} strokeWidth={2.1} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <b className="truncate font-medium">{title}</b>
        <span className="truncate text-[0.8125rem] text-ink-3">{sub}</span>
      </span>
      <span className="flex flex-col items-end gap-1">
        <b className={`num font-medium ${incoming ? 'text-ok' : ''}`}>
          {incoming ? '+' : '−'}
          {amount}
        </b>
        {pill}
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

const INSTALL_KEY = 'midpoint.app.install-dismissed';

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
      className="flex items-start gap-3 rounded-[18px] bg-well p-4"
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
