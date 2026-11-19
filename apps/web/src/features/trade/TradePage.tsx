/* The buy/sell app (/app): the form, or the order the address names (?order=<id>, so a reload
   follows it), and the connected wallet's orders under it. The market loads without a wallet; a
   price needs one. */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { fmt, useDocumentMeta, useI18n } from '@/i18n';
import { market as marketApi, trade as tradeApi } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/client';
import { isUnauthorized } from '@/lib/api/messages';
import { decimalsFrom } from '@/lib/p2p/normalize';
import { saveQuoteTerms, saveSteps } from '@/lib/p2p/steps';
import { dateTime, money, units } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Notice, Skeleton } from '@/components/ui/controls';
import { Icon } from '@/components/ui/Icon';
import { StatusPill } from '@/components/ui/misc';
import { TokenMark } from '@/components/p2p/parts';
import { ConnectDialog } from '@/components/wallet/ConnectDialog';
import { TradeForm } from '@/features/trade/TradeForm';
import { OrderPanel } from '@/features/trade/OrderPanel';
import type { P2pMarket, P2pOrder } from '@/lib/p2p/types';

export default function TradePage() {
  const { t, lang } = useI18n();
  const a = t.trade;
  useDocumentMeta(a.metaTitle, a.metaDescription);
  const { session, expired } = useSession();
  const [params, setParams] = useSearchParams();
  const orderId = params.get('order');
  const initialSide = params.get('side') === 'sell' ? 'SELL' : 'BUY';
  const [market, setMarket] = useState<P2pMarket | null | undefined>(undefined);
  const [unavailable, setUnavailable] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [history, setHistory] = useState<P2pOrder[] | null | undefined>(undefined);

  const loadMarket = useCallback(() => {
    setMarket(undefined);
    marketApi
      .app()
      .then((m) => {
        // A market that runs on no network for this tier is "not available", not an error.
        setMarket(m.available ? m : null);
        setUnavailable(!m.available);
      })
      .catch((e) => {
        setUnavailable(e instanceof ApiError && e.status === 503);
        setMarket(null);
      });
  }, []);
  useEffect(loadMarket, [loadMarket]);

  const loadHistory = useCallback(() => {
    if (!session || !market) return setHistory(undefined);
    tradeApi
      .orders(decimalsFrom(market))
      .then(setHistory)
      .catch((e) => setHistory(isUnauthorized(e) ? undefined : null));
  }, [session, market]);
  useEffect(loadHistory, [loadHistory]);

  const openOrder = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('order', id);
    else next.delete('order');
    next.delete('side');
    setParams(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-10 px-4 pt-8 pb-10 md:pt-12 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] lg:gap-14">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="lg:hidden">
          <h1 className="text-[1.9rem]">{a.title}</h1>
        </div>
        {expired && <Notice tone="warn">{t.common.wallet.expired}</Notice>}
        {market === undefined ? (
          <div className="sheet flex flex-col gap-3 p-5" aria-busy="true">
            <Skeleton className="h-12" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-14" />
          </div>
        ) : market === null ? (
          <div className="sheet flex flex-col items-start gap-3 p-5">
            <Notice tone={unavailable ? 'warn' : 'error'}>
              {unavailable ? a.unavailable : a.marketError}
            </Notice>
            {!unavailable && (
              <button type="button" className="btn btn-line" onClick={loadMarket}>
                {t.common.actions.retry}
              </button>
            )}
          </div>
        ) : orderId && session ? (
          <OrderPanel
            key={orderId}
            id={orderId}
            market={market}
            onNew={() => openOrder(null)}
            onMoved={loadHistory}
          />
        ) : orderId && session === null ? (
          <div className="sheet flex flex-col items-start gap-3 p-5">
            <p className="text-ink-2">{a.order.signIn}</p>
            <button type="button" className="btn btn-ink" onClick={() => setConnecting(true)}>
              <Icon name="wallet" size={18} />
              {t.common.wallet.connect}
            </button>
          </div>
        ) : (
          <TradeForm
            market={market}
            initialSide={initialSide}
            onConnect={() => setConnecting(true)}
            onOpened={(o, accepted) => {
              saveSteps(o.id, o.transactions);
              if (o.kind === 'SELL') saveQuoteTerms(o.id, accepted);
              openOrder(o.id);
            }}
          />
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-10">
        <div className="hidden lg:block">
          <h1 className="text-[2.6rem] leading-[1.06]" style={{ fontStretch: '118%' }}>
            {a.title}
          </h1>
          <p className="mt-3 max-w-[34rem] text-[1.0625rem] text-ink-2">{a.lede}</p>
        </div>
        <ul className="grid gap-5 sm:grid-cols-3 lg:grid-cols-1" role="list">
          {[
            ['wallet', a.facts.walletTitle, a.facts.walletBody],
            ['lock', a.facts.lockedTitle, a.facts.lockedBody],
            ['users', a.facts.merchantsTitle, a.facts.merchantsBody],
          ].map(([icon, title, body]) => (
            <li key={title} className="flex gap-3">
              <span
                className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-well"
                aria-hidden="true"
              >
                <Icon name={icon as 'wallet'} size={18} />
              </span>
              <div>
                <b className="font-semibold">{title}</b>
                <p className="mt-0.5 text-[0.9375rem] text-ink-3">{body}</p>
              </div>
            </li>
          ))}
        </ul>

        {session && market && (
          <section aria-labelledby="history-h">
            <h2 id="history-h" className="text-[1.3rem]">
              {a.history.title}
            </h2>
            {history === undefined && (
              <div className="mt-4 flex flex-col gap-2" aria-busy="true">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            )}
            {history === null && (
              <Notice tone="error" className="mt-4">
                {a.history.loadError}
              </Notice>
            )}
            {history && history.length === 0 && (
              <p className="mt-3 text-ink-3">{a.history.empty}</p>
            )}
            {history && history.length > 0 && (
              <ul className="mt-4 flex flex-col gap-2" role="list">
                {history.map((o) => {
                  const buy = o.kind === 'BUY';
                  return (
                    <li key={o.id}>
                      <button
                        type="button"
                        onClick={() => openOrder(o.id)}
                        aria-label={fmt(a.history.open, { id: o.id.slice(-8) })}
                        className={`flex w-full items-center gap-3 rounded-[16px] border px-4 py-3 text-left transition-colors hover:border-ink ${o.id === orderId ? 'border-ink bg-sheet' : 'border-line'}`}
                      >
                        <TokenMark
                          symbol={o.token}
                          network={market.networks.find((n) => n.id === o.network)?.name}
                          size={32}
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <b className="num font-semibold">
                            {(t.p2p.kinds as Record<string, string>)[o.kind]}:{' '}
                            {buy
                              ? units(lang, o.tokenAmount, o.token)
                              : money(lang, o.fiatAmount, o.currency)}
                          </b>
                          <span className="num truncate text-[0.875rem] text-ink-3">
                            {buy
                              ? money(lang, o.fiatAmount, o.currency)
                              : units(lang, o.tokenAmount, o.token)}
                            , {dateTime(lang, o.createdAt)}
                          </span>
                        </span>
                        <StatusPill status={o.status}>
                          {(t.p2p.status as Record<string, string>)[o.status] ?? o.status}
                        </StatusPill>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>
      {connecting && <ConnectDialog onClose={() => setConnecting(false)} />}
    </div>
  );
}
