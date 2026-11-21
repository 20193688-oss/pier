/* Team: the wallets that sign in to this organization and their roles. Owners and admins add,
   change and remove members; only an owner may name another owner (the API keeps at least one
   owner and answers why when it refuses). */
import { useState } from 'react';
import { fmt, useI18n } from '@/i18n';
import { orgs as orgsApi } from '@/lib/api/endpoints';
import { errorMessage } from '@/lib/api/messages';
import { ROLES, type Member, type Role } from '@/lib/api/types';
import { dateOnly, shortAddress } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Field, Notice, SelectField, Spinner } from '@/components/ui/controls';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { Address, Empty, Pill } from '@/components/ui/misc';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { useDash } from '@/features/dashboard/context';
import { LoadState, PageHead, useLoad } from '@/features/dashboard/ui';
import { grantableRoles, isMemberAddress } from '@/features/dashboard/views/admin-model';
import { useGuard } from '@/lib/use-action';

export function TeamView() {
  const { t, lang } = useI18n();
  const m = t.admin.team;
  const roles = t.dash.orgs.roles;
  const toast = useToast();
  const { session } = useSession();
  const { org, canWrite } = useDash();
  const load = useLoad(() => orgsApi.members(org.id), [org.id]);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const grantable = grantableRoles(org.role);

  const guard = useGuard();
  const changeRole = (member: Member, role: Role) =>
    guard(async () => {
      setError('');
      try {
        const next = await orgsApi.updateMember(org.id, member.id, { role });
        load.setData((list) =>
          list?.map((x) => (x.id === member.id ? { ...x, role: next.role || role } : x)),
        );
        toast(m.roleChanged);
      } catch (e) {
        setError(errorMessage(t.common, e));
        load.reload();
      }
    });

  const remove = (member: Member) =>
    guard(async () => {
      setBusy(true);
      setError('');
      try {
        await orgsApi.removeMember(org.id, member.id);
        toast(m.removed);
        setRemoving(null);
        load.reload();
      } catch (e) {
        setError(errorMessage(t.common, e));
        setRemoving(null);
      } finally {
        setBusy(false);
      }
    });

  return (
    <>
      <PageHead
        title={m.title}
        lede={m.lede}
        actions={
          canWrite && (
            <button type="button" className="btn btn-ink" onClick={() => setAdding(true)}>
              <Icon name="plus" size={18} />
              {m.add}
            </button>
          )
        }
      />
      {!canWrite && <Notice className="mb-6">{m.ownersOnly}</Notice>}
      {error && (
        <Notice tone="error" className="mb-4">
          {error}
        </Notice>
      )}
      <LoadState load={load} empty={<Empty title={m.title} body={m.lede} />}>
        {(members) => (
          <ul className="flex flex-col gap-3" role="list" aria-label={m.title}>
            {members.map((member) => {
              const me = !!session && member.address === session.address;
              // A member's role can be changed only to one this member may grant (and an owner only by an owner).
              const editable = canWrite && grantable.includes(member.role);
              return (
                <li
                  key={member.id}
                  className="sheet flex flex-wrap items-center gap-x-5 gap-y-3 p-4"
                >
                  <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <Address value={member.address} />
                      {me && <Pill tone="ref">{m.you}</Pill>}
                      {member.label && <span className="text-ink-2">{member.label}</span>}
                    </span>
                    {member.addedAt && (
                      <span className="text-[0.875rem] text-ink-3">
                        {fmt(m.since, { date: dateOnly(lang, member.addedAt) })}
                      </span>
                    )}
                  </div>
                  {editable ? (
                    <label className="flex items-center gap-2">
                      <span className="sr-only">
                        {fmt(m.roleLabel, { address: shortAddress(member.address) })}
                      </span>
                      <select
                        className="field min-h-10 w-auto py-1.5"
                        value={member.role}
                        onChange={(e) => void changeRole(member, e.target.value as Role)}
                      >
                        {ROLES.filter((r) => grantable.includes(r)).map((r) => (
                          <option key={r} value={r}>
                            {roles[r]}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <Pill
                      tone={
                        member.role === 'owner' ? 'ok' : member.role === 'admin' ? 'ref' : 'off'
                      }
                    >
                      {roles[member.role]}
                    </Pill>
                  )}
                  {editable && (
                    <button
                      type="button"
                      className="btn btn-quiet btn-sm"
                      onClick={() => setRemoving(member)}
                    >
                      {m.remove}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </LoadState>

      {adding && (
        <AddMember
          grantable={grantable}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            toast(m.added);
            load.reload();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={m.removeTitle}
          body={fmt(m.removeBody, { address: shortAddress(removing.address) })}
          confirmLabel={m.remove}
          danger
          busy={busy}
          onConfirm={() => void remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  );
}

function AddMember({
  grantable,
  onClose,
  onAdded,
}: {
  grantable: Role[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useI18n();
  const m = t.admin.team;
  const roles = t.dash.orgs.roles;
  const { org } = useDash();
  const [address, setAddress] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const addressError = touched && !isMemberAddress(address) ? m.addressError : null;

  const guard = useGuard();
  const submit = () =>
    guard(async () => {
      setTouched(true);
      if (!isMemberAddress(address) || !grantable.includes(role)) return;
      setBusy(true);
      setError('');
      try {
        await orgsApi.addMember(org.id, { address: address.trim(), role });
        onAdded();
      } catch (e) {
        setError(errorMessage(t.common, e));
      } finally {
        setBusy(false);
      }
    });

  return (
    <Dialog
      title={m.addTitle}
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
            {busy ? m.adding : m.add}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label={m.address}
          value={address}
          placeholder={m.addressPlaceholder}
          hint={m.addressHint}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
          onBlur={() => setTouched(true)}
          error={addressError}
        />
        <SelectField
          label={m.role}
          hint={m.roleHints[role]}
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          options={ROLES.filter((r) => grantable.includes(r)).map((r) => ({
            value: r,
            label: roles[r],
          }))}
        />
        {!grantable.includes('owner') && (
          <p className="text-[0.8125rem] text-ink-3">{m.ownerOnlyOwner}</p>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}
