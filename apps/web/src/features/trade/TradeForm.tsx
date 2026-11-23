/* The buy/sell form: Buy / Sell tabs, the amount in local money (buy) or in USDC (sell), the
   currency, the token and network, the payment method, and one price that follows the form a
   moment after the last keystroke. One button says what is missing. Then who pays (a purchase)
   or the account the money goes to (a sale), then the order opens. */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { isAccount, isPayer, recall, remember, type Payer } from '@/lib/app/remember';
import { isQrRail } from '@/lib/p2p/qr-pay';
import { fmt, useI18n } from '@/i18n';
import { trade as tradeApi, type BuyOrderInput, type SellOrderInput } from '@/lib/api/endpoints';
import { errorMessage, isUnauthorized } from '@/lib/api/messages';
import { ApiError } from '@/lib/api/client';
import { useToast } from '@/components/ui/Toast';
import {
  checkBeneficiary,
  checkHolderName,
  checkPayerDocument,
  defaultCurrency,
  documentOf,
  idOptional,
  isRailId,
  RAILS,
  withoutId,
  fiatDecimals,
  normalizeDetails,
  type FieldError,
} from '@/lib/p2p/rails';
import { bpsLabel, parseDecimal, toBaseUnits } from '@/lib/p2p/amounts';
import { integratorBpsFor, trustQuote, type AcceptedQuote } from '@/lib/p2p/fees';
import { decimalsOf } from '@/lib/p2p/normalize';
import { saveRecipient } from '@/lib/p2p/steps';
import { countdown, msLeft } from '@/lib/p2p/orders';
import { currencyName, money, percent, rate, shortAddress, units } from '@/lib/format';
import { isDollarToken, usd, USDC_DECIMALS } from '@/lib/app/money';
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
import { useGuard } from '@/lib/use-action';

type QuoteState = {
  status: 'idle' | 'loading' | 'ready' | 'error' | 'untrusted';
  key: string;
  data: P2pQuote | null;
  /* What the person sees and would accept: the amount, the fee shown, the named addresses. */
  accepted: AcceptedQuote | null;
};

/** The received amount's size: an exact USDC amount can carry up to seven decimals, so a long
    figure steps down to fit beside the token button on a phone instead of being cut off. */
function outSize(figure: string): string {
  const n = figure.length;
  if (n <= 7) return 'text-[clamp(1.7rem,8vw,2.3rem)]';
  if (n <= 10) return 'text-[clamp(1.35rem,6.2vw,1.9rem)]';
  return 'text-[clamp(1.1rem,5vw,1.6rem)]';
}

