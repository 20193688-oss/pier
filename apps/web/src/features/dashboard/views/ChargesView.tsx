/* Charges (collections): a link and a QR code someone pays in local money with a bank transfer,
   settled to one of the organization's wallets in USDC. Create one, share its link, cancel an
   open one; the list shows what is open, paid, reusable or expired. */
import { useMemo, useState } from 'react';
import { fmt, useI18n } from '@/i18n';
import { accounts as accountsApi, charges as chargesApi } from '@/lib/api/endpoints';
import { errorMessage } from '@/lib/api/messages';
import { parseFiat } from '@/lib/p2p/amounts';
import { defaultCurrency, fiatDecimals } from '@/lib/p2p/rails';
import { currencyName, dateTime, money, shortAddress } from '@/lib/format';
import type { P2pAccount, P2pCharge } from '@/lib/p2p/types';
import { Check, Field, Notice, SelectField, Spinner } from '@/components/ui/controls';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { CopyButton, Empty, Pill, Qr } from '@/components/ui/misc';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { useDash } from '@/features/dashboard/context';
import { Figures, LoadState, PageHead, ReadOnly, useLoad } from '@/features/dashboard/ui';
import {
  CHARGE_EXPIRIES,
  chargeFigures,
  expiryIso,
  type ChargeExpiry,
} from '@/features/dashboard/views/admin-model';
import { useGuard } from '@/lib/use-action';

const STATUS_TONE = { open: 'ref', paid: 'ok', expired: 'off', cancelled: 'fail' } as const;

