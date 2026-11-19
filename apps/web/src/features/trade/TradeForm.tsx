/* The buy/sell form: Buy / Sell tabs, the amount in local money (buy) or in USDC (sell), the
   currency, the token and network, the payment method, and one price that follows the form a
   moment after the last keystroke. One button says what is missing. Then who pays (a purchase)
   or the account the money goes to (a sale), then the order opens. */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { fmt, useI18n } from '@/i18n';
import { trade as tradeApi, type BuyOrderInput, type SellOrderInput } from '@/lib/api/endpoints';
import { errorMessage, isUnauthorized } from '@/lib/api/messages';
import {
  checkBeneficiary,
  checkHolderName,
  checkPayerDocument,
  documentOf,
  fiatDecimals,
  normalizeDetails,
  type FieldError,
} from '@/lib/p2p/rails';
import { parseDecimal, toBaseUnits } from '@/lib/p2p/amounts';
import { decimalsOf } from '@/lib/p2p/normalize';
import { countdown, msLeft } from '@/lib/p2p/orders';
import { currencyName, money, percent, rate, shortAddress, units } from '@/lib/format';
import { Field, Notice, Skeleton, Spinner } from '@/components/ui/controls';
import { Icon } from '@/components/ui/Icon';
import { useNow } from '@/components/ui/misc';
import {
  AccountFields,
  CurrencyMark,
  PickerSheet,
  TokenMark,
  emptyAccount,
  errorText,
  needsDocument,
  railName,
  type AccountDraft,
} from '@/components/p2p/parts';
import { useSession } from '@/lib/session';
import type { P2pMarket, P2pOrder, P2pQuote, P2pSide } from '@/lib/p2p/types';

type QuoteState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  key: string;
  data: P2pQuote | null;
};

