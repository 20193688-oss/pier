/* One order of the buy/sell app, followed until it ends.

   A purchase: the slip with the exact amount marked, the merchant's account with copy buttons,
   the clock, "I transferred"; then the merchant releases the USDC to the wallet.
   A sale: the two transactions the wallet signs to lock the USDC in the order, a merchant accepts
   and pays into the seller's account, the seller releases once the money is there (or the settle
   window does). Every on-chain step is the person's own wallet's, checked first (SignFlow). */
import { useEffect, useState } from 'react';
import { fmt, useI18n } from '@/i18n';
import { trade as tradeApi } from '@/lib/api/endpoints';
import { errorMessage, isNotFound, isUnauthorized } from '@/lib/api/messages';
import {
  activeDeadline,
  countdown,
  isTerminal,
  msLeft,
  orderTone,
  pollDelay,
  userActions,
} from '@/lib/p2p/orders';
import { bpsOf, toBaseUnits, fromBaseUnits } from '@/lib/p2p/amounts';
import { decimalsFrom, decimalsOf } from '@/lib/p2p/normalize';
import { explorerTx } from '@/lib/p2p/tx-check';
import { saveSteps, savedQuoteTerms, savedSteps } from '@/lib/p2p/steps';
import { saleTerms } from '@/lib/p2p/tx-verify';
import { amountOnly, money, plainAmount, units } from '@/lib/format';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Field, Notice, Spinner } from '@/components/ui/controls';
import { Icon } from '@/components/ui/Icon';
import { CopyRow, figureSize, StatusPill, useNow } from '@/components/ui/misc';
import { accountRows, railName, TokenMark } from '@/components/p2p/parts';
import { SignFlow, type TxStep } from '@/components/wallet/SignFlow';
import { useSession } from '@/lib/session';
import type { P2pMarket, P2pOrder } from '@/lib/p2p/types';

