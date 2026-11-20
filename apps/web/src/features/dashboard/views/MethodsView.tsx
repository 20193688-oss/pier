/* Payment methods: the bank accounts, PIX keys or CLABEs a merchant is paid into. Each rail's
   form checks its fields as typed (CBU/CVU check digits, CUIT, CPF/CNPJ, CLABE, RUT...) before
   anything is sent; buyers matched to the merchant's offers see the active one for their rail. */
import { useMemo, useState } from 'react';
import { fmt, useI18n } from '@/i18n';
import { accounts as accountsApi, methods as methodsApi } from '@/lib/api/endpoints';
import { errorMessage } from '@/lib/api/messages';
import { accountRails, checkAccount, normalizeDetails } from '@/lib/p2p/rails';
import { dateOnly } from '@/lib/format';
import { Field, Notice, SelectField, Spinner, Switch } from '@/components/ui/controls';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { Empty, Pill } from '@/components/ui/misc';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import {
  AccountFields,
  CurrencyMark,
  accountRows,
  emptyAccount,
  railName,
  type AccountDraft,
} from '@/components/p2p/parts';
import { useDash } from '@/features/dashboard/context';
import { Figures, LoadState, PageHead, ReadOnly, useLoad } from '@/features/dashboard/ui';
import type { P2pAccount, P2pMarket, P2pPaymentMethod } from '@/lib/p2p/types';

