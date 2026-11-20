/* Offers: what each merchant wallet buys or sells, on which network and token, for which currency
   and rails, at what price and within which limits. A price older than its time-to-live is not
   matched until it is refreshed (by hand here, or by a bot through the API). */
import { useMemo, useState } from 'react';
import { fmt, useI18n } from '@/i18n';
import {
  accounts as accountsApi,
  methods as methodsApi,
  offers as offersApi,
  type OfferInput,
} from '@/lib/api/endpoints';
import { errorMessage } from '@/lib/api/messages';
import { parseDecimal } from '@/lib/p2p/amounts';
import { accountRails, fiatDecimals, isQrRailId } from '@/lib/p2p/rails';
import { ago, money, rate } from '@/lib/format';
import { Check, Field, Notice, SelectField, Spinner, Switch } from '@/components/ui/controls';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { Empty, Pill } from '@/components/ui/misc';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { CurrencyMark, railName } from '@/components/p2p/parts';
import { useDash } from '@/features/dashboard/context';
import { Figures, LoadState, PageHead, ReadOnly, useLoad } from '@/features/dashboard/ui';
import type { P2pAccount, P2pMarket, P2pOffer, P2pPaymentMethod } from '@/lib/p2p/types';

const TTLS = ['300', '900', '3600', '21600', '86400'] as const;

export const isStale = (
  o: Pick<P2pOffer, 'priceUpdatedAt' | 'priceTtlSeconds'>,
  now = Date.now(),
) => Date.parse(o.priceUpdatedAt) + o.priceTtlSeconds * 1000 < now;