export function ChargesView() {
  const { t, lang } = useI18n();
  const c = t.p2p.charges;
  const a = t.admin.charges;
  const toast = useToast();
  const { scope, canWrite } = useDash();
  const load = useLoad(() => chargesApi.list(scope), [scope.org, scope.tier]);
  const [creating, setCreating] = useState(false);
  const [sharing, setSharing] = useState<P2pCharge | null>(null);
  const [cancelling, setCancelling] = useState<P2pCharge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const guard = useGuard();
  const cancel = (charge: P2pCharge) =>
    guard(async () => {
      setBusy(true);
      setError('');
      try {
        await chargesApi.remove(scope, charge.id);
        toast(a.cancelled);
        setCancelling(null);
        load.reload();
      } catch (e) {
        setError(errorMessage(t.common, e));
      } finally {
        setBusy(false);
      }
    });

  const figures = load.data ? chargeFigures(load.data) : null;
  return (
    <>
      <PageHead
        title={c.title}
        lede={a.lede}
        actions={
          canWrite && (
            <button type="button" className="btn btn-ink" onClick={() => setCreating(true)}>
              <Icon name="plus" size={18} />
              {c.create}
            </button>
          )
        }
      />
      {!canWrite && <ReadOnly />}
      {figures && (
        <Figures
          label={c.figuresLabel}
          items={[
            { label: c.figures.open, value: figures.open },
            { label: c.figures.paid, value: figures.paid },
            { label: c.figures.reusable, value: figures.reusable },
            { label: c.figures.expired, value: figures.expired },
          ]}
        />
      )}
      {error && (
        <Notice tone="error" className="mb-4">
          {error}
        </Notice>
      )}
      <LoadState load={load} empty={<Empty title={a.empty} body={a.emptyBody} />}>
        {(list) => (
          <ul className="flex flex-col gap-3" role="list" aria-label={c.title}>
            {list.map((charge) => (
              <li key={charge.id} className="sheet flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="font-semibold">{charge.description || a.noDescription}</p>
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[0.875rem] text-ink-3">
                    <span>{charge.multiUse ? c.reusable : c.singleUse}</span>
                    {charge.orders ? <span>{fmt(a.usesN, { n: charge.orders })}</span> : null}
                    <span>
                      {charge.expiresAt
                        ? fmt(a.expiresOn, { date: dateTime(lang, charge.expiresAt) })
                        : `${c.head.expires}: ${c.noExpiry}`}
                    </span>
                  </p>
                </div>
                <p className="figure text-[1.15rem]">
                  {money(lang, charge.fiatAmount, charge.currency)}
                </p>
                <Pill tone={STATUS_TONE[charge.status]}>{c.state[charge.status]}</Pill>
                <div className="flex gap-2">
                  {charge.status === 'open' && (
                    <button
                      type="button"
                      className="btn btn-line btn-sm"
                      onClick={() => setSharing(charge)}
                    >
                      <Icon name="link" size={16} />
                      {c.share}
                    </button>
                  )}
                  {canWrite && charge.status === 'open' && (
                    <button
                      type="button"
                      className="btn btn-quiet btn-sm"
                      onClick={() => setCancelling(charge)}
                    >
                      {a.cancel}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </LoadState>

      {creating && (
        <CreateCharge
          onClose={() => setCreating(false)}
          onCreated={(charge) => {
            setCreating(false);
            toast(c.created);
            load.reload();
            setSharing(charge);
          }}
        />
      )}
      {sharing && <ShareCharge charge={sharing} onClose={() => setSharing(null)} />}
      {cancelling && (
        <ConfirmDialog
          title={a.cancelTitle}
          body={fmt(a.cancelBody, {
            name: cancelling.description || money(lang, cancelling.fiatAmount, cancelling.currency),
          })}
          confirmLabel={a.cancel}
          danger
          busy={busy}
          onConfirm={() => void cancel(cancelling)}
          onClose={() => setCancelling(null)}
        />
      )}
    </>
  );
}

function ShareCharge({ charge, onClose }: { charge: P2pCharge; onClose: () => void }) {
  const { t, lang } = useI18n();
  const c = t.p2p.charges;
  const a = t.admin.charges;
  return (
    <Dialog title={a.shareTitle} onClose={onClose}>
      <p className="text-ink-2">{a.shareBody}</p>
      <p className="figure mt-4 text-[1.5rem]">{money(lang, charge.fiatAmount, charge.currency)}</p>
      {charge.description && <p className="mt-1 text-ink-2">{charge.description}</p>}
      <div className="mt-4 flex flex-col items-center gap-2">
        <Qr value={charge.url} label={c.qrAlt} size={200} />
        <span className="text-[0.875rem] text-ink-3">{c.scan}</span>
      </div>
      <div className="mt-4 flex flex-col gap-1.5">
        <span className="text-[0.875rem] font-semibold text-ink-2">{c.link}</span>
        <div className="flex items-center gap-2 rounded-[14px] bg-well p-3">
          <code className="num min-w-0 flex-1 break-all text-[0.875rem]" data-testid="charge-link">
            {charge.url}
          </code>
          <CopyButton value={charge.url} label={c.link} />
        </div>
      </div>
      <a
        href={charge.url}
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-line mt-4 w-full"
      >
        <Icon name="external" size={16} />
        {c.openPage}
      </a>
    </Dialog>
  );
}

function CreateCharge({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (c: P2pCharge) => void;
}) {
  const { t, lang } = useI18n();
  const c = t.p2p.charges;
  const a = t.admin.charges;
  const { scope, market, org } = useDash();
  const wallets = useLoad<P2pAccount[]>(() => accountsApi.list(scope), [scope.org, scope.tier]);
  const pairs = useMemo(
    () =>
      (market?.networks ?? []).flatMap((n) =>
        n.tokens.map((tk) => ({
          value: `${n.id}:${tk.symbol}`,
          label: fmt(t.trade.summary.onNetwork, { token: tk.symbol, network: n.name }),
        })),
      ),
    [market, t],
  );
  const [currency, setCurrency] = useState(() => defaultCurrency(market?.currencies ?? []));
  const [pair, setPair] = useState(() => pairs[0]?.value ?? '');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [payeeName, setPayeeName] = useState(org.name);
  const [description, setDescription] = useState('');
  const [expiry, setExpiry] = useState<ChargeExpiry>('24h');
  const [multiUse, setMultiUse] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const list = wallets.data ?? [];
  const to = recipient || list[0]?.id || '';
  const cur = currency || market?.currencies[0]?.code || '';
  const pick = pair || pairs[0]?.value || '';
  const fiat = parseFiat(amount, cur);
  const amountError = touched && !fiat ? a.amountError : null;
  const payeeError = touched && !payeeName.trim() ? a.payeeError : null;

  const guard = useGuard();
  const submit = () =>
    guard(async () => {
      setTouched(true);
      if (!fiat || !payeeName.trim() || !to || !pick) return;
      const [network, token] = pick.split(':');
      setBusy(true);
      setError('');
      try {
        const expiresAt = expiryIso(expiry);
        onCreated(
          await chargesApi.create(scope, {
            currency: cur,
            fiatAmount: fiat,
            network,
            token,
            recipient: to,
            payeeName: payeeName.trim(),
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(expiresAt ? { expiresAt } : {}),
            multiUse,
          }),
        );
      } catch (e) {
        setError(errorMessage(t.common, e, c.createFailed));
      } finally {
        setBusy(false);
      }
    });

  const ready = !!market && wallets.data !== undefined;
  return (
    <Dialog
      title={a.createTitle}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn btn-line" onClick={onClose}>
            {t.common.actions.cancel}
          </button>
          <button
            type="button"
            className="btn btn-ink"
            disabled={busy || !ready || !list.length}
            onClick={() => void submit()}
          >
            {busy && <Spinner />}
            {busy ? a.creating : c.create}
          </button>
        </>
      }
    >
      {!market ? (
        <Notice tone="warn">{t.dash.state.noMarket}</Notice>
      ) : wallets.data === undefined ? (
        <p className="flex items-center gap-2 text-ink-3" role="status">
          <Spinner />
          {t.dash.state.loading}
        </p>
      ) : !list.length ? (
        <Notice tone="warn">{a.needWallet}</Notice>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={c.form.amount}
            value={amount}
            inputMode="decimal"
            autoComplete="off"
            placeholder={fiatDecimals(cur) ? '25000.00' : '25000'}
            onChange={(e) => setAmount(e.target.value.trim().replace(',', '.'))}
            onBlur={() => setTouched(true)}
            error={amountError}
          />
          <SelectField
            label={a.currency}
            value={cur}
            onChange={(e) => setCurrency(e.target.value)}
            options={market.currencies.map((x) => ({
              value: x.code,
              label: `${x.code} (${currencyName(x.code, lang)})`,
            }))}
          />
          <SelectField
            label={a.network}
            value={pick}
            onChange={(e) => setPair(e.target.value)}
            options={pairs}
          />
          <SelectField
            label={c.recipient}
            hint={c.form.recipientHint}
            value={to}
            onChange={(e) => setRecipient(e.target.value)}
            options={list.map((w) => ({
              value: w.id,
              label: w.label ? `${w.label} (${shortAddress(w.address)})` : shortAddress(w.address),
            }))}
          />
          <Field
            label={c.form.payeeName}
            hint={c.form.payeeHint}
            value={payeeName}
            maxLength={60}
            onChange={(e) => setPayeeName(e.target.value)}
            onBlur={() => setTouched(true)}
            error={payeeError}
          />
          <Field
            label={c.description}
            hint={c.form.descriptionHint}
            value={description}
            maxLength={200}
            placeholder={a.descriptionPlaceholder}
            onChange={(e) => setDescription(e.target.value)}
          />
          <SelectField
            label={a.expiry}
            value={expiry}
            onChange={(e) => setExpiry(e.target.value as ChargeExpiry)}
            options={CHARGE_EXPIRIES.map((x) => ({ value: x, label: c.form.expiries[x] }))}
          />
          <div className="self-end pb-2">
            <Check
              checked={multiUse}
              onChange={setMultiUse}
              title={c.form.multiUse}
              desc={c.form.multiUseHint}
            />
          </div>
        </div>
      )}
      {error && (
        <Notice tone="error" className="mt-4">
          {error}
        </Notice>
      )}
    </Dialog>
  );
}
