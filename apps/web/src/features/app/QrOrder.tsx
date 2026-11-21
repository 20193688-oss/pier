/* A QR payment, followed: waiting for a merchant, the merchant paying the shop, then "Did the shop
   get the money?": yes releases the USDC to the merchant, no opens a dispute. If nobody acts, the
   order settles by itself an hour after it was marked paid. Both answers are the person's own
   signatures, checked first (SignFlow). The chat with the merchant sits beside it on a wide screen
   and below it on a phone: the merchant's receipt for paying the shop arrives there. */
import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { Notice, Spinner } from '@/components/ui/controls';
import { useNow } from '@/components/ui/misc';
import { SignFlow, type TxStep } from '@/components/wallet/SignFlow';
import { OrderChat } from '@/components/p2p/OrderChat';
import { trade } from '@/lib/api/endpoints';
import { appSubmitter } from '@/lib/api/app';
import { isNotFound, isUnauthorized } from '@/lib/api/messages';
import { money, duration } from '@/lib/format';
import { countdown, isTerminal, msLeft, pollDelay } from '@/lib/p2p/orders';
import { decimalsFrom } from '@/lib/p2p/normalize';
import { QR_PAY_WINDOWS } from '@/lib/p2p/qr-pay';
import { saleTerms } from '@/lib/p2p/tx-verify';
import { savedQuoteTerms, savedSteps, saveSteps } from '@/lib/p2p/steps';
import { toBaseUnits } from '@/lib/p2p/amounts';
import { useSession } from '@/lib/session';
import { useAppData } from '@/features/app/data';
import { Screen } from '@/features/app/shell';
import { useUsd } from '@/features/app/parts';
import type { P2pOrder } from '@/lib/p2p/types';

function shopOf(id: string): { name: string | null; city: string | null } | null {
  try {
    return JSON.parse(sessionStorage.getItem(`midpoint.app.qr-order:${id}`) ?? 'null');
  } catch {
    return null;
  }
}