export function OffersView() {
  const { t, lang } = useI18n();
  const o = t.p2p.offers;
  const toast = useToast();
  const { scope, market, canWrite } = useDash();
  const load = useLoad(
    () => Promise.all([offersApi.list(scope), accountsApi.list(scope), methodsApi.list(scope)]),
    [scope.org, scope.tier],
  );
  const [editing, setEditing] = useState<P2pOffer | 'new' | null>(null);
  const [deleting, setDeleting] = useState<P2pOffer | null>(null);
  const [error, setError] = useState('');

  const [offers, accounts, methods] = load.data ?? [[], [], []];
  const merchants = accounts.filter((a) => a.merchant);
  const figures = useMemo(() => {
    const active = offers.filter((x) => x.active && !isStale(x));
    return {
      total: offers.length,
      active: active.length,
      sell: offers.filter((x) => x.side === 'SELL_TOKEN').length,
      buy: offers.filter((x) => x.side === 'BUY_TOKEN').length,
      stale: offers.filter((x) => x.active && isStale(x)).length,
    };
  }, [offers]);

  const toggle = async (offer: P2pOffer, active: boolean) => {
    setError('');
    try {
      await offersApi.update(scope, offer.id, { active });
      toast(active ? o.activated : o.paused);
      load.reload();
    } catch (e) {
      setError(errorMessage(t.common, e, o.saveFailed));
    }
  };
  const remove = async (offer: P2pOffer) => {
    setError('');
    try {
      await offersApi.remove(scope, offer.id);
      toast(o.deleted);
      setDeleting(null);
      load.reload();
    } catch (e) {
      setError(errorMessage(t.common, e, o.deleteFailed));
    }
  };

  const nameOf = (id: string) => market?.networks.find((n) => n.id === id)?.name ?? id;
  const accountName = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a?.merchant?.displayName ?? a?.label ?? id;
  };

  return (
    <>
      <PageHead
        title={o.title}
        actions={
          canWrite && (
            <button
              type="button"
              className="btn btn-ink"
              disabled={!merchants.length || !market}
              onClick={() => setEditing('new')}
            >
              <Icon name="plus" size={18} />
              {o.create}
            </button>
          )
        }
      />
      {!canWrite && <ReadOnly />}
      {load.data && canWrite && !merchants.length && (
        <Notice className="mb-6">{o.needMerchant}</Notice>
      )}
      {error && (
        <Notice tone="error" className="mb-4">
          {error}
        </Notice>
      )}
      {load.data && (
        <Figures
          label={o.figuresLabel}
          items={[
            { label: o.figures.offers, value: figures.total },
            { label: o.figures.active, value: figures.active },
            {
              label: o.figures.sell,
              value: figures.sell,
              sub: fmt(o.figures.buySub, { n: figures.buy }),
            },
            { label: o.figures.stale, value: figures.stale, sub: o.figures.staleSub },
          ]}
        />
      )}
      <LoadState
        load={load}
        isEmpty={(d) => d[0].length === 0}
        empty={<Empty title={o.title} body={o.needMerchant} />}
      >
        {() => (
          <ul className="flex flex-col gap-3" role="list">
            {offers.map((offer) => {
              const stale = isStale(offer);
              const state = !offer.active ? 'paused' : stale ? 'stale' : 'active';
              return (
                <li
                  key={offer.id}
                  className="sheet flex flex-wrap items-center gap-x-6 gap-y-3 p-4"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <CurrencyMark code={offer.currency} size={36} />
                    <div className="min-w-0">
                      <p className="font-semibold">
                        {o.sides[offer.side]}: {offer.token}, {offer.currency}
                      </p>
                      <p className="text-[0.875rem] text-ink-3">
                        {nameOf(offer.network)},{' '}
                        {offer.rails.map((r) => railName(t.p2p, r)).join(', ')},{' '}
                        {accountName(offer.accountId)}
                      </p>
                    </div>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[0.9375rem] sm:grid-cols-3">
                    <div>
                      <dt className="text-[0.8125rem] text-ink-3">{o.head.price}</dt>
                      <dd className="num font-semibold">
                        {rate(lang, offer.price)} {offer.currency}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[0.8125rem] text-ink-3">{o.head.limits}</dt>
                      <dd className="num">
                        {fmt(o.limitsValue, {
                          min: money(lang, offer.minFiat, offer.currency),
                          max: money(lang, offer.maxFiat, offer.currency),
                        })}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[0.8125rem] text-ink-3">{o.head.updated}</dt>
                      <dd>{ago(offer.priceUpdatedAt, t.common.time)}</dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={state === 'active' ? 'ok' : state === 'stale' ? 'pend' : 'off'}>
                      {o.state[state]}
                    </Pill>
                    {canWrite && (
                      <>
                        <Switch
                          checked={offer.active}
                          onChange={(on) => void toggle(offer, on)}
                          label={offer.active ? o.pause : o.activate}
                        />
                        <button
                          type="button"
                          className="btn btn-line btn-sm"
                          onClick={() => setEditing(offer)}
                        >
                          {o.edit}
                        </button>
                        <button
                          type="button"
                          className="btn btn-quiet btn-sm"
                          onClick={() => setDeleting(offer)}
                          aria-label={o.delete}
                        >
                          <Icon name="close" size={16} />
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </LoadState>

      {editing && market && (
        <OfferDialog
          offer={editing === 'new' ? null : editing}
          market={market}
          merchants={merchants}
          methods={methods}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            setEditing(null);
            toast(created ? o.created : o.saved);
            load.reload();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={o.deleteTitle}
          body={fmt(o.deleteBody, {
            name: `${o.sides[deleting.side]} ${deleting.token}/${deleting.currency}`,
          })}
          confirmLabel={o.delete}
          danger
          onConfirm={() => void remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

function OfferDialog({
  offer,
  market,
  merchants,
  methods,
  onClose,
  onSaved,
}: {
  offer: P2pOffer | null;
  market: P2pMarket;
  merchants: P2pAccount[];
  methods: P2pPaymentMethod[];
  onClose: () => void;
  onSaved: (created: boolean) => void;
}) {
  const { t } = useI18n();
  const o = t.p2p.offers;
  const f = o.form;
  const { scope } = useDash();
  const [form, setForm] = useState<OfferInput>(() =>
    offer
      ? { ...offer, priceTtlSeconds: offer.priceTtlSeconds }
      : {
          accountId: merchants[0]?.id ?? '',
          side: 'SELL_TOKEN',
          network: market.networks[0]?.id ?? '',
          token: market.networks[0]?.tokens[0]?.symbol ?? 'USDC',
          currency: market.currencies[0]?.code ?? 'ARS',
          rails: accountRails(market.currencies[0]?.rails ?? []).slice(0, 1),
          price: '',
          priceTtlSeconds: 3600,
          minFiat: '',
          maxFiat: '',
          active: true,
        },
  );
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof OfferInput>(k: K, v: OfferInput[K]) =>
    setForm((x) => ({ ...x, [k]: v }));
  const network = market.networks.find((n) => n.id === form.network);
  const currency = market.currencies.find((c) => c.code === form.currency);
  // The QR rails (a shop's QR the merchant pays from its banking app) are for merchants that buy
  // tokens (BUY_TOKEN: QR payments are sales to the merchant); a seller is paid into an account.
  const railsOf = (side: OfferInput['side'], c = currency) =>
    side === 'BUY_TOKEN' ? (c?.rails ?? []) : accountRails(c?.rails ?? []);
  const sideRails = railsOf(form.side);
  const d = fiatDecimals(form.currency);
  const price = parseDecimal(form.price, 8);
  const min = parseDecimal(form.minFiat, d);
  const max = parseDecimal(form.maxFiat, d);
  const errors = {
    price: !price || Number(price) <= 0 ? t.p2p.errors.amount : null,
    min: min === null || Number(min) <= 0 ? t.p2p.errors.amount : null,
    max:
      max === null || Number(max) <= 0 || (min !== null && Number(max) < Number(min))
        ? t.p2p.errors.amount
        : null,
    rails: form.rails.length ? null : t.p2p.errors.required,
  };
  // A merchant that sells tokens is paid in its own accounts: each rail needs an active one.
  const missing =
    form.side === 'SELL_TOKEN'
      ? form.rails.filter(
          (r) => !methods.some((m) => m.accountId === form.accountId && m.rail === r && m.active),
        )
      : [];
  const valid = !Object.values(errors).some(Boolean) && !!network && !!currency && !missing.length;

  const save = async () => {
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    setError('');
    try {
      if (offer) {
        await offersApi.update(scope, offer.id, {
          price: price!,
          minFiat: min!,
          maxFiat: max!,
          priceTtlSeconds: form.priceTtlSeconds,
          rails: form.rails,
          active: form.active,
        });
        onSaved(false);
      } else {
        await offersApi.create(scope, { ...form, price: price!, minFiat: min!, maxFiat: max! });
        onSaved(true);
      }
    } catch (e) {
      setError(errorMessage(t.common, e, o.saveFailed));
    } finally {
      setBusy(false);
    }
  };

  const show = (e: string | null) => (touched ? e : null);
  return (
    <Dialog
      title={offer ? o.edit : o.create}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn btn-line" onClick={onClose}>
            {t.common.actions.cancel}
          </button>
          <button type="button" className="btn btn-ink" disabled={busy} onClick={() => void save()}>
            {busy && <Spinner />}
            {offer ? o.save : o.create}
          </button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {!offer && (
          <>
            <SelectField
              className="sm:col-span-2"
              label={o.wallet}
              value={form.accountId}
              onChange={(e) => set('accountId', e.target.value)}
              options={merchants.map((a) => ({
                value: a.id,
                label: a.merchant?.displayName ?? a.label ?? a.address,
              }))}
            />
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <span id="offer-side" className="text-[0.875rem] font-semibold text-ink-2">
                {o.side}
              </span>
              <div className="seg" role="group" aria-labelledby="offer-side">
                {(['SELL_TOKEN', 'BUY_TOKEN'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={form.side === s}
                    onClick={() =>
                      setForm((x) => ({
                        ...x,
                        side: s,
                        rails: x.rails.filter((r) => railsOf(s).includes(r)),
                      }))
                    }
                  >
                    {o.sides[s]}
                  </button>
                ))}
              </div>
              <p className="text-[0.8125rem] text-ink-3">{f.sideDesc[form.side]}</p>
            </div>
            <SelectField
              label={t.dash.liq.network}
              value={form.network}
              onChange={(e) => {
                const n = market.networks.find((x) => x.id === e.target.value);
                setForm((x) => ({
                  ...x,
                  network: e.target.value,
                  token: n?.tokens[0]?.symbol ?? x.token,
                }));
              }}
              options={market.networks.map((n) => ({ value: n.id, label: n.name }))}
            />
            <SelectField
              label={f.token}
              value={form.token}
              onChange={(e) => set('token', e.target.value)}
              options={(network?.tokens ?? []).map((x) => ({ value: x.symbol, label: x.symbol }))}
            />
            <SelectField
              label={o.currency}
              value={form.currency}
              onChange={(e) => {
                const c = market.currencies.find((x) => x.code === e.target.value);
                setForm((x) => ({
                  ...x,
                  currency: e.target.value,
                  rails: railsOf(x.side, c).slice(0, 1),
                }));
              }}
              options={market.currencies.map((c) => ({ value: c.code, label: c.code }))}
            />
          </>
        )}
        <fieldset className="flex flex-col gap-2 sm:col-span-2">
          <legend className="mb-1 text-[0.875rem] font-semibold text-ink-2">
            {o.head.methods}
          </legend>
          {sideRails.map((r) => (
            <Check
              key={r}
              checked={form.rails.includes(r)}
              onChange={(on) =>
                set('rails', on ? [...form.rails, r] : form.rails.filter((x) => x !== r))
              }
              title={railName(t.p2p, r)}
              desc={isQrRailId(r) ? f.qrRail : undefined}
            />
          ))}
          {touched && errors.rails && <p className="text-[0.8125rem] text-bad">{errors.rails}</p>}
        </fieldset>
        <Field
          label={fmt(f.price, { token: form.token, currency: form.currency })}
          inputMode="decimal"
          value={form.price}
          onChange={(e) => set('price', e.target.value.trim().replace(',', '.'))}
          hint={f.priceHint}
          error={show(errors.price)}
        />
        <SelectField
          label={f.ttl}
          value={String(form.priceTtlSeconds)}
          onChange={(e) => set('priceTtlSeconds', Number(e.target.value))}
          options={TTLS.map((s) => ({ value: s, label: f.ttls[s] }))}
        />
        <Field
          label={fmt(f.min, { currency: form.currency })}
          inputMode="decimal"
          value={form.minFiat}
          onChange={(e) => set('minFiat', e.target.value.trim().replace(',', '.'))}
          error={show(errors.min)}
        />
        <Field
          label={fmt(f.max, { currency: form.currency })}
          inputMode="decimal"
          value={form.maxFiat}
          onChange={(e) => set('maxFiat', e.target.value.trim().replace(',', '.'))}
          error={show(errors.max)}
        />
        <div className="sm:col-span-2">
          <Check
            checked={form.active}
            onChange={(on) => set('active', on)}
            title={f.active}
            desc={f.activeHint}
          />
        </div>
        {missing.length > 0 && (
          <Notice tone="warn" className="sm:col-span-2">
            <b className="block">{f.missingTitle}</b>
            {fmt(f.missingMethods, { methods: missing.map((r) => railName(t.p2p, r)).join(', ') })}
          </Notice>
        )}
        {error && (
          <Notice tone="error" className="sm:col-span-2">
            {error}
          </Notice>
        )}
      </div>
    </Dialog>
  );
}
