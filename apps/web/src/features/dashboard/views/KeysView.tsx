/* API keys: the organization's keys for its server or bot, test or live, with scopes. A new key is
   shown once, in a dialog that asks the person to copy it; the page never keeps it. Owners and
   admins create and revoke; members read. */
import { useState } from 'react';
import { fmt, useI18n } from '@/i18n';
import { apiKeys } from '@/lib/api/endpoints';
import { errorMessage } from '@/lib/api/messages';
import { API_SCOPES, type ApiKey, type ApiScope, type CreatedApiKey } from '@/lib/api/types';
import type { Tier } from '@/lib/api/client';
import { ago, dateOnly } from '@/lib/format';
import { Check, Field, Notice, Spinner } from '@/components/ui/controls';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { CopyButton, Empty, Pill } from '@/components/ui/misc';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { useDash } from '@/features/dashboard/context';
import { LoadState, PageHead, useLoad } from '@/features/dashboard/ui';

export function KeysView() {
  const { t, lang } = useI18n();
  const k = t.dash.keys;
  const toast = useToast();
  const { org, tier, canWrite } = useDash();
  const load = useLoad(() => apiKeys.list(org.id), [org.id]);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const revoke = async (key: ApiKey) => {
    setBusy(true);
    setError('');
    try {
      await apiKeys.revoke(org.id, key.id);
      toast(k.revokedToast);
      setRevoking(null);
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
        title={k.title}
        lede={k.lede}
        actions={
          canWrite && (
            <button type="button" className="btn btn-ink" onClick={() => setCreating(true)}>
              <Icon name="plus" size={18} />
              {k.create}
            </button>
          )
        }
      />
      {!canWrite && <Notice className="mb-6">{k.ownersOnly}</Notice>}
      {error && (
        <Notice tone="error" className="mb-4">
          {error}
        </Notice>
      )}
      <LoadState load={load} empty={<Empty title={k.empty} body={k.emptyBody} />}>
        {(keys) => (
          <ul className="flex flex-col gap-3" role="list">
            {keys.map((key) => (
              <li
                key={key.id}
                className={`sheet flex flex-wrap items-center gap-x-6 gap-y-3 p-4 ${key.revokedAt ? 'opacity-60' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{key.name}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-[0.875rem] text-ink-3">
                    <code className="num rounded-md bg-well px-1.5 py-0.5 text-ink">
                      {key.prefix}…
                    </code>
                    {key.scopes.map((s) => (
                      <span key={s}>
                        {(k.scopeNames as Record<string, { title: string }>)[s]?.title ?? s}
                      </span>
                    ))}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[0.875rem] text-ink-3">
                  <Pill tone={key.tier === 'live' ? 'ok' : 'pend'}>{t.dash.tier[key.tier]}</Pill>
                  {key.revokedAt ? (
                    <Pill tone="off">{k.revoked}</Pill>
                  ) : (
                    <span>
                      {k.head.lastUsed}:{' '}
                      {key.lastUsedAt ? ago(key.lastUsedAt, t.common.time) : k.neverUsed}
                    </span>
                  )}
                  <span>
                    {k.head.created}: {dateOnly(lang, key.createdAt)}
                  </span>
                </div>
                {canWrite && !key.revokedAt && (
                  <button
                    type="button"
                    className="btn btn-line btn-sm"
                    onClick={() => setRevoking(key)}
                  >
                    {k.revoke}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </LoadState>

      {creating && (
        <CreateKey
          defaultTier={tier}
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            setCreated(key);
            load.reload();
          }}
        />
      )}
      {created && (
        <Dialog
          title={k.shownOnce}
          onClose={() => setCreated(null)}
          footer={
            <button type="button" className="btn btn-ink" onClick={() => setCreated(null)}>
              {k.copied}
            </button>
          }
        >
          <p className="mb-4 text-ink-2">{k.shownOnceBody}</p>
          <div className="flex items-center gap-2 rounded-[14px] bg-well p-3">
            <code
              className="num min-w-0 flex-1 break-all text-[0.875rem]"
              data-testid="new-api-key"
            >
              {created.key}
            </code>
            <CopyButton value={created.key} label={k.head.key} />
          </div>
        </Dialog>
      )}
      {revoking && (
        <ConfirmDialog
          title={k.revokeTitle}
          body={fmt(k.revokeBody, { name: revoking.name })}
          confirmLabel={k.revoke}
          danger
          busy={busy}
          onConfirm={() => void revoke(revoking)}
          onClose={() => setRevoking(null)}
        />
      )}
    </>
  );
}

function CreateKey({
  defaultTier,
  onClose,
  onCreated,
}: {
  defaultTier: Tier;
  onClose: () => void;
  onCreated: (k: CreatedApiKey) => void;
}) {
  const { t } = useI18n();
  const k = t.dash.keys;
  const { org } = useDash();
  const [name, setName] = useState('');
  const [tier, setTier] = useState<Tier>(defaultTier);
  const [scopes, setScopes] = useState<ApiScope[]>(['p2p:read', 'p2p:write']);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameError = touched && !name.trim() ? k.nameError : null;
  const scopesError = touched && !scopes.length ? k.scopesError : null;
  const submit = async () => {
    setTouched(true);
    if (!name.trim() || !scopes.length) return;
    setBusy(true);
    setError('');
    try {
      onCreated(await apiKeys.create(org.id, { name: name.trim(), tier, scopes }));
    } catch (e) {
      setError(errorMessage(t.common, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={k.createTitle}
      onClose={onClose}
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
            {busy ? k.creating : k.create}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field
          label={k.name}
          value={name}
          placeholder={k.namePlaceholder}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched(true)}
          error={nameError}
        />
        <div className="flex flex-col gap-1.5">
          <span id="key-tier" className="text-[0.875rem] font-semibold text-ink-2">
            {k.tier}
          </span>
          <div className="seg" role="group" aria-labelledby="key-tier">
            {(['test', 'live'] as const).map((x) => (
              <button key={x} type="button" aria-pressed={tier === x} onClick={() => setTier(x)}>
                {t.dash.tier[x]}
              </button>
            ))}
          </div>
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-[0.875rem] font-semibold text-ink-2">{k.scopes}</legend>
          {API_SCOPES.map((s) => (
            <Check
              key={s}
              checked={scopes.includes(s)}
              onChange={(on) => setScopes((x) => (on ? [...x, s] : x.filter((y) => y !== s)))}
              title={k.scopeNames[s].title}
              desc={k.scopeNames[s].desc}
            />
          ))}
          {scopesError && <p className="text-[0.8125rem] text-bad">{scopesError}</p>}
        </fieldset>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}