export function TradeForm({
  market,
  initialSide,
  onConnect,
  onOpened,
}: {
  market: P2pMarket;
  initialSide: P2pSide;
  onConnect: () => void;
  onOpened: (o: P2pOrder, quote: P2pQuote) => void;
}) {
  const { t, lang } = useI18n();
  const a = t.trade;
  const p = t.p2p;
  const { session, expire } = useSession();
  const [side, setSide] = useState<P2pSide>(initialSide);
  const [currency, setCurrency] = useState(
    () => (market.currencies.find((c) => c.code === 'ARS') ?? market.currencies[0])?.code ?? '',
  );
  const [pick, setPick] = useState(() =>
    market.networks[0]
      ? { network: market.networks[0].id, token: market.networks[0].tokens[0].symbol }
      : null,
  );
  const [rail, setRail] = useState('');
  const [amount, setAmount] = useState('');
  const [picker, setPicker] = useState<null | 'currency' | 'token'>(null);
  const [inverse, setInverse] = useState(false);
  const [quote, setQuote] = useState<QuoteState>({ status: 'idle', key: '', data: null });
  const [step, setStep] = useState<'form' | 'details'>('form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [payer, setPayer] = useState({ name: '', document: '' });
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [account, setAccount] = useState<AccountDraft>(emptyAccount(''));

  const cur = market.currencies.find((c) => c.code === currency) ?? null;
  useEffect(() => {
    if (cur && !cur.rails.includes(rail)) setRail(cur.rails[0] ?? '');
  }, [cur, rail]);
  useEffect(() => setAccount(emptyAccount(rail)), [rail]);

  const network = market.networks.find((n) => n.id === pick?.network) ?? null;
  const token = network?.tokens.find((x) => x.symbol === pick?.token) ?? null;
  const symbol = token?.symbol ?? 'USDC';
  const tokenDecimals = token ? decimalsOf(market, network!.id, token.symbol) : 6;
  const decimals = side === 'BUY' ? fiatDecimals(currency) : Math.min(tokenDecimals, 6);
  const parsed = amount ? parseDecimal(amount, decimals) : null;
  const amountOk = parsed !== null && Number(parsed) > 0;
  const complete = !!session && !!cur && !!token && !!network && !!rail && amountOk;
  const quoteKey = complete
    ? JSON.stringify({
        side,
        network: network!.id,
        token: token!.symbol,
        currency,
        rail,
        ...(side === 'BUY'
          ? { fiatAmount: parsed }
          : { tokenAmount: toBaseUnits(parsed!, tokenDecimals) }),
      })
    : '';

  // The price follows the form; an answer for a form that has since changed is dropped; a price
  // that runs out is asked for again while on screen.
  const latest = useRef('');
  const ask = useCallback(
    (k: string) => {
      latest.current = k;
      setQuote((q) => ({ status: 'loading', key: k, data: q.key === k ? q.data : null }));
      tradeApi
        .quote(JSON.parse(k), tokenDecimals)
        .then((data) => {
          if (latest.current === k) setQuote({ status: 'ready', key: k, data });
        })
        .catch((e) => {
          if (latest.current !== k) return;
          if (isUnauthorized(e)) expire();
          setQuote({ status: 'error', key: k, data: null });
        });
    },
    [tokenDecimals, expire],
  );
  useEffect(() => {
    if (!quoteKey) {
      latest.current = '';
      setQuote({ status: 'idle', key: '', data: null });
      return;
    }
    const h = setTimeout(() => ask(quoteKey), 450);
    return () => clearTimeout(h);
  }, [quoteKey, ask]);
  const fresh = quote.key === quoteKey && quote.data ? quote.data : null;
  const now = useNow(!!fresh);
  const expired = !!fresh && Date.parse(fresh.expiresAt) <= now;
  useEffect(() => {
    if (expired && quoteKey) ask(quoteKey);
  }, [expired, quoteKey, ask]);

  const payerErrors: Record<string, FieldError | null> = {
    name: checkHolderName(payer.name),
    document: checkPayerDocument(currency, payer.document),
  };
  const accountErrors =
    side === 'SELL'
      ? checkBeneficiary(rail, {
          holderName: account.holderName,
          details: account.details,
          document: needsDocument(rail, account.details) ? account.document : '',
        })
      : {};
  const detailsOk =
    side === 'BUY'
      ? !Object.values(payerErrors).some(Boolean)
      : Object.keys(accountErrors).length === 0;

  const cta = (() => {
    if (!cur || !token) return { label: a.cta.unavailable, ok: false };
    if (!amount.trim()) return { label: a.cta.amount, ok: false };
    if (!amountOk) return { label: fmt(a.cta.badAmount, { n: decimals }), ok: false };
    if (!session) return { label: a.cta.connect, ok: true, connect: true };
    if (!rail) return { label: a.cta.method, ok: false };
    if (quote.status === 'error' && quote.key === quoteKey)
      return { label: a.cta.noQuote, ok: false };
    if (!fresh || expired) return { label: a.cta.quoting, ok: false, busy: true };
    return { label: a.cta.continue, ok: true };
  })();

  const openOrder = async () => {
    if (!fresh || busy) return;
    setBusy(true);
    setError('');
    try {
      let body: BuyOrderInput | SellOrderInput;
      if (side === 'BUY')
        body = {
          side: 'BUY',
          quoteId: fresh.id,
          payer: { name: payer.name.trim(), document: payer.document.trim() },
        };
      else {
        const details = normalizeDetails(rail, account.details);
        const document =
          (needsDocument(rail, account.details) ? account.document.trim() : '') ||
          documentOf(rail, details);
        body = {
          side: 'SELL',
          quoteId: fresh.id,
          beneficiary: { holderName: account.holderName.trim(), document, details },
        };
      }
      const order = await tradeApi.createOrder(body, tokenDecimals);
      setAmount('');
      setStep('form');
      onOpened(order, fresh);
    } catch (e) {
      if (isUnauthorized(e)) {
        expire();
        return;
      }
      setError(errorMessage(t.common, e, a.openFailed));
      if (quoteKey) ask(quoteKey);
    } finally {
      setBusy(false);
    }
  };

  const switchSide = (s: P2pSide) => {
    setSide(s);
    setAmount('');
    setStep('form');
  };
  const tabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = side === 'BUY' ? 'SELL' : 'BUY';
    switchSide(next);
    document.getElementById(`trade-tab-${next}`)?.focus();
  };

  const currencyButton = (
    <button
      type="button"
      className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-sheet py-1.5 pr-3 pl-1.5 hover:border-ink"
      onClick={() => setPicker('currency')}
      aria-haspopup="dialog"
      disabled={market.currencies.length < 2}
      aria-label={fmt(a.changeCurrency, { currency: cur ? currencyName(cur.code, lang) : '' })}
    >
      {cur && <CurrencyMark code={cur.code} size={28} />}
      <b className="font-bold" style={{ fontStretch: '112%' }}>
        {cur?.code ?? '-'}
      </b>
      {market.currencies.length > 1 && <Icon name="chevron" size={16} />}
    </button>
  );
  const tokenButton = (
    <button
      type="button"
      className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-sheet py-1.5 pr-3 pl-1.5 hover:border-ink"
      onClick={() => setPicker('token')}
      aria-haspopup="dialog"
      aria-label={fmt(a.changeToken, { token: symbol, network: network?.name ?? '' })}
    >
      <TokenMark symbol={symbol} network={network?.name} size={28} />
      <span className="flex flex-col items-start leading-tight">
        <b className="font-bold" style={{ fontStretch: '112%' }}>
          {symbol}
        </b>
        <small className="text-[0.75rem] text-ink-3">{network?.name}</small>
      </span>
      <Icon name="chevron" size={16} />
    </button>
  );

  const outText = fresh
    ? side === 'BUY'
      ? units(lang, fresh.netAmount, symbol)
      : money(lang, fresh.fiatAmount, currency)
    : '';
  const rateText = fresh
    ? inverse
      ? fmt(a.rateInverse, {
          currency,
          token: symbol,
          price: new Intl.NumberFormat(lang, { maximumSignificantDigits: 4 }).format(
            1 / Number(fresh.price),
          ),
        })
      : fmt(a.rate, { currency, token: symbol, price: rate(lang, fresh.price) })
    : '';
  const stats = fresh?.merchant
    ? [
        fresh.merchant.completed === 1
          ? p.merchant.completedOne
          : fresh.merchant.completed > 0
            ? fmt(p.merchant.completed, {
                n: new Intl.NumberFormat(lang).format(fresh.merchant.completed),
              })
            : p.merchant.new,
        fresh.merchant.completionRate != null
          ? fmt(p.merchant.rate, { rate: percent(lang, fresh.merchant.completionRate) })
          : null,
      ].filter(Boolean)
    : [];

  if (step === 'details' && fresh && session) {
    const show = (k: string) => (touched[k] ? payerErrors[k] : null);
    const leave = (k: string) => () => setTouched((x) => ({ ...x, [k]: true }));
    return (
      <section className="sheet p-5 sm:p-6" aria-labelledby="trade-details-h">
        <button
          type="button"
          className="btn btn-quiet btn-sm -ml-2 mb-2 px-2"
          onClick={() => setStep('form')}
        >
          <Icon name="back" size={18} />
          {t.common.actions.back}
        </button>
        <h2 id="trade-details-h" className="text-[1.4rem]">
          {side === 'BUY' ? a.buyer.title : a.seller.title}
        </h2>
        <dl className="mt-4 grid grid-cols-2 gap-3 rounded-[16px] bg-well p-4 text-[0.9375rem]">
          <div>
            <dt className="text-ink-3">{side === 'BUY' ? a.youPay : a.youSell}</dt>
            <dd className="num font-semibold">
              {side === 'BUY'
                ? money(lang, fresh.fiatAmount, currency)
                : units(lang, fresh.tokenAmount, symbol)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">{a.youReceive}</dt>
            <dd className="num font-semibold">
              {side === 'BUY'
                ? units(lang, fresh.netAmount, symbol)
                : money(lang, fresh.fiatAmount, currency)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">{a.merchant}</dt>
            <dd>{fresh.merchant.displayName}</dd>
          </div>
          {side === 'BUY' && (
            <div>
              <dt className="text-ink-3">{a.buyer.receiveTo}</dt>
              <dd className="num" title={session.address}>
                {shortAddress(session.address)}
              </dd>
            </div>
          )}
        </dl>
        <p className="mt-4 text-ink-2">{side === 'BUY' ? a.buyer.body : a.seller.body}</p>
        <div className="mt-4 flex flex-col gap-4">
          {side === 'BUY' ? (
            <>
              <Field
                label={a.buyer.name}
                value={payer.name}
                autoComplete="name"
                placeholder={p.placeholders.holderName}
                onChange={(e) => setPayer((x) => ({ ...x, name: e.target.value }))}
                onBlur={leave('name')}
                error={errorText(p, 'holderName', show('name'))}
              />
              <Field
                label={a.buyer.document}
                value={payer.document}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setPayer((x) => ({ ...x, document: e.target.value }))}
                onBlur={leave('document')}
                hint={a.buyer.documentHint}
                error={errorText(p, 'document', show('document'))}
              />
            </>
          ) : (
            <AccountFields
              rail={rail}
              value={account}
              onChange={setAccount}
              errors={accountErrors}
              showAll={!!touched.all}
            />
          )}
        </div>
        <p className="mt-4 text-[0.875rem] text-ink-3" aria-live="polite">
          {expired
            ? a.refreshing
            : fmt(a.validFor, { time: countdown(msLeft(fresh.expiresAt, now)) })}
        </p>
        <button
          type="button"
          className="btn btn-ink btn-lg mt-3 w-full"
          disabled={busy || expired}
          onClick={() => {
            setTouched({ name: true, document: true, all: true });
            if (detailsOk) void openOrder();
            else
              setTimeout(
                () => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
                0,
              );
          }}
        >
          {busy && <Spinner />}
          {busy ? a.opening : a.open}
        </button>
        {error && (
          <Notice tone="error" className="mt-3">
            {error}
          </Notice>
        )}
      </section>
    );
  }

  return (
    <section className="sheet p-4 sm:p-5" aria-labelledby="trade-widget-h">
      <h2 id="trade-widget-h" className="sr-only">
        {a.title}
      </h2>
      <div className="seg" role="tablist" aria-label={a.tabs.label} onKeyDown={tabKey}>
        {(['BUY', 'SELL'] as const).map((s) => (
          <button
            key={s}
            id={`trade-tab-${s}`}
            type="button"
            role="tab"
            aria-selected={side === s}
            aria-controls="trade-panel"
            tabIndex={side === s ? 0 : -1}
            onClick={() => switchSide(s)}
          >
            {fmt(s === 'BUY' ? a.tabs.buy : a.tabs.sell, { token: symbol })}
          </button>
        ))}
      </div>
      <div
        id="trade-panel"
        role="tabpanel"
        aria-labelledby={`trade-tab-${side}`}
        className="mt-4 flex flex-col gap-2"
      >
        <div className="rounded-[18px] bg-well p-4">
          <label htmlFor="trade-amount" className="text-[0.875rem] font-semibold text-ink-3">
            {side === 'BUY' ? a.youPay : a.youSell}
          </label>
          <div className="mt-1 flex items-center gap-3">
            <input
              id="trade-amount"
              className="figure w-full min-w-0 bg-transparent text-[clamp(1.7rem,8vw,2.3rem)] outline-none placeholder:text-ink-3/50"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value.trim().replace(',', '.'))}
              aria-invalid={amount.trim() && !amountOk ? true : undefined}
            />
            {side === 'BUY' ? currencyButton : tokenButton}
          </div>
        </div>
        <div
          className="rounded-[18px] border border-line p-4"
          aria-busy={quote.status === 'loading' || undefined}
        >
          <span id="trade-get-l" className="text-[0.875rem] font-semibold text-ink-3">
            {a.youReceive}
          </span>
          <div className="mt-1 flex items-center gap-3">
            <output
              aria-labelledby="trade-get-l"
              aria-live="polite"
              className={`figure w-full min-w-0 truncate text-[clamp(1.7rem,8vw,2.3rem)] ${outText ? '' : 'text-ink-3/60'}`}
            >
              {quote.status === 'loading' && !outText ? (
                <Skeleton className="h-9 w-2/3" />
              ) : outText ? (
                outText.split(' ')[0]
              ) : (
                '0'
              )}
            </output>
            {side === 'BUY' ? tokenButton : currencyButton}
          </div>
        </div>

        {fresh && (
          <div className="mt-1 flex flex-col gap-2 rounded-[16px] px-1 py-1 text-[0.9375rem]">
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                className="num font-semibold underline decoration-line-2 decoration-dotted underline-offset-4"
                onClick={() => setInverse((v) => !v)}
                title={a.invertRate}
              >
                {rateText}
              </button>
              <span className="num text-[0.8125rem] text-ink-3" aria-live="off">
                {expired
                  ? a.refreshing
                  : fmt(a.validFor, { time: countdown(msLeft(fresh.expiresAt, now)) })}
              </span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="text-ink-3">{a.merchant}</span>
              <span className="text-right">
                <b className="font-semibold">{fresh.merchant.displayName}</b>
                {stats.length > 0 && (
                  <span className="block text-[0.8125rem] text-ink-3">{stats.join(', ')}</span>
                )}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-ink-3">{a.fee}</span>
              <span className="num">{units(lang, fresh.protocolFee, symbol)}</span>
            </div>
            {Number(fresh.integratorFee) > 0 && (
              <div className="flex justify-between gap-3">
                <span className="text-ink-3">{a.integratorFee}</span>
                <span className="num">{units(lang, fresh.integratorFee, symbol)}</span>
              </div>
            )}
          </div>
        )}

        {cur && (
          <div className="mt-1 flex flex-col gap-1.5">
            <label htmlFor="trade-rail" className="text-[0.875rem] font-semibold text-ink-3">
              {side === 'BUY' ? a.payWith : a.receiveIn}
            </label>
            <select
              id="trade-rail"
              className="field"
              value={rail}
              onChange={(e) => setRail(e.target.value)}
              disabled={cur.rails.length < 2}
            >
              {cur.rails.map((r) => (
                <option key={r} value={r}>
                  {railName(p, r)}
                </option>
              ))}
            </select>
          </div>
        )}

        <button
          type="button"
          className="btn btn-ink btn-lg mt-2 w-full"
          disabled={!cta.ok}
          onClick={() => (cta.connect ? onConnect() : setStep('details'))}
        >
          {cta.busy && <Spinner />}
          {cta.label}
        </button>
        {quote.status === 'error' && quote.key === quoteKey && (
          <Notice tone="warn">{a.quoteFailed}</Notice>
        )}
      </div>

      {picker === 'currency' && (
        <PickerSheet
          title={a.pickCurrency}
          searchLabel={a.searchCurrency}
          selected={currency}
          onClose={() => setPicker(null)}
          onPick={(code) => {
            setPicker(null);
            setCurrency(code);
          }}
          items={market.currencies.map((c) => ({
            key: c.code,
            mark: <CurrencyMark code={c.code} size={34} />,
            title: c.code,
            sub: currencyName(c.code, lang),
            search: `${c.code} ${currencyName(c.code, lang)}`,
          }))}
        />
      )}
      {picker === 'token' && (
        <PickerSheet
          title={a.pickToken}
          selected={pick ? `${pick.network}:${pick.token}` : ''}
          onClose={() => setPicker(null)}
          onPick={(k) => {
            const [n, tk] = k.split(':');
            setPicker(null);
            setPick({ network: n, token: tk });
          }}
          items={market.networks.flatMap((n) =>
            n.tokens.map((tk) => ({
              key: `${n.id}:${tk.symbol}`,
              mark: <TokenMark symbol={tk.symbol} network={n.name} size={34} />,
              title: tk.symbol,
              sub: n.name,
              search: `${tk.symbol} ${n.name}`,
            })),
          )}
        />
      )}
    </section>
  );
}
