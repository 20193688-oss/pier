/* One movement in detail: a transfer (who, how much, the note, its status timeline and the
   transaction on the explorer) or an order (its kind, amounts, status timeline, and a link to
   follow it while it is live). */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { Notice, Skeleton } from '@/components/ui/controls';
import { app } from '@/lib/api/app';
import { trade } from '@/lib/api/endpoints';
import { dateTime, money, shortAddress } from '@/lib/format';
import { decimalsFrom } from '@/lib/p2p/normalize';
import { isTerminal } from '@/lib/p2p/orders';
import { toBaseUnits } from '@/lib/p2p/amounts';
import { explorerLink } from '@/lib/stellar/network';
import { useAppData } from '@/features/app/data';
import { Screen } from '@/features/app/shell';
import { Facts, useUsd } from '@/features/app/parts';
import type { AppTransfer } from '@/lib/app/types';
import type { P2pOrder } from '@/lib/p2p/types';

type Step = { key: string; done: boolean; bad?: boolean };

function Timeline({ steps, words }: { steps: Step[]; words: Record<string, string> }) {
  return (
    <ol className="flex flex-col gap-0">
      {steps.map((s, i) => (
        <li key={s.key} className="flex gap-3">
          <span className="flex flex-col items-center" aria-hidden="true">
            <span
              className={`grid size-6 place-items-center rounded-full ${s.bad ? 'bg-bad text-on-ink' : s.done ? 'bg-ok text-on-ink' : 'bg-well text-ink-3'}`}
            >
              {s.done && <Icon name={s.bad ? 'close' : 'check'} size={14} strokeWidth={2.6} />}
            </span>
            {i < steps.length - 1 && <span className="w-0.5 flex-1 bg-line" />}
          </span>
          <span className={`pb-4 ${s.done ? 'font-semibold' : 'text-ink-3'}`}>{words[s.key]}</span>
        </li>
      ))}
    </ol>
  );
}

