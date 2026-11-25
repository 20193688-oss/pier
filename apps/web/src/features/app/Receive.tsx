/* Receive, in two tabs.
   - "Show QR": you, as a contact card: your initial, your @handle and short address, your QR on
     white (a payment link with no amount), copy and share, and your link and address to copy.
   - "Ask for an amount": the unit (a token of the network, or any currency the market pays out
     in), the amount typed on the keypad with what it is worth or what reaches the wallet under
     it, and a note; beside it (under it on a phone) the request it makes: its QR, its link,
     copy and share, and the SEP-7 switch.
   A request is a payment link by default (this app's /app/send?to=@handle...), which any phone
   camera opens; with the SEP-7 switch, a standard `web+stellar:pay` request for other Stellar
   wallets. An amount in a currency becomes the wallet's token at the market's price. The home's
   keypad opens this screen on the second tab with its amount (`?tab=ask&amount=12.5`). */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { buildPaymentLink, buildSep7Pay } from '@pier/payment-qr';
import { fmt, useI18n } from '@/i18n';
import { Field, Notice, Switch } from '@/components/ui/controls';
import { CopyButton, CopyRow, Qr } from '@/components/ui/misc';
import { Icon } from '@/components/ui/Icon';
import { CurrencyMark, PickerSheet, TokenMark } from '@/components/p2p/parts';
import { currencyName, shortAddress } from '@/lib/format';
import { isQrRail } from '@/lib/p2p/qr-pay';
import { useSession } from '@/lib/session';
import { parseDecimal, toBaseUnits } from '@/lib/p2p/amounts';
import { fiatDecimals } from '@/lib/p2p/rails';
import { isDollarToken, tokensForLocal } from '@/lib/app/money';
import { useAppData, usePrice } from '@/features/app/data';
import { Screen } from '@/features/app/shell';
import { ActivationCard, useLocal, useUsd } from '@/features/app/parts';
import { Keypad, shownAmount, typedValue, useKeypad } from '@/features/app/keypad';