export default function QrOrder() {
  const { t, lang } = useI18n();
  const q = t.app.qrOrder;
  const { id = '' } = useParams();
  const { session, expire } = useSession();
  const { market, network, token, refresh } = useAppData();
  const fmtUsd = useUsd();
  const [order, setOrder] = useState<P2pOrder | null | undefined>(undefined);
  const [answer, setAnswer] = useState<null | 'yes' | 'no'>(null);
  const [poke, setPoke] = useState(0);
  // The status the order had when the person's signature went through: while it still reads that,
  // the step is under way and is not offered again.
  const [sentAt, setSentAt] = useState<string | null>(null);
  const now = useNow(true);

  useEffect(() => {
    if (!market) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () =>
      trade
        .order(id, decimalsFrom(market))
        .then((raw) => {
          if (!alive) return;
          const o = { ...raw };
          if (o.status === 'pending' && !o.transactions?.length) o.transactions = savedSteps(o.id);
          if (o.status !== 'pending') saveSteps(o.id, undefined);
          setOrder(o);
          const d = pollDelay(o.status);
          if (d) timer = setTimeout(read, document.hidden ? d * 3 : Math.min(d, 2500));
        })
        .catch((e) => {
          if (!alive) return;
          if (isUnauthorized(e)) return expire();
          if (isNotFound(e)) return setOrder(null);
          timer = setTimeout(read, 8000);
        });
    void read();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, market, expire, poke]);

  if (!id) return <Navigate to="/app" replace />;
  if (order === undefined || !market || !network || !token || !session)
    return (
      <Screen back="/app" title={q.title}>
        <p className="flex items-center gap-3 py-10 text-ink-3" role="status">
          <Spinner />
          {t.common.actions.loading}
        </p>
      </Screen>
    );
  if (order === null)
    return (
      <Screen back="/app" title={q.title}>
        <Notice tone="warn">{t.app.activity.notFound}</Notice>
      </Screen>
    );

  const shop = order.qr?.merchantName
    ? { name: order.qr.merchantName, city: order.qr.merchantCity }
    : shopOf(order.id);
  const merchant = order.merchant?.displayName || q.title;
  const local = money(lang, order.fiatAmount, order.currency);
  const units = toBaseUnits(order.tokenAmount, token.decimals) ?? '0';
  const me = session.address;
  const step = (action: 'release' | 'dispute', label: string): TxStep => ({
    label,
    build: () => trade.transaction(order.id, action),
    expect: { action, orderId: order.onchainId ?? null },
  });
  const waiting = sentAt === order.status;
  const moved = () => {
    setSentAt(order.status);
    setAnswer(null);
    setPoke((x) => x + 1);
    refresh();
  };
  const sale = saleTerms({
    orderId: order.id,
    seller: me,
    token: token.symbol,
    accepted: savedQuoteTerms(order.id),
    order: { amountUnits: units, buyer: order.buyer },
    bondBps: market.sellBondBps,
    windows: QR_PAY_WINDOWS,
  });
  const settleLeft = msLeft(order.deadlines.settleBy, now);

  return (
    <Screen back="/app" title={q.title} width="page">
      <div className="grid gap-6 pb-6 xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start xl:gap-8">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 xl:mx-0">
          <section className="slip overflow-hidden">
            <div className="px-5 pt-5 pb-4 text-center">
              <p className="text-ink-3">{shop?.name ?? merchant}</p>
              <p className="figure mt-1 text-[2.3rem]">
                <span className="marker marker-sweep">{local}</span>
              </p>
              <p className="num mt-1 text-ink-3">{fmtUsd(units)}</p>
            </div>
            <div className="tear" />
            <div className="flex flex-col gap-3 px-5 pt-2 pb-5" data-testid="qr-status">
              {waiting && !isTerminal(order.status) && (
                <p className="flex items-center gap-3 text-ink-2" role="status">
                  <Spinner />
                  {t.trade.order.sent}
                </p>
              )}
              {order.status === 'pending' && sale.terms && !waiting && (
                <>
                  <h2 className="text-[1.15rem]">{q.lockTitle}</h2>
                  <p className="text-ink-2">{q.lockBody}</p>
                  <SignFlow
                    network={network}
                    signer={me}
                    via={appSubmitter}
                    sponsored={market.sponsor.enabled}
                    steps={[
                      {
                        label: fmt(t.app.payQr.step, { amount: fmtUsd(units) }),
                        // Simulated when signing, and once more if the network refuses it
                        // (a transaction simulated earlier goes stale when another order
                        // takes the order id it names).
                        build: () => trade.transaction(order.id, 'open_with_deposit'),
                        expect: { action: 'open_with_deposit', ...sale.terms },
                        retryOnFail: 1,
                      },
                    ]}
                    onDone={moved}
                  />
                </>
              )}
              {order.status === 'pending' && !sale.terms && (
                <p className="flex items-center gap-3 text-ink-2" role="status">
                  <Spinner />
                  {q.waitingMerchant}
                </p>
              )}
              {order.status === 'awaiting_acceptance' && (
                <p className="flex items-center gap-3 text-ink-2" role="status">
                  <Spinner />
                  {q.waitingMerchant}
                </p>
              )}
              {order.status === 'awaiting_payment' && (
                <p className="flex items-center gap-3 text-ink-2" role="status">
                  <Spinner />
                  {fmt(q.merchantPaying, { merchant, amount: local })}
                  {order.deadlines.payBy && (
                    <span className="num ml-auto rounded-full bg-well px-2.5 py-1 text-[0.8125rem] font-semibold">
                      {countdown(msLeft(order.deadlines.payBy, now))}
                    </span>
                  )}
                </p>
              )}
              {order.status === 'paid' && !waiting && (
                <>
                  <h2 className="text-[1.35rem]">{q.paidTitle}</h2>
                  <p className="text-ink-2">{fmt(q.paidBody, { merchant, amount: local })}</p>
                  {answer === null && (
                    <div className="flex flex-col gap-2">
                      <button
                        type="button"
                        className="btn btn-ink btn-lg"
                        onClick={() => setAnswer('yes')}
                      >
                        <Icon name="check" size={20} />
                        {q.yes}
                      </button>
                      <button
                        type="button"
                        className="btn btn-line btn-lg"
                        onClick={() => setAnswer('no')}
                      >
                        {q.no}
                      </button>
                    </div>
                  )}
                  {answer === 'yes' && (
                    <SignFlow
                      network={network}
                      signer={me}
                      via={appSubmitter}
                      sponsored={market.sponsor.enabled}
                      startLabel={q.yes}
                      steps={[
                        step('release', fmt(q.releaseStep, { amount: fmtUsd(units), merchant })),
                      ]}
                      onDone={moved}
                    />
                  )}
                  {answer === 'no' && (
                    <div className="flex flex-col gap-2 rounded-[16px] bg-well p-4">
                      <h3 className="text-[1.1rem]">{q.disputeTitle}</h3>
                      <p className="text-ink-2">{fmt(q.disputeBody, { brand: t.common.brand })}</p>
                      <SignFlow
                        network={network}
                        signer={me}
                        via={appSubmitter}
                        sponsored={market.sponsor.enabled}
                        startLabel={q.disputeStep}
                        steps={[step('dispute', q.disputeStep)]}
                        onDone={moved}
                      />
                    </div>
                  )}
                  {answer !== null && (
                    <button type="button" className="btn btn-quiet" onClick={() => setAnswer(null)}>
                      {t.common.actions.back}
                    </button>
                  )}
                  {settleLeft > 0 && (
                    <p className="text-[0.8125rem] text-ink-3">
                      {fmt(q.settleNote, {
                        time: duration(QR_PAY_WINDOWS.settleSeconds, t.common.time),
                      })}
                    </p>
                  )}
                </>
              )}
              {(order.status === 'completed' || order.status === 'resolved') && (
                <div className="rounded-[16px] bg-ok-soft p-4" role="status">
                  <b className="text-[1.0625rem]">{q.doneTitle}</b>
                  <p className="mt-1 text-ink-2">{fmt(q.doneBody, { amount: local })}</p>
                </div>
              )}
              {(order.status === 'cancelled' ||
                order.status === 'expired' ||
                order.status === 'failed') && (
                <div className="rounded-[16px] bg-info-soft p-4" role="status">
                  <b className="text-[1.0625rem]">{q.cancelledTitle}</b>
                  <p className="mt-1 text-ink-2">{q.cancelledBody}</p>
                </div>
              )}
              {order.status === 'disputed' && (
                <div className="rounded-[16px] bg-warn-soft p-4" role="status">
                  <b className="text-[1.0625rem]">{q.disputedTitle}</b>
                  <p className="mt-1 text-ink-2">
                    {fmt(q.disputedBody, { brand: t.common.brand })}
                  </p>
                </div>
              )}
            </div>
          </section>
          {['completed', 'resolved', 'cancelled', 'expired', 'failed'].includes(order.status) && (
            <Link to="/app" className="btn btn-ink btn-lg">
              {t.app.send.done}
            </Link>
          )}
        </div>
        <OrderChat
          scope="app"
          orderId={order.id}
          className="mx-auto w-full max-w-[720px] xl:sticky xl:top-8 xl:mx-0"
        />
      </div>
    </Screen>
  );
}