export function OrderPanel({
  id,
  market,
  onNew,
  onMoved,
}: {
  id: string;
  market: P2pMarket;
  onNew: () => void;
  onMoved?: () => void;
}) {
  const { t, lang } = useI18n();
  const a = t.trade;
  const o = a.order;
  const p = t.p2p;
  const { session, expire } = useSession();
  const [order, setOrder] = useState<P2pOrder | null | undefined>(undefined);
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<null | 'cancel' | 'dispute'>(null);
  const [signed, setSigned] = useState(false);
  const [poke, setPoke] = useState(0);

  // Read it now and again while it moves; never once it is over.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      tradeApi
        .order(id, decimalsFrom(market))
        .then((raw) => {
          if (!alive) return;
          const x = { ...raw };
          if (x.kind === 'SELL' && x.status === 'pending' && !x.transactions?.length)
            x.transactions = savedSteps(x.id);
          if (x.status !== 'pending') saveSteps(x.id, undefined);
          setOrder(x);
          const delay = pollDelay(x.status);
          if (delay) timer = setTimeout(read, document.hidden ? delay * 3 : delay);
        })
        .catch((e) => {
          if (!alive) return;
          if (isUnauthorized(e)) return expire();
          if (isNotFound(e)) return setOrder(null);
          timer = setTimeout(read, 10_000);
        });
    };
    read();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, market, expire, poke]);

  const status = order?.status;
  useEffect(() => {
    if (!status) return;
    setNote('');
    onMoved?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const now = useNow(!!order && !isTerminal(order.status));

  if (order === undefined)
    return (
      <div className="sheet flex items-center gap-3 p-6 text-ink-3" role="status">
        <Spinner />
        {t.common.actions.loading}
      </div>
    );
  if (order === null)
    return (
      <div className="sheet flex flex-col items-start gap-4 p-6">
        <Notice tone="warn">{o.notFound}</Notice>
        <button type="button" className="btn btn-ink" onClick={onNew}>
          {o.newOrder}
        </button>
      </div>
    );

  const network = market.networks.find((n) => n.id === order.network) ?? null;
  const decimals = decimalsOf(market, order.network, order.token);
  const buy = order.kind === 'BUY' || order.kind === 'CHARGE';
  const actions = userActions(order, now);
  const deadline = activeDeadline(order);
  const tone = orderTone(order.status);
  const tokenUnits = toBaseUnits(order.tokenAmount, decimals) ?? '0';
  const netUnits = (
    BigInt(tokenUnits) -
    BigInt(bpsOf(tokenUnits, (order.feeBps ?? 0) + (order.integratorFeeBps ?? 0)))
  ).toString();
  const net = fromBaseUnits(netUnits, decimals);
  const statusWord = (p.status as Record<string, string>)[order.status] ?? order.status;
  const shownTx = order.txs?.release ?? order.txs?.open ?? null;
  const txLink = explorerTx(network, shownTx);
  const me = session?.address ?? '';

  const act = async (action: 'paid' | 'cancel' | 'dispute') => {
    setBusy(true);
    setError('');
    try {
      setOrder(
        await tradeApi.act(
          order.id,
          action,
          action === 'paid' && reference.trim() ? { reference: reference.trim().slice(0, 60) } : {},
          decimals,
        ),
      );
      setConfirm(null);
    } catch (e) {
      if (isUnauthorized(e)) return expire();
      setError(errorMessage(t.common, e, action === 'paid' ? o.reportFailed : o.actionFailed));
    } finally {
      setBusy(false);
    }
  };

  /* A sale's on-chain step built by the API for this wallet. */
  const builtStep = (action: 'release' | 'cancel' | 'dispute', label: string): TxStep => ({
    label,
    build: () => tradeApi.transaction(order.id, action),
    expect: { action, orderId: order.onchainId ?? null },
  });

  /* A sale's terms, pinned to what the person accepted (or, in a tab that no longer has it, the
     order's own amount and buyer with no fee) and the market's published rules: never skipped. */
  const sale = saleTerms({
    orderId: order.id,
    seller: me,
    token: order.token,
    accepted: savedQuoteTerms(order.id),
    order: { amountUnits: tokenUnits, buyer: order.buyer },
    market,
  });
  const unverifiable = !buy && order.status === 'pending' && sale.problem !== null;
  const saleSteps: TxStep[] = (() => {
    const list = order.transactions ?? [];
    const approve = list.find((x) => x.action === 'approve' || x.description === 'approve');
    const open = list.find((x) => x !== approve);
    if (!approve || !open || !network || !sale.terms) return [];
    return [
      {
        label: fmt(o.stepApprove, {
          amount: amountOnly(lang, order.tokenAmount),
          token: order.token,
        }),
        build: async () => approve,
        expect: {
          action: 'approve',
          token: order.token,
          spender: network.contract,
          amountUnits: sale.terms.amountUnits,
        },
      },
      {
        label: o.stepOpen,
        build: async () => open,
        expect: { action: 'openWithDeposit', ...sale.terms },
      },
    ];
  })();

  const ended = isTerminal(order.status) || order.status === 'disputed';
  const done = order.status === 'completed' || order.status === 'resolved';
  const endTitle: Record<string, string> = {
    completed: o.completedTitle,
    cancelled: o.cancelledTitle,
    expired: o.expiredTitle,
    failed: o.failedTitle,
    disputed: o.disputedTitle,
    resolved: o.resolvedTitle,
  };
  const endBody: Record<string, string> = {
    completed: buy
      ? fmt(o.completedBuy, { amount: amountOnly(lang, net), token: order.token })
      : o.completedSell,
    cancelled: o.cancelledBody,
    expired: o.expiredBody,
    failed: o.failedBody,
    disputed: o.disputedBody,
    resolved: o.resolvedBody,
  };
  const clockWords = deadline
    ? fmt(o.clock[deadline.kind === 'pay' ? (buy ? 'payBuy' : 'paySell') : deadline.kind], {
        time: countdown(msLeft(deadline.at, now)),
      })
    : '';
  const payTotal = market.windows.paymentSeconds * 1000;
  const payLeft = deadline?.kind === 'pay' ? msLeft(deadline.at, now) : 0;

  return (
    <section className="slip overflow-hidden" aria-labelledby="order-h">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6">
        <div>
          <p className="text-[0.875rem] text-ink-3">
            {(p.kinds as Record<string, string>)[order.kind]},{' '}
            {fmt(o.eyebrow, { id: order.id.slice(-8) })}
          </p>
          <h2 id="order-h" className="mt-1 text-[1.35rem]">
            <StatusPill status={order.status}>{statusWord}</StatusPill>
          </h2>
        </div>
        {deadline && (
          <p
            className="num inline-flex items-center gap-1.5 rounded-full bg-well px-3 py-1.5 text-[0.875rem] font-semibold"
            role="timer"
            aria-live="off"
          >
            <Icon name="clock" size={16} />
            {clockWords}
          </p>
        )}
      </div>

      {buy && order.status === 'awaiting_payment' ? (
        <>
          <div className="px-5 pt-5 pb-5 sm:px-6">
            <p className="text-ink-2">{o.transferTitle}</p>
            <p
              className={`figure mt-2 ${figureSize(money(lang, order.fiatAmount, order.currency))}`}
            >
              <span className="marker marker-sweep">
                {money(lang, order.fiatAmount, order.currency)}
              </span>
            </p>
            {payLeft > 0 && (
              <div
                className="mt-4 h-1.5 overflow-hidden rounded-full bg-well"
                role="progressbar"
                aria-label={o.timeBar}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round((payLeft / payTotal) * 100)}
              >
                <div
                  className="h-full rounded-full bg-ink transition-[width] duration-1000 ease-linear"
                  style={{ width: `${Math.min(100, (payLeft / payTotal) * 100)}%` }}
                />
              </div>
            )}
          </div>
          <div className="tear" />
          <div className="px-5 pt-2 pb-5 sm:px-6">
            <p className="text-[0.9375rem] text-ink-2">{o.transferBody}</p>
            {order.paymentDetails && (
              <div className="mt-1 divide-y divide-line">
                {accountRows(p, order.paymentDetails).map(([k, v]) => (
                  <CopyRow key={k} label={k} value={v} />
                ))}
                <CopyRow
                  label={o.amount}
                  value={plainAmount(order.fiatAmount, order.currency)}
                  big
                />
              </div>
            )}
            <Field
              className="mt-4"
              label={o.reference}
              hint={o.referenceHint}
              value={reference}
              maxLength={60}
              autoComplete="off"
              onChange={(e) => setReference(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-ink btn-lg mt-4 w-full"
              disabled={busy || !actions.includes('paid')}
              onClick={() => void act('paid')}
            >
              {busy && <Spinner />}
              {busy ? o.reporting : o.transferred}
            </button>
          </div>
        </>
      ) : (
        <dl className="mx-5 mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-[16px] bg-well p-4 text-[0.9375rem] sm:mx-6">
          <div>
            <dt className="text-ink-3">{buy ? a.summary.pay : a.summary.sell}</dt>
            <dd className="num font-semibold">
              {buy
                ? money(lang, order.fiatAmount, order.currency)
                : units(lang, order.tokenAmount, order.token)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">{a.summary.receive}</dt>
            <dd className="num font-semibold">
              {buy ? units(lang, net, order.token) : money(lang, order.fiatAmount, order.currency)}
            </dd>
          </div>
          {order.merchant && (
            <div>
              <dt className="text-ink-3">{a.summary.merchant}</dt>
              <dd>{order.merchant.displayName}</dd>
            </div>
          )}
          <div>
            <dt className="text-ink-3">{a.summary.network}</dt>
            <dd className="flex items-center gap-2">
              <TokenMark symbol={order.token} size={18} />
              {fmt(a.summary.onNetwork, {
                token: order.token,
                network: network?.name ?? order.network,
              })}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-ink-3">{a.summary.method}</dt>
            <dd>{railName(p, order.rail)}</dd>
          </div>
        </dl>
      )}

      <div className="flex flex-col gap-4 px-5 pt-5 pb-6 sm:px-6">
        {unverifiable && (
          <>
            <Notice tone="error">
              {sale.problem === 'fee' ? o.unverifiableFee : o.unverifiable}
            </Notice>
            <button type="button" className="btn btn-ink self-start" onClick={onNew}>
              {o.newOrder}
            </button>
          </>
        )}
        {order.status === 'pending' && !unverifiable && (buy || signed || !saleSteps.length) && (
          <p className="flex items-center gap-3 text-ink-2" role="status">
            <Spinner />
            {signed ? o.sent : o.pending}
          </p>
        )}
        {order.status === 'pending' && !buy && !signed && saleSteps.length > 0 && network && (
          <div className="flex flex-col gap-3">
            <h3 className="text-[1.15rem]">{o.sign}</h3>
            <p className="text-ink-2">{o.signBody}</p>
            <SignFlow
              network={network}
              signer={me}
              steps={saleSteps}
              onDone={() => {
                setSigned(true);
                setNote(o.sent);
                setPoke((x) => x + 1);
              }}
            />
          </div>
        )}
        {buy && order.status === 'paid' && (
          <div role="status">
            <h3 className="text-[1.15rem]">{o.paidTitle}</h3>
            <p className="mt-1 text-ink-2">{o.paidBody}</p>
          </div>
        )}
        {!buy && order.status === 'awaiting_acceptance' && (
          <p className="text-ink-2" role="status">
            {o.waitingMerchant}
          </p>
        )}
        {!buy && order.status === 'awaiting_payment' && (
          <p className="text-ink-2" role="status">
            {fmt(o.merchantPaying, {
              amount: amountOnly(lang, order.fiatAmount, order.currency),
              currency: order.currency,
            })}
          </p>
        )}
        {!buy && order.status === 'paid' && network && (
          <div className="flex flex-col gap-3">
            <h3 className="text-[1.15rem]">{o.confirmTitle}</h3>
            <p className="text-ink-2">
              {fmt(o.confirmBody, {
                amount: amountOnly(lang, order.fiatAmount, order.currency),
                currency: order.currency,
              })}
            </p>
            <SignFlow
              network={network}
              signer={me}
              startLabel={fmt(o.release, { token: order.token })}
              steps={[
                builtStep(
                  'release',
                  fmt(o.stepRelease, {
                    amount: amountOnly(lang, order.tokenAmount),
                    token: order.token,
                  }),
                ),
              ]}
              onDone={() => {
                setNote(o.sent);
                setPoke((x) => x + 1);
              }}
            />
          </div>
        )}

        {ended && endTitle[order.status] && (
          <div
            className={`rounded-[16px] p-4 ${done ? 'bg-ok-soft' : tone === 'off' ? 'bg-info-soft' : 'bg-well'}`}
            role="status"
          >
            <b className="text-[1.0625rem]">{endTitle[order.status]}</b>
            <p className="mt-1 text-ink-2">{endBody[order.status]}</p>
            {done && txLink && (
              <a
                className="mt-2 inline-flex items-center gap-1.5 font-semibold underline underline-offset-4"
                href={txLink}
                target="_blank"
                rel="noopener noreferrer"
              >
                {o.explorer}
                <Icon name="external" size={16} />
              </a>
            )}
          </div>
        )}

        {note && !ended && <Notice tone="ok">{note}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}

        {(actions.includes('cancel') || actions.includes('dispute') || ended) && (
          <div className="flex flex-wrap gap-2">
            {actions.includes('cancel') && (
              <button
                type="button"
                className="btn btn-line btn-sm"
                disabled={busy}
                onClick={() => setConfirm('cancel')}
              >
                {o.cancel}
              </button>
            )}
            {actions.includes('dispute') && (
              <button
                type="button"
                className="btn btn-line btn-sm"
                disabled={busy}
                onClick={() => setConfirm('dispute')}
              >
                {o.dispute}
              </button>
            )}
            {ended && (
              <button type="button" className="btn btn-ink btn-sm" onClick={onNew}>
                {o.newOrder}
              </button>
            )}
          </div>
        )}
      </div>

      {/* A purchase's cancel or dispute goes through the API (the matcher acts for the buyer); a
          sale's is the seller's own transaction, signed in the wallet. */}
      {confirm && buy && (
        <ConfirmDialog
          title={confirm === 'cancel' ? o.cancelTitle : o.disputeTitle}
          body={confirm === 'cancel' ? o.cancelBody : o.disputeBody}
          confirmLabel={confirm === 'cancel' ? o.cancel : o.dispute}
          danger={confirm === 'cancel'}
          busy={busy}
          onConfirm={() => void act(confirm)}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm && !buy && network && (
        <div className="border-t border-line px-5 py-5 sm:px-6">
          <h3 className="text-[1.15rem]">
            {confirm === 'cancel' ? o.cancelTitle : o.disputeTitle}
          </h3>
          <p className="mt-1 mb-3 text-ink-2">
            {confirm === 'cancel' ? o.cancelSellBody : o.disputeBody}
          </p>
          <SignFlow
            network={network}
            signer={me}
            startLabel={confirm === 'cancel' ? o.cancel : o.dispute}
            steps={[builtStep(confirm, confirm === 'cancel' ? o.cancel : o.dispute)]}
            onDone={() => {
              setConfirm(null);
              setNote(o.sent);
              setPoke((x) => x + 1);
            }}
          />
          <button
            type="button"
            className="btn btn-quiet btn-sm mt-2"
            onClick={() => setConfirm(null)}
          >
            {t.common.actions.back}
          </button>
        </div>
      )}
    </section>
  );
}