export default function Receive() {
  const { t, lang } = useI18n();
  const r = t.app.receive;
  const { session } = useSession();
  const { market, profile, network, token: appToken, needsActivation } = useAppData();
  const fmtUsd = useUsd();
  const localOf = useLocal();
  const [params] = useSearchParams();
  // The unit the amount is typed in: `token:USDC`, `token:XLM` or `fiat:BOB`; the wallet's token
  // to start with.
  const [unit, setUnit] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const tokens = network?.tokens ?? [];
  const currencies = (market?.currencies ?? []).filter((c) => c.rails.some((x) => !isQrRail(x)));
  const unitKey = unit ?? (appToken ? `token:${appToken.symbol}` : '');
  const [unitKind, unitCode] = unitKey.split(':') as ['token' | 'fiat', string];
  const fiat = unitKind === 'fiat' ? unitCode : null;
  // The token the request is in: the one picked, or (an amount in a currency) the wallet's own.
  const token = (fiat ? null : tokens.find((x) => x.symbol === unitCode)) ?? appToken;
  const price = usePrice(fiat);
  const [note, setNote] = useState('');
  const [sep7, setSep7] = useState(false);
  const [tab, setTab] = useState<'qr' | 'ask'>(() =>
    params.get('tab') === 'ask' || params.get('amount') ? 'ask' : 'qr',
  );
  const address = session?.address ?? '';
  const decimals = fiat ? fiatDecimals(fiat) : token && isDollarToken(token.symbol) ? 2 : 7;
  // The keypad on the home opens this screen with an amount (`?tab=ask&amount=12.5`).
  const fromHome = params.get('amount') ?? '';
  const keypad = useKeypad({
    initial: /^\d+(\.\d{1,7})?$/.test(fromHome) ? fromHome : '',
    maxDecimals: decimals,
  });
  const amount = typedValue(keypad.typed);
  const typed = amount ? parseDecimal(amount, decimals) : null;
  const amountOk = !amount || typed !== null;
  const noteOk = new TextEncoder().encode(note).length <= 28;
  // What the request asks for, in the token. An amount in a currency needs a price first: without
  // one the QR waits rather than leave the amount out.
  const wanted = typed && Number(typed) > 0 ? typed : null;
  const asked = wanted && fiat ? tokensForLocal(wanted, price) : wanted;
  const waiting = !!wanted && !asked;
  const askedText = asked && token ? fmtUsd(toBaseUnits(asked, 7) ?? '0', token.symbol) : '';
  const hint = !wanted
    ? undefined
    : fiat
      ? asked
        ? fmt(r.arrives, { amount: askedText })
        : price === null
          ? fmt(r.noPrice, { currency: fiat, unit: token?.symbol ?? '' })
          : undefined
      : token?.symbol === appToken?.symbol
        ? (localOf(toBaseUnits(wanted, 7) ?? '0') ?? undefined)
        : undefined;
  const pickUnit = (key: string) => {
    setPicking(false);
    if (key === unitKey) return;
    setUnit(key);
    keypad.setTyped('');
  };
  const unitMark = fiat ? (
    <CurrencyMark code={fiat} size={24} />
  ) : (
    <TokenMark symbol={unitCode} network={network?.name} size={24} />
  );

  const build = (a: string | null, n: string | null) => {
    if (!address || !token || !network) return null;
    try {
      return sep7
        ? buildSep7Pay({
            destination: address,
            amount: a,
            // The native coin (XLM) is named by no asset code or issuer.
            assetCode: token.issuer ? token.code : null,
            assetIssuer: token.issuer,
            memo: n,
            networkPassphrase: network.networkPassphrase,
          })
        : buildPaymentLink(location.origin, {
            to: profile?.handle ? `@${profile.handle}` : address,
            amount: a,
            asset: token.symbol,
            note: n,
          });
    } catch {
      return null;
    }
  };
  const value = useMemo(
    () => (!amountOk || !noteOk || waiting ? null : build(asked, note.trim() || null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [address, token, network, asked, waiting, note, sep7, profile, amountOk, noteOk],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const plain = useMemo(() => build(null, null), [address, token, network, sep7, profile]);

  const shareButtons = (link: string | null) =>
    link && (
      <div
        className={`grid w-full gap-2 ${typeof navigator.share === 'function' ? 'grid-cols-2' : 'grid-cols-1'}`}
      >
        <CopyButton value={link} label={r.copyLink} className="btn-lg w-full" />
        {typeof navigator.share === 'function' && (
          <button
            type="button"
            className="btn btn-ink btn-lg"
            onClick={() =>
              void navigator
                .share({ text: fmt(r.shareText, { brand: t.common.brand, link }) })
                .catch(() => {})
            }
          >
            <Icon name="share" size={20} />
            {r.share}
          </button>
        )}
      </div>
    );
  const sep7Row = (
    <div className="sheet flex items-center justify-between gap-4 px-5 py-4">
      <span className="flex flex-col">
        <b className="font-semibold">{r.sep7}</b>
        <span className="text-[0.875rem] text-ink-3">{r.sep7Hint}</span>
      </span>
      <Switch label={r.sep7} checked={sep7} onChange={setSep7} />
    </div>
  );
  const qrOnWhite = (link: string | null, size: number) => (
    <div className="rounded-[30px] bg-white p-3 shadow-[var(--shadow-float)]">
      {link ? (
        <Qr value={link} label={r.qrLabel} size={size} />
      ) : (
        <div className="skeleton" style={{ width: size, height: size }} />
      )}
    </div>
  );
  const figure = fiat
    ? `${shownAmount(lang, keypad.typed || '0')} ${fiat}`
    : token && isDollarToken(token.symbol)
      ? t.app.usd.replace('{amount}', shownAmount(lang, keypad.typed || '0'))
      : `${shownAmount(lang, keypad.typed || '0')} ${unitCode}`;

  return (
    <Screen title={r.title} width="page">
      <div className="flex flex-col gap-5 pb-6">
        {needsActivation && (
          <div className="flex flex-col gap-4">
            <Notice tone="warn">{r.inactive}</Notice>
            <ActivationCard />
          </div>
        )}
        <div className="seg md:max-w-md" role="tablist" aria-label={r.title}>
          <button
            type="button"
            role="tab"
            id="receive-tab-qr"
            aria-selected={tab === 'qr'}
            aria-controls="receive-panel"
            onClick={() => setTab('qr')}
          >
            {r.tabQr}
          </button>
          <button
            type="button"
            role="tab"
            id="receive-tab-ask"
            aria-selected={tab === 'ask'}
            aria-controls="receive-panel"
            onClick={() => setTab('ask')}
          >
            {r.tabAsk}
          </button>
        </div>

        {tab === 'qr' ? (
          <div
            id="receive-panel"
            role="tabpanel"
            aria-labelledby="receive-tab-qr"
            className="flex flex-col items-center gap-5 pt-2 text-center md:mx-auto md:w-full md:max-w-md"
          >
            <div className="flex flex-col items-center gap-2">
              <span
                className="glass-strong grid size-[68px] place-items-center rounded-full text-[1.75rem] font-semibold text-ink uppercase"
                aria-hidden="true"
              >
                {profile?.handle ? profile.handle.slice(0, 1) : <Icon name="user" size={28} />}
              </span>
              <p className="text-[1.625rem] leading-tight font-semibold tracking-[-0.02em]">
                {profile?.handle ? `@${profile.handle}` : network?.name}
              </p>
              <p className="num text-[0.9375rem] text-ink-3">{shortAddress(address)}</p>
            </div>
            {qrOnWhite(plain, 236)}
            <p className="max-w-xs text-[0.9375rem] text-ink-2">
              {fmt(r.body, { brand: t.common.brand })}
            </p>
            {shareButtons(plain)}
            {!profile?.handle && <p className="text-[0.875rem] text-ink-3">{r.noHandle}</p>}
            <div className="sheet w-full divide-y divide-line px-5 text-left">
              {plain && !sep7 && <CopyRow label={r.link} value={plain} />}
              <CopyRow label={r.address} value={address} />
            </div>
            <div className="w-full text-left">{sep7Row}</div>
          </div>
        ) : (
          <div
            id="receive-panel"
            role="tabpanel"
            aria-labelledby="receive-tab-ask"
            className="grid gap-5 md:grid-cols-[minmax(0,440px)_minmax(0,340px)] md:items-start md:gap-10"
          >
            <section className="sheet flex flex-col items-center gap-1 p-5 text-center md:p-6">
              {/* Any unit: a token of the network or a currency, from one picker. */}
              <button
                type="button"
                className="glass flex items-center gap-2 rounded-full py-1.5 pr-3 pl-1.5 transition-colors hover:bg-well"
                onClick={() => setPicking(true)}
                aria-haspopup="dialog"
                aria-label={fmt(r.changeUnit, { unit: unitCode })}
                data-testid="receive-unit"
              >
                {unitMark}
                <b className="font-bold">{unitCode}</b>
                <Icon name="chevron" size={16} />
              </button>
              <h2 className="sr-only">{fmt(r.amountIn, { unit: unitCode })}</h2>
              <p
                className={`figure mt-4 text-[clamp(2.4rem,12vw,3.5rem)] ${keypad.typed ? 'text-ink' : 'text-ink-3'}`}
                aria-live="polite"
              >
                {figure}
              </p>
              <p
                className={`num mt-1 min-h-[1.5rem] text-[0.9375rem] ${amountOk ? 'text-ink-2' : 'text-bad'}`}
              >
                {amountOk ? (hint ?? '') : t.app.send.badAmount}
              </p>
              <Keypad
                onPress={keypad.press}
                decimals={decimals > 0}
                className="mt-2 w-full max-w-sm"
              />
              <div className="mt-4 w-full text-left">
                <Field
                  label={r.note}
                  value={note}
                  maxLength={28}
                  onChange={(e) => setNote(e.target.value)}
                  error={noteOk ? null : t.app.send.noteTooLong}
                />
              </div>
            </section>
            <aside className="flex flex-col items-center gap-4 md:sticky md:top-24">
              <p className="caps self-start text-ink-3">{r.preview}</p>
              {qrOnWhite(value, 200)}
              {wanted && asked && (
                <p className="figure text-[1.5rem]">
                  {askedText}
                  {fiat && (
                    <span className="block text-[0.9375rem] font-normal text-ink-3">{figure}</span>
                  )}
                </p>
              )}
              {shareButtons(value)}
              {value && !sep7 && (
                <div className="sheet w-full px-5 text-left">
                  <CopyRow label={r.link} value={value} />
                </div>
              )}
              <div className="w-full">{sep7Row}</div>
            </aside>
          </div>
        )}

        {picking && (
          <PickerSheet
            title={r.unit}
            searchLabel={t.trade.searchCurrency}
            selected={unitKey}
            onClose={() => setPicking(false)}
            onPick={pickUnit}
            items={[
              ...tokens.map((x) => ({
                key: `token:${x.symbol}`,
                mark: <TokenMark symbol={x.symbol} network={network?.name} size={34} />,
                title: x.symbol,
                sub: network?.name ?? '',
                search: `${x.symbol} ${x.code}`,
              })),
              ...currencies.map((c) => ({
                key: `fiat:${c.code}`,
                mark: <CurrencyMark code={c.code} size={34} />,
                title: c.code,
                sub: currencyName(c.code, lang),
                search: `${c.code} ${currencyName(c.code, lang)}`,
              })),
            ]}
          />
        )}
      </div>
    </Screen>
  );
}