export default function ActivityDetail() {
  const { t, lang } = useI18n();
  const a = t.app.activity;
  const { type, id = '' } = useParams();
  const { market, network, token } = useAppData();
  const fmtUsd = useUsd();
  const [transfer, setTransfer] = useState<AppTransfer | null | undefined>(undefined);
  const [order, setOrder] = useState<P2pOrder | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    if (type === 'transfer')
      app
        .getTransfer(id)
        .then((x) => alive && setTransfer(x))
        .catch(() => alive && setTransfer(null));
    else if (type === 'order' && market)
      trade
        .order(id, decimalsFrom(market))
        .then((x) => alive && setOrder(x))
        .catch(() => alive && setOrder(null));
    return () => {
      alive = false;
    };
  }, [type, id, market]);

  const loading = type === 'transfer' ? transfer === undefined : order === undefined;
  const missing = type === 'transfer' ? transfer === null : order === null;

  return (
    <Screen back="/app/activity" title={a.detail}>
      {loading && !missing && <Skeleton className="h-64" />}
      {missing && <Notice tone="warn">{a.notFound}</Notice>}
      {transfer && (
        <div className="flex flex-col gap-4 pb-4">
          <div className="text-center">
            <p className="text-ink-3">
              {transfer.direction === 'in'
                ? fmt(a.received, { who: transfer.fromHandle ? `@${transfer.fromHandle}` : shortAddress(transfer.from) || a.outside })
                : fmt(a.sent, { who: transfer.toHandle ? `@${transfer.toHandle}` : shortAddress(transfer.to) })}
            </p>
            <p className="figure mt-1 text-[2.4rem]">
              {transfer.direction === 'in' ? '+' : '−'}
              {fmtUsd(transfer.amount)}
            </p>
          </div>
          <Facts
            rows={[
              [a.from, transfer.fromHandle ? `@${transfer.fromHandle}` : shortAddress(transfer.from)],
              [a.to, transfer.toHandle ? `@${transfer.toHandle}` : shortAddress(transfer.to)],
              ...(transfer.note ? ([[a.note, transfer.note]] as [string, string][]) : []),
              [a.date, dateTime(lang, transfer.createdAt)],
            ]}
          />
          <section aria-labelledby="tl-h">
            <h2 id="tl-h" className="mb-3 text-[1.1rem]">
              {a.timeline}
            </h2>
            <Timeline
              words={a.steps}
              steps={[
                { key: 'created', done: true },
                { key: 'submitted', done: transfer.status !== 'PENDING' },
                transfer.status === 'FAILED'
                  ? { key: 'failed', done: true, bad: true }
                  : { key: 'completed', done: transfer.status === 'COMPLETED' },
              ]}
            />
          </section>
          {explorerLink(network, 'tx', transfer.hash) && (
            <a className="btn btn-line" href={explorerLink(network, 'tx', transfer.hash)!} target="_blank" rel="noopener noreferrer">
              {a.explorer}
              <Icon name="external" size={16} />
            </a>
          )}
        </div>
      )}
      {order && (
        <div className="flex flex-col gap-4 pb-4">
          <div className="text-center">
            <p className="text-ink-3">{(a.kinds as Record<string, string>)[order.kind] ?? order.kind}</p>
            <p className="figure mt-1 text-[2.2rem]">{money(lang, order.fiatAmount, order.currency)}</p>
            <p className="num text-ink-3">{fmtUsd(toBaseUnits(order.tokenAmount, token?.decimals ?? 7) ?? '0')}</p>
          </div>
          <Facts
            rows={[
              [t.trade.summary.merchant, order.merchant?.displayName || '-'],
              [a.date, dateTime(lang, order.createdAt)],
              [t.trade.summary.method, (t.p2p.rails as Record<string, string>)[order.rail] ?? order.rail],
            ]}
          />
          <section aria-labelledby="tl-h">
            <h2 id="tl-h" className="mb-3 text-[1.1rem]">
              {a.timeline}
            </h2>
            <Timeline words={a.steps} steps={orderSteps(order)} />
          </section>
          {!isTerminal(order.status) && (
            <Link className="btn btn-ink btn-lg" to={order.kind === 'QR_PAY' ? `/app/qr/${order.id}` : `/app/order/${order.id}`}>
              {a.follow}
            </Link>
          )}
          {explorerLink(network, 'tx', order.txs?.release ?? order.txs?.open ?? null) && (
            <a
              className="btn btn-line"
              href={explorerLink(network, 'tx', order.txs?.release ?? order.txs?.open ?? null)!}
              target="_blank"
              rel="noopener noreferrer"
            >
              {a.explorer}
              <Icon name="external" size={16} />
            </a>
          )}
        </div>
      )}
    </Screen>
  );
}

function orderSteps(o: P2pOrder): Step[] {
  const reached = (statuses: string[]) => statuses.includes(o.status);
  const after = {
    opened: !reached(['pending']),
    accepted: reached(['awaiting_payment', 'paid', 'disputed', 'completed', 'resolved']) ||
      (o.kind === 'BUY' && !reached(['pending'])),
    paid: reached(['paid', 'disputed', 'completed', 'resolved']),
    released: reached(['completed']),
  };
  const steps: Step[] = [
    { key: 'opened', done: after.opened },
    ...(o.kind === 'BUY' ? [] : [{ key: 'accepted', done: after.accepted }]),
    { key: 'paid', done: after.paid },
  ];
  if (o.status === 'cancelled' || o.status === 'expired' || o.status === 'failed')
    steps.push({ key: o.status === 'failed' ? 'failed' : o.status, done: true, bad: true });
  else if (o.status === 'disputed') steps.push({ key: 'disputed', done: true, bad: true });
  else if (o.status === 'resolved') steps.push({ key: 'resolved', done: true });
  else steps.push({ key: 'released', done: after.released });
  return steps;
}