export function TradeForm({
  market,
  initialSide,
  fixedSide,
  initialToken,
  initialCurrency,
  initialAmount,
  initialRail,
  initialDetails,
  recipient = 'self',
  onConnect,
  onOpened,
}: {
  market: P2pMarket;
  initialSide: P2pSide;
  /* The payments app's add-money and withdraw screens: one side, no tabs. */
  fixedSide?: P2pSide;
  /* The token to start with (the app's own); the first listed otherwise. */
  initialToken?: string;
  /* The currency to start with (the person's own, or a QR's); ARS, else the first, otherwise. */
  initialCurrency?: string;
  /* An amount to start with (local money to buy with, tokens to sell), e.g. what a payment lacks. */
  initialAmount?: string;
  /* A sale's rail and account details to start with (an account typed on the Send screen). */
  initialRail?: string;
  initialDetails?: Record<string, string>;
  /* Whose account a sale pays: the person's own (withdraw) or someone else's (send to a bank
     account abroad). Someone else's is never filled in from the person's own account. */
  recipient?: 'self' | 'other';
  onConnect: () => void;
  onOpened: (o: P2pOrder, accepted: AcceptedQuote) => void;
}) {
  const { t, lang } = useI18n();
  const a = t.trade;
  const p = t.p2p;
  const { session, expire, expired: sessionEnded, renewing } = useSession();
  const [side, setSide] = useState<P2pSide>(fixedSide ?? initialSide);
  const [currency, setCurrency] = useState(
    () =>
      market.currencies.find((c) => c.code === initialCurrency)?.code ??
      defaultCurrency(market.currencies),
  );
  const [pick, setPick] = useState(() => {
    const n = market.networks[0];
    if (!n) return null;
    const t = n.tokens.find((x) => x.symbol === initialToken) ?? n.tokens[0];
    return { network: n.id, token: t.symbol };
  });
  const [rail, setRail] = useState(initialRail ?? '');
  const other = recipient === 'other';
  const [amount, setAmount] = useState(initialAmount ?? '');
  // A sale is typed either way: the tokens sent, or the local money that arrives (a send to
  // someone else's account starts there: "10 PEN"). A purchase is typed in local money.
  const [by, setBy] = useState<'token' | 'fiat'>(other ? 'fiat' : 'token');
  const entry: 'token' | 'fiat' = side === 'BUY' ? 'fiat' : by;
  const [picker, setPicker] = useState<null | 'currency' | 'token'>(null);
  const [inverse, setInverse] = useState(false);
  const [quote, setQuote] = useState<QuoteState>({
    status: 'idle',
    key: '',
    data: null,
    accepted: null,
  });
  const [step, setStep] = useState<'form' | 'details'>('form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The payer and the payout account come back as this device last sent them (src/lib/app/remember).
  const [payer, setPayer] = useState<Payer>(
    () => recall(`payer.${currency}`, isPayer) ?? { name: '', document: '' },
  );
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [account, setAccount] = useState<AccountDraft>(emptyAccount(''));

  const found = market.currencies.find((c) => c.code === currency) ?? null;
  // The QR rails are for QR payments only: a purchase or a sale goes through a bank rail.
  const cur = useMemo(
    () => (found ? { ...found, rails: found.rails.filter((r) => !isQrRail(r)) } : null),
    [found],
  );
  useEffect(() => {
    if (cur && !cur.rails.includes(rail)) setRail(cur.rails[0] ?? '');
  }, [cur, rail]);
  useEffect(() => {
    if (!other) {
      setAccount(recall(`account.${rail}`, isAccount) ?? emptyAccount(rail));
      return;
    }
    // Someone else's account: what was typed on the Send screen, the rail's own fields only.
    const base = emptyAccount(rail);
    const known = new Set(isRailId(rail) ? RAILS[rail].fields.map((f) => f.key) : []);
    const typed =
      rail === initialRail && initialDetails
        ? Object.fromEntries(Object.entries(initialDetails).filter(([k]) => known.has(k)))
        : {};
    setAccount({ ...base, details: { ...base.details, ...typed } });
    // The props are the screen's first values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rail]);
  useEffect(
    () => setPayer((p) => (p.name || p.document ? p : (recall(`payer.${currency}`, isPayer) ?? p))),
    [currency],
  );

  const network = market.networks.find((n) => n.id === pick?.network) ?? null;
  const token = network?.tokens.find((x) => x.symbol === pick?.token) ?? null;
  const symbol = token?.symbol ?? 'USDC';
  const tokenDecimals = token ? decimalsOf(market, network!.id, token.symbol) : 6;
  const decimals = entry === 'fiat' ? fiatDecimals(currency) : Math.min(tokenDecimals, 6);
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
        ...(entry === 'fiat'
          ? { fiatAmount: parsed }
          : { tokenAmount: toBaseUnits(parsed!, tokenDecimals) }),
      })
    : '';

  // The price follows the form; an answer for a form that has since changed is dropped; a price
  // that runs out is asked for again while on screen, and says so when it moved.
  const latest = useRef('');
  const seen = useRef<{ key: string; price: string } | null>(null);
  const [priceNote, setPriceNote] = useState<{ from: string; to: string } | null>(null);
  const toast = useToast();
  const ask = useCallback(
    (k: string) => {
      latest.current = k;
      setQuote((q) => ({
        status: 'loading',
        key: k,
        data: q.key === k ? q.data : null,
        accepted: q.key === k ? q.accepted : null,
      }));
      tradeApi
        .quote(JSON.parse(k), tokenDecimals)
        .then((data) => {
          if (latest.current !== k) return;
          const accepted = trustQuote(data, JSON.parse(k), tokenDecimals);
          const before = seen.current;
          if (accepted && before?.key === k && before.price !== data.price)
            setPriceNote({ from: before.price, to: data.price });
          if (accepted) seen.current = { key: k, price: data.price };
          setQuote(
            accepted
              ? { status: 'ready', key: k, data, accepted }
              : { status: 'untrusted', key: k, data: null, accepted: null },
          );
        })
        .catch((e) => {
          if (latest.current !== k) return;
          if (isUnauthorized(e)) expire();
          setQuote({ status: 'error', key: k, data: null, accepted: null });
        });
    },
    [tokenDecimals, expire],
  );
  useEffect(() => {
    setPriceNote(null);
    if (!quoteKey) {
      latest.current = '';
      setQuote({ status: 'idle', key: '', data: null, accepted: null });
      return;
    }
    const h = setTimeout(() => ask(quoteKey), 450);
    return () => clearTimeout(h);
  }, [quoteKey, ask]);
  useEffect(() => {
    if (
      !renewing &&
      !sessionEnded &&
      quote.status === 'error' &&
      quote.key === quoteKey &&
      quoteKey
    )
      ask(quoteKey);
    // Only when the session comes back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renewing, sessionEnded]);
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
  // A third party's ID is not asked where the rail's transfers do not need it (their bank has it).
  const noId = other && idOptional(rail);
  const sentDetails = noId ? withoutId(rail, account.details) : account.details;
  const accountErrors =
    side === 'SELL'
      ? checkBeneficiary(
          rail,
          {
            holderName: account.holderName,
            details: sentDetails,
            document: !noId && needsDocument(rail, account.details) ? account.document : '',
          },
          { idOptional: noId },
        )
      : {};
  const detailsOk =
    side === 'BUY'
      ? !Object.values(payerErrors).some(Boolean)
      : Object.keys(accountErrors).length === 0;

  const cta = (() => {
    if (!cur || !token) return { label: a.cta.unavailable, ok: false };
    if (!amount.trim()) return { label: a.cta.amount, ok: false };
    if (!amountOk) return { label: fmt(a.cta.badAmount, { n: decimals }), ok: false };
    // A session being renewed waits; one that could not be is blocked, never sent to sign in.
    if (renewing) return { label: t.common.sign.connecting, ok: false, busy: true };
    if (sessionEnded) return { label: a.cta.sessionEnded, ok: false };
    if (!session) return { label: a.cta.connect, ok: true, connect: true };
    if (!rail) return { label: a.cta.method, ok: false };
    if (quote.status === 'error' && quote.key === quoteKey)
      return { label: a.cta.noQuote, ok: false };
    if (quote.status === 'untrusted' && quote.key === quoteKey)
      return { label: a.cta.noQuote, ok: false };
    if (!fresh || !quote.accepted || expired)
      return { label: a.cta.quoting, ok: false, busy: true };
    return { label: a.cta.continue, ok: true };
  })();

  /* A worse price for the person: a purchase pays more local money per token, a sale gets less. */
  const worse = (now: string, before: string) =>
    side === 'BUY' ? Number(now) > Number(before) : Number(now) < Number(before);

  const guard = useGuard();
  const openOrder = () =>
    guard(async () => {
      if (!fresh || !quote.accepted || busy) return;
      setBusy(true);
      setError('');
      try {
        // A price about to run out is asked for again first. If the new one is worse, the person
        // sees it and confirms again; the same or better goes ahead.
        let q = fresh;
        let accepted = quote.accepted;
        if (quoteKey && msLeft(q.expiresAt, Date.now()) < 15_000) {
          const k = quoteKey;
          const data = await tradeApi.quote(JSON.parse(k), tokenDecimals);
          const trusted = trustQuote(data, JSON.parse(k), tokenDecimals);
          latest.current = k;
          if (!trusted) {
            setQuote({ status: 'untrusted', key: k, data: null, accepted: null });
            return;
          }
          seen.current = { key: k, price: data.price };
          setQuote({ status: 'ready', key: k, data, accepted: trusted });
          if (worse(data.price, q.price)) {
            setPriceNote({ from: q.price, to: data.price });
            toast(a.priceUpdatedConfirm, 'info');
            return;
          }
          q = data;
          accepted = trusted;
        }
        let body: BuyOrderInput | SellOrderInput;
        if (side === 'BUY')
          body = {
            side: 'BUY',
            quoteId: q.id,
            payer: { name: payer.name.trim(), document: payer.document.trim() },
          };
        else {
          const details = normalizeDetails(rail, sentDetails);
          const document = noId
            ? ''
            : (needsDocument(rail, account.details) ? account.document.trim() : '') ||
              documentOf(rail, details);
          body = {
            side: 'SELL',
            quoteId: q.id,
            beneficiary: {
              holderName: account.holderName.trim(),
              ...(document ? { document } : {}),
              details,
            },
          };
        }
        const order = await tradeApi.createOrder(body, tokenDecimals);
        if (body.side === 'BUY') remember(`payer.${currency}`, body.payer);
        else if (!other)
          remember(`account.${rail}`, { ...account, document: body.beneficiary.document ?? '' });
        setAmount('');
        setStep('form');
        if (other && body.side === 'SELL') saveRecipient(order.id, body.beneficiary.holderName);
        onOpened(order, accepted);
      } catch (e) {
        if (isUnauthorized(e)) {
          expire();
          return;
        }
        // The price ran out or its merchant can no longer fill it: a new price, said as such.
        if (
          e instanceof ApiError &&
          ['quote_expired', 'quote_not_found', 'no_match'].includes(e.code)
        ) {
          toast(a.priceUpdatedConfirm, 'info');
          if (quoteKey) ask(quoteKey);
          return;
        }
        setError(errorMessage(t.common, e, a.openFailed));
        if (quoteKey) ask(quoteKey);
      } finally {
        setBusy(false);
      }
    });

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

  // A sale's figure on the side not typed comes from the price: the local money as quoted, the
  // tokens cut (never rounded up) to the cent for dollars, as the app shows dollars everywhere.
  const tokenShown = (() => {
    if (!fresh) return '';
    const [whole, frac = ''] = fresh.tokenAmount.split('.');
    if (isDollarToken(symbol)) return `${whole}.${frac.slice(0, 2).padEnd(2, '0')}`;
    const cut = frac.slice(0, Math.min(tokenDecimals, 6)).replace(/0+$/, '');
    return cut ? `${whole}.${cut}` : whole;
  })();
  const amountBox = (unit: 'token' | 'fiat', first: boolean) => {
    const id = first ? 'trade-amount' : 'trade-get';
    const label =
      unit === 'fiat'
        ? side === 'BUY'
          ? a.youPay
          : other
            ? a.other.theyReceive
            : a.youReceive
        : other
          ? a.other.youSend
          : a.youSell;
    const typed = entry === unit;
    const value = typed ? amount : unit === 'fiat' ? (fresh?.fiatAmount ?? '') : tokenShown;
    const loading = !typed && quote.status === 'loading' && !value;
    // What the local money is in dollars, under the figure typed in it.
    const dollars =
      unit === 'fiat' && typed && side === 'SELL' && fresh && isDollarToken(symbol)
        ? fmt(t.app.approx, {
            amount: usd(lang, toBaseUnits(fresh.tokenAmount, USDC_DECIMALS) ?? '0', t.app.usd),
          })
        : null;
    return (
      <div
        className={`rounded-[18px] p-4 ${first ? 'bg-well' : 'border border-line'}`}
        aria-busy={loading || undefined}
      >
        <label htmlFor={id} className="text-[0.875rem] font-semibold text-ink-3">
          {label}
        </label>
        <div className="mt-1 flex items-center gap-3">
          {loading ? (
            <Skeleton className="h-9 w-2/3" />
          ) : (
            <input
              id={id}
              className="figure w-full min-w-0 bg-transparent text-[clamp(1.7rem,8vw,2.3rem)] outline-none placeholder:text-ink-3/50"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={value}
              onFocus={(e) => {
                if (!typed) e.currentTarget.select();
              }}
              onChange={(e) => {
                setBy(unit);
                setAmount(e.target.value.trim().replace(',', '.'));
              }}
              aria-invalid={typed && amount.trim() && !amountOk ? true : undefined}
            />
          )}
          {unit === 'fiat' ? currencyButton : tokenButton}
        </div>
        {dollars && (
          <p className="num mt-1 text-[0.875rem] text-ink-3" data-testid="trade-dollars">
            {dollars}
          </p>
        )}
      </div>
    );
  };
  const outText = fresh
    ? side === 'BUY'
      ? units(lang, fresh.netAmount, symbol)
      : money(lang, fresh.fiatAmount, currency)
    : '';
  // The number alone: the token button beside it already names the unit. Formatting may join
  // them with a no-break space, so any whitespace splits.
  const outFigure = outText.split(/\s/)[0];
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
  const priceNoteText = priceNote
    ? fmt(a.priceUpdated, {
        token: symbol,
        currency,
        price: rate(lang, priceNote.to),
        before: rate(lang, priceNote.from),
      })
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
          {side === 'BUY' ? a.buyer.title : other ? a.other.title : a.seller.title}
        </h2>
        <dl className="mt-4 grid grid-cols-2 gap-3 rounded-[16px] bg-well p-4 text-[0.9375rem]">
          <div>
            <dt className="text-ink-3">
              {side === 'BUY' ? a.youPay : other ? a.other.youSend : a.youSell}
            </dt>
            <dd className="num font-semibold">
              {side === 'BUY'
                ? money(lang, fresh.fiatAmount, currency)
                : units(lang, fresh.tokenAmount, symbol)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">{other ? a.other.theyReceive : a.youReceive}</dt>
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
        <p className="mt-4 text-ink-2">
          {side === 'BUY' ? a.buyer.body : other ? a.other.body : a.seller.body}
        </p>
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
              withId={!noId}
            />
          )}
        </div>
        {priceNote && (
          <div className="mt-4">
            <Notice tone="info">{priceNoteText}</Notice>
          </div>
        )}
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
      {!fixedSide && (
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
      )}
      <div
        id="trade-panel"
        role={fixedSide ? undefined : 'tabpanel'}
        aria-labelledby={fixedSide ? undefined : `trade-tab-${side}`}
        className={`${fixedSide ? '' : 'mt-4'} flex flex-col gap-2`}
      >
        {side === 'BUY' ? (
          <>
            {amountBox('fiat', true)}
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
                  className={`figure w-full min-w-0 truncate ${outSize(outFigure)} ${outText ? '' : 'text-ink-3/60'}`}
                >
                  {quote.status === 'loading' && !outText ? (
                    <Skeleton className="h-9 w-2/3" />
                  ) : outText ? (
                    outFigure
                  ) : (
                    '0'
                  )}
                </output>
                {tokenButton}
              </div>
            </div>
          </>
        ) : other ? (
          <>
            {amountBox('fiat', true)}
            {amountBox('token', false)}
          </>
        ) : (
          <>
            {amountBox('token', true)}
            {amountBox('fiat', false)}
          </>
        )}

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
            {Number(fresh.integratorFee) > 0 && quote.accepted && (
              <div className="flex flex-col gap-0.5">
                <div className="flex justify-between gap-3">
                  <span className="text-ink-3">{a.integratorFee}</span>
                  <span className="num">{units(lang, fresh.integratorFee, symbol)}</span>
                </div>
                <span className="text-[0.8125rem] text-ink-3">
                  {fmt(a.integratorFeeNote, {
                    rate: bpsLabel(
                      integratorBpsFor(
                        quote.accepted.amountUnits,
                        quote.accepted.integratorFeeUnits,
                      ) ?? 0,
                      lang,
                    ),
                  })}
                </span>
              </div>
            )}
          </div>
        )}

        {cur && (
          <div className="mt-1 flex flex-col gap-1.5">
            <label htmlFor="trade-rail" className="text-[0.875rem] font-semibold text-ink-3">
              {side === 'BUY' ? a.payWith : other ? a.other.receiveIn : a.receiveIn}
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

        {priceNote && <Notice tone="info">{priceNoteText}</Notice>}
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
        {quote.status === 'untrusted' && quote.key === quoteKey && (
          <Notice tone="error" stay>{a.quoteUntrusted}</Notice>
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