export function MethodsView() {
  const { t, lang } = useI18n();
  const m = t.p2p.methods;
  const toast = useToast();
  const { scope, market, canWrite } = useDash();
  const load = useLoad(
    () => Promise.all([methodsApi.list(scope), accountsApi.list(scope)]),
    [scope.org, scope.tier],
  );
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<P2pPaymentMethod | null>(null);
  const [error, setError] = useState('');
  const [methods, accounts] = load.data ?? [[], []];
  const figures = useMemo(
    () => ({
      total: methods.length,
      active: methods.filter((x) => x.active).length,
      currencies: new Set(methods.map((x) => x.currency)).size,
      wallets: new Set(methods.map((x) => x.accountId)).size,
    }),
    [methods],
  );

  const toggle = async (method: P2pPaymentMethod, active: boolean) => {
    setError('');
    try {
      await methodsApi.update(scope, method.id, { active });
      toast(active ? m.activated : m.deactivated);
      load.reload();
    } catch (e) {
      setError(errorMessage(t.common, e, m.saveFailed));
    }
  };
  const remove = async (method: P2pPaymentMethod) => {
    setError('');
    try {
      await methodsApi.remove(scope, method.id);
      toast(m.deleted);
      setDeleting(null);
      load.reload();
    } catch (e) {
      setError(errorMessage(t.common, e, m.deleteFailed));
    }
  };
  const accountName = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a?.label ?? a?.merchant?.displayName ?? id;
  };

  return (
    <>
      <PageHead
        title={m.title}
        actions={
          canWrite && (
            <button
              type="button"
              className="btn btn-ink"
              disabled={!accounts.length || !market}
              onClick={() => setCreating(true)}
            >
              <Icon name="plus" size={18} />
              {m.create}
            </button>
          )
        }
      />
      {!canWrite && <ReadOnly />}
      {load.data && !accounts.length && <Notice className="mb-6">{t.dash.state.needWallet}</Notice>}
      {error && (
        <Notice tone="error" className="mb-4">
          {error}
        </Notice>
      )}
      {load.data && (
        <Figures
          label={m.figuresLabel}
          items={[
            { label: m.figures.methods, value: figures.total },
            { label: m.figures.active, value: figures.active },
            { label: m.figures.currencies, value: figures.currencies },
            { label: m.figures.wallets, value: figures.wallets },
          ]}
        />
      )}
      <LoadState
        load={load}
        isEmpty={(d) => d[0].length === 0}
        empty={<Empty title={m.title} body={m.form.activeHint} />}
      >
        {() => (
          <ul className="flex flex-col gap-3" role="list">
            {methods.map((method) => (
              <li key={method.id} className="sheet p-4">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <CurrencyMark code={method.currency} size={36} />
                    <div className="min-w-0">
                      <p className="font-semibold">
                        {railName(t.p2p, method.rail)}
                        {method.label ? `: ${method.label}` : ''}
                      </p>
                      <p className="text-[0.875rem] text-ink-3">
                        {method.holderName}, {method.summary ?? ''} {accountName(method.accountId)}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-[0.875rem] text-ink-3">
                    <Pill tone={method.active ? 'ok' : 'off'}>
                      {method.active ? m.active : m.inactive}
                    </Pill>
                    <span>{dateOnly(lang, method.createdAt)}</span>
                    {canWrite && (
                      <>
                        <Switch
                          checked={method.active}
                          onChange={(on) => void toggle(method, on)}
                          label={method.active ? m.deactivate : m.activate}
                        />
                        <button
                          type="button"
                          className="btn btn-quiet btn-sm"
                          onClick={() => setDeleting(method)}
                          aria-label={m.delete}
                        >
                          <Icon name="close" size={16} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-[0.875rem] font-semibold text-ink-2">
                    {m.head.account}
                  </summary>
                  <dl className="mt-2 grid gap-x-6 gap-y-1 text-[0.9375rem] sm:grid-cols-2">
                    {accountRows(t.p2p, method).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3">
                        <dt className="text-ink-3">{k}</dt>
                        <dd className="num text-right break-all">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        )}
      </LoadState>

      {creating && market && (
        <MethodDialog
          market={market}
          accounts={accounts}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            toast(m.created);
            load.reload();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={m.deleteTitle}
          body={fmt(m.deleteBody, { name: deleting.label ?? railName(t.p2p, deleting.rail) })}
          confirmLabel={m.delete}
          danger
          onConfirm={() => void remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

function MethodDialog({
  market,
  accounts,
  onClose,
  onSaved,
}: {
  market: P2pMarket;
  accounts: P2pAccount[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const m = t.p2p.methods;
  const { scope } = useDash();
  const [accountId, setAccountId] = useState(
    (accounts.find((a) => a.merchant) ?? accounts[0])?.id ?? '',
  );
  const [currency, setCurrency] = useState(market.currencies[0]?.code ?? 'ARS');
  // A payment method is an account the merchant is paid into: never a QR rail.
  const rails = accountRails(market.currencies.find((c) => c.code === currency)?.rails ?? []);
  const [rail, setRail] = useState(rails[0] ?? '');
  const [label, setLabel] = useState('');
  const [account, setAccount] = useState<AccountDraft>(emptyAccount(rails[0] ?? ''));
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const errors = checkAccount(rail, { holderName: account.holderName, details: account.details });

  const save = async () => {
    setShowAll(true);
    if (Object.keys(errors).length || !rail || !accountId) return;
    setBusy(true);
    setError('');
    try {
      await methodsApi.create(scope, {
        accountId,
        currency,
        rail,
        holderName: account.holderName.trim(),
        details: normalizeDetails(rail, account.details),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(t.common, e, m.saveFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={m.create}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-line" onClick={onClose}>
            {t.common.actions.cancel}
          </button>
          <button type="button" className="btn btn-ink" disabled={busy} onClick={() => void save()}>
            {busy && <Spinner />}
            {m.create}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <SelectField
          label={m.head.wallet}
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          options={accounts.map((a) => ({
            value: a.id,
            label: a.label ?? a.merchant?.displayName ?? a.address,
          }))}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label={t.p2p.offers.currency}
            value={currency}
            onChange={(e) => {
              const next =
                accountRails(
                  market.currencies.find((c) => c.code === e.target.value)?.rails ?? [],
                )[0] ?? '';
              setCurrency(e.target.value);
              setRail(next);
              setAccount(emptyAccount(next));
            }}
            options={market.currencies.map((c) => ({ value: c.code, label: c.code }))}
          />
          <SelectField
            label={m.form.stepRail}
            value={rail}
            onChange={(e) => {
              setRail(e.target.value);
              setAccount(emptyAccount(e.target.value));
            }}
            options={rails.map((r) => ({ value: r, label: railName(t.p2p, r) }))}
          />
        </div>
        <Field
          label={m.form.label}
          value={label}
          placeholder={m.form.labelPlaceholder}
          hint={m.form.labelHint}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
        />
        <AccountFields
          key={rail}
          rail={rail}
          value={account}
          onChange={setAccount}
          errors={errors}
          showAll={showAll}
          withDocument={false}
        />
        <p className="text-[0.875rem] text-ink-3">{m.form.activeHint}</p>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}
