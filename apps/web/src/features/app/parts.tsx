/* Pieces several app screens share: an activity row, the activation card, a dollar amount with its
   local-money equivalent, and a key/value list. */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Notice } from '@/components/ui/controls';
import { StatusPill, Pill } from '@/components/ui/misc';
import { SignFlow } from '@/components/wallet/SignFlow';
import { app, appSubmitter } from '@/lib/api/app';
import { dateTime, money, shortAddress } from '@/lib/format';
import { localValue, usd } from '@/lib/app/money';
import { toBaseUnits } from '@/lib/p2p/amounts';
import { useAppData } from '@/features/app/data';
import { useSession } from '@/lib/session';
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
    sub = [tr.note, dateTime(lang, tr.createdAt)].filter(Boolean).join(' · ');
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
    sub = `${money(lang, o.fiatAmount, o.currency)} · ${dateTime(lang, o.createdAt)}`;
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
      className="flex min-h-[64px] items-center gap-3 rounded-[14px] px-1 py-2 transition-colors hover:bg-well"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-full bg-well" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <b className="truncate font-semibold">{title}</b>
        <span className="truncate text-[0.8125rem] text-ink-3">{sub}</span>
      </span>
      <span className="flex flex-col items-end gap-1">
        <b className={`num font-semibold ${incoming ? 'text-ok' : ''}`}>
          {incoming ? '+' : '−'}
          {amount}
        </b>
        {pill}
      </span>
    </Link>
  );
}

/** The wallet's sponsored activation (a missing account or trustline): one signature, free. */
export function ActivationCard() {
  const { t } = useI18n();
  const a = t.app.activate;
  const { network, token, market, refresh } = useAppData();
  const { session } = useSession();
  const [done, setDone] = useState(false);
  if (!network || !token || !session) return null;
  if (done) return <Notice tone="ok">{a.done}</Notice>;
  return (
    <section className="rounded-[18px] border border-line bg-sheet p-4" aria-labelledby="activate-h">
      <h2 id="activate-h" className="text-[1.1rem]">
        {a.title}
      </h2>
      <p className="mt-1 mb-3 text-[0.9375rem] text-ink-2">{a.body}</p>
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
          refresh();
        }}
      />
    </section>
  );
}

/** A list of labelled values (a receipt). */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-line rounded-[18px] bg-well px-4">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-start justify-between gap-4 py-3">
          <dt className="text-ink-3">{k}</dt>
          <dd className="num min-w-0 text-right font-semibold break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
