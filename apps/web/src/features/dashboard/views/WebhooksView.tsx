/* Webhooks: the organization's endpoints for this tier, the events each one receives, paused or
   active, and their recent deliveries. A new endpoint's signing secret is shown once, to copy; the
   page never keeps it. There is no rotate or test send: a leaked secret means a new endpoint. */
import { useState } from 'react';
import { Link } from 'react-router';
import { fmt, useI18n } from '@/i18n';
import { webhooks as webhooksApi } from '@/lib/api/endpoints';
import { errorMessage } from '@/lib/api/messages';
import { P2P_WEBHOOK_EVENTS } from '@/lib/p2p/types';
import type { CreatedWebhookEndpoint, WebhookEndpoint } from '@/lib/api/types';
import { ago, dateTime } from '@/lib/format';
import { Check, Field, Notice, Spinner, Switch } from '@/components/ui/controls';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { CopyButton, Empty, Pill } from '@/components/ui/misc';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { useDash } from '@/features/dashboard/context';
import { LoadState, PageHead, useLoad } from '@/features/dashboard/ui';
import { isWebhookUrl } from '@/features/dashboard/views/admin-model';

const DELIVERY_TONE = { pending: 'pend', delivered: 'ok', failed: 'fail' } as const;

export function WebhooksView() {
  const { t } = useI18n();
  const w = t.admin.webhooks;
  const toast = useToast();
  const { scope, canWrite } = useDash();
  const load = useLoad(() => webhooksApi.list(scope), [scope.org, scope.tier]);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedWebhookEndpoint | null>(null);
  const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const setActive = async (endpoint: WebhookEndpoint, active: boolean) => {
    setError('');
    load.setData((list) => list?.map((x) => (x.id === endpoint.id ? { ...x, active } : x)));
    try {
      await webhooksApi.update(scope, endpoint.id, { active });
      toast(active ? w.activated : w.deactivated);
    } catch (e) {
      setError(errorMessage(t.common, e));
      load.reload();
    }
  };

  const remove = async (endpoint: WebhookEndpoint) => {
    setBusy(true);
    setError('');
    try {
      await webhooksApi.remove(scope, endpoint.id);
      toast(w.deleted);
      setDeleting(null);
      load.reload();
    } catch (e) {
      setError(errorMessage(t.common, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead
        title={t.dash.nav.webhooks}
        lede={w.lede}
        actions={
          canWrite && (
            <button type="button" className="btn btn-ink" onClick={() => setCreating(true)}>
              <Icon name="plus" size={18} />
              {w.create}
            </button>
          )
        }
      />
      {!canWrite && <Notice className="mb-6">{w.ownersOnly}</Notice>}
      <aside className="mb-6 flex flex-wrap items-start gap-3 rounded-[16px] bg-well p-4">
        <Icon name="lock" className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <b>{w.verifyTitle}</b>
          <p className="mt-1 text-[0.9375rem] text-ink-2">{w.verifyBody}</p>
        </div>
        <Link to="/docs/webhooks" className="btn btn-line btn-sm">
          {w.verifyLink}
        </Link>
      </aside>
      {error && (
        <Notice tone="error" className="mb-4">
          {error}
        </Notice>
      )}
      <LoadState load={load} empty={<Empty title={w.empty} body={w.emptyBody} />}>
        {(list) => (
          <ul className="flex flex-col gap-3" role="list" aria-label={t.dash.nav.webhooks}>
            {list.map((endpoint) => (
              <li key={endpoint.id}>
                <EndpointRow
                  endpoint={endpoint}
                  canWrite={canWrite}
                  onActive={(v) => void setActive(endpoint, v)}
                  onDelete={() => setDeleting(endpoint)}
                />
              </li>
            ))}
          </ul>
        )}
      </LoadState>

      {creating && (
        <CreateEndpoint
          onClose={() => setCreating(false)}
          onCreated={(endpoint) => {
            setCreating(false);
            setCreated(endpoint);
            toast(w.created);
            load.reload();
          }}
        />
      )}
      {created && (
        <Dialog
          title={w.secretTitle}
          onClose={() => setCreated(null)}
          footer={
            <button type="button" className="btn btn-ink" onClick={() => setCreated(null)}>
              {w.saved}
            </button>
          }
        >
          <p className="mb-4 text-ink-2">{w.secretBody}</p>
          <p className="mb-1.5 text-[0.875rem] font-semibold text-ink-2">{w.secretLabel}</p>
          <div className="flex items-center gap-2 rounded-[14px] bg-well p-3">
            <code
              className="num min-w-0 flex-1 break-all text-[0.875rem]"
              data-testid="webhook-secret"
            >
              {created.secret}
            </code>
            <CopyButton value={created.secret} label={w.secretLabel} />
          </div>
        </Dialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={w.deleteTitle}
          body={fmt(w.deleteBody, { url: deleting.url })}
          confirmLabel={w.delete}
          danger
          busy={busy}
          onConfirm={() => void remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

function EndpointRow({
  endpoint,
  canWrite,
  onActive,
  onDelete,
}: {
  endpoint: WebhookEndpoint;
  canWrite: boolean;
  onActive: (v: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const w = t.admin.webhooks;
  const [open, setOpen] = useState(false);
  return (
    <div className="sheet p-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <p className="num break-all font-semibold">{endpoint.url}</p>
          <p className="mt-1 flex flex-wrap gap-x-3 text-[0.875rem] text-ink-3">
            {endpoint.description && <span>{endpoint.description}</span>}
            <span>{fmt(w.eventsN, { n: endpoint.events.length })}</span>
          </p>
        </div>
        {endpoint.active ? <Pill tone="ok">{w.active}</Pill> : <Pill tone="off">{w.paused}</Pill>}
        {canWrite && (
          <Switch
            checked={endpoint.active}
            onChange={onActive}
            label={fmt(w.activeLabel, { url: endpoint.url })}
          />
        )}
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-line btn-sm"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? w.hideDeliveries : w.showDeliveries}
          </button>
          {canWrite && (
            <button type="button" className="btn btn-quiet btn-sm" onClick={onDelete}>
              {w.delete}
            </button>
          )}
        </div>
      </div>
      {open && <Deliveries endpointId={endpoint.id} />}
    </div>
  );
}

function Deliveries({ endpointId }: { endpointId: string }) {
  const { t, lang } = useI18n();
  const w = t.admin.webhooks;
  const { scope } = useDash();
  const load = useLoad(
    () => webhooksApi.deliveries(scope, endpointId),
    [endpointId, scope.org, scope.tier],
  );
  return (
    <section className="mt-4 border-t border-line pt-4" aria-label={w.deliveries}>
      <h3 className="mb-3 text-[1rem]">{w.deliveries}</h3>
      <LoadState load={load} empty={<p className="text-ink-3">{w.deliveriesEmpty}</p>}>
        {(list) => (
          <ul className="flex flex-col divide-y divide-line" role="list">
            {list.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-[0.9375rem]"
              >
                <Pill tone={DELIVERY_TONE[d.status]}>{w.deliveryStatus[d.status]}</Pill>
                <code className="num text-[0.8125rem]">{d.event}</code>
                <span className="text-ink-3">{fmt(w.attempts, { n: d.attempts })}</span>
                {d.responseStatus !== null && (
                  <span className="text-ink-3">
                    {fmt(w.lastStatus, { code: d.responseStatus })}
                  </span>
                )}
                {d.status !== 'delivered' && d.nextAttemptAt && (
                  <span className="text-ink-3">
                    {fmt(w.nextAttempt, { time: dateTime(lang, d.nextAttemptAt) })}
                  </span>
                )}
                <span className="ml-auto text-ink-3" title={dateTime(lang, d.createdAt)}>
                  {ago(d.createdAt, t.common.time)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </LoadState>
    </section>
  );
}

function CreateEndpoint({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (e: CreatedWebhookEndpoint) => void;
}) {
  const { t } = useI18n();
  const w = t.admin.webhooks;
  const words = t.p2p.bots.events as Record<string, string>;
  const { scope } = useDash();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<string[]>([...P2P_WEBHOOK_EVENTS]);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const urlError = touched && !isWebhookUrl(url) ? w.urlError : null;
  const eventsError = touched && !events.length ? w.eventsError : null;

  const submit = async () => {
    setTouched(true);
    if (!isWebhookUrl(url) || !events.length) return;
    setBusy(true);
    setError('');
    try {
      onCreated(
        await webhooksApi.create(scope, {
          url: url.trim(),
          events,
          ...(description.trim() ? { description: description.trim() } : {}),
        }),
      );
    } catch (e) {
      setError(errorMessage(t.common, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={w.createTitle}
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
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy && <Spinner />}
            {busy ? w.creating : w.create}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field
          label={w.url}
          type="url"
          inputMode="url"
          value={url}
          placeholder={w.urlPlaceholder}
          hint={w.urlHint}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => setTouched(true)}
          error={urlError}
        />
        <Field
          label={w.description}
          value={description}
          maxLength={120}
          placeholder={w.descriptionPlaceholder}
          onChange={(e) => setDescription(e.target.value)}
        />
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 flex w-full items-center justify-between gap-3 text-[0.875rem] font-semibold text-ink-2">
            <span>{w.events}</span>
          </legend>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() => setEvents([...P2P_WEBHOOK_EVENTS])}
            >
              {w.selectAll}
            </button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setEvents([])}>
              {w.selectNone}
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {P2P_WEBHOOK_EVENTS.map((ev) => (
              <Check
                key={ev}
                checked={events.includes(ev)}
                onChange={(on) => setEvents((x) => (on ? [...x, ev] : x.filter((y) => y !== ev)))}
                title={<code className="text-[0.8125rem]">{ev}</code>}
                desc={words[ev]}
              />
            ))}
          </div>
          {eventsError && <p className="text-[0.8125rem] text-bad">{eventsError}</p>}
        </fieldset>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}
