/* Market pieces the buy/sell app, the charge page and the dashboard share: a token's and a
   currency's mark, an account's rows labelled from the shared vocabulary, a field problem in
   words, the form for an account someone is paid into, and a picker sheet. */
import { useMemo, useState, type ReactNode } from 'react';
import { fmt, useT, type Messages } from '@/i18n';
import { Field, SelectField } from '@/components/ui/controls';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { RAILS, isRailId, type FieldError, type RailField } from '@/lib/p2p/rails';

type P2pWords = Messages['p2p'];

/* The colour each currency's mark is drawn in: a quiet tint per country, never a flag emoji. */
const CURRENCY_TINT: Record<string, string> = {
  ARS: '#6fa8dc',
  BRL: '#3d9a5f',
  MXN: '#2f7d5b',
  COP: '#e2b23b',
  PEN: '#c8453b',
  CLP: '#3b5ba5',
};

export function CurrencyMark({ code, size = 30 }: { code: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-full font-bold text-white"
      style={{
        width: size,
        height: size,
        background: CURRENCY_TINT[code] ?? 'var(--ink-3)',
        fontSize: size * 0.3,
        fontStretch: '115%',
      }}
    >
      {code.slice(0, 2)}
    </span>
  );
}

const TOKEN_TINT: Record<string, string> = { USDC: '#2775ca', USDT: '#26a17b' };

export function TokenMark({
  symbol,
  network,
  size = 30,
}: {
  symbol: string;
  network?: string;
  size?: number;
}) {
  return (
    <span aria-hidden="true" className="relative shrink-0" style={{ width: size, height: size }}>
      <span
        className="grid size-full place-items-center rounded-full font-bold text-white"
        style={{ background: TOKEN_TINT[symbol] ?? 'var(--ink-3)', fontSize: size * 0.4 }}
      >
        $
      </span>
      {network && (
        <span
          className="absolute -right-1 -bottom-1 grid place-items-center rounded-full border-2 border-sheet bg-ink font-bold text-on-ink uppercase"
          style={{ width: size * 0.5, height: size * 0.5, fontSize: size * 0.22 }}
        >
          {network.slice(0, 1)}
        </span>
      )}
    </span>
  );
}

/* A field's label and its choices' words: the vocabulary names them by kind, and by key for the
   ones it names that way; the key itself stands in for an unknown one. */
const labelOf = (p: P2pWords, kind: string, key: string): string =>
  (p.fields as Record<string, string>)[kind] ?? (p.fields as Record<string, string>)[key] ?? key;
const choicesOf = (p: P2pWords, kind: string, key: string): Record<string, string> =>
  (p.options as Record<string, Record<string, string>>)[kind] ??
  (p.options as Record<string, Record<string, string>>)[key] ??
  {};

export function railName(p: P2pWords, rail: string): string {
  return (p.rails as Record<string, string>)[rail] ?? rail;
}

/** The kind of an account field, for its label. */
export function fieldKind(rail: string, key: string): string {
  if (key === 'holderName' || key === 'document') return key;
  if (!isRailId(rail)) return 'text';
  return RAILS[rail].fields.find((f) => f.key === key)?.kind ?? 'text';
}

/** The rows a bank account shows: holder, document, each detail labelled, choices in words. */
export function accountRows(
  p: P2pWords,
  account: {
    rail: string;
    holderName: string;
    document?: string | null;
    details: Record<string, string>;
  },
): [string, string][] {
  const rows: [string, string][] = [[p.fields.holderName, account.holderName]];
  if (account.document) rows.push([p.fields.document, account.document]);
  for (const [key, value] of Object.entries(account.details)) {
    const kind = fieldKind(account.rail, key);
    const label = kind === 'text' ? key : labelOf(p, kind, key);
    rows.push([label, choicesOf(p, kind, key)[value] ?? value]);
  }
  return rows;
}

/** A field's problem in words: required, its format with the hint, a check digit. */
export function errorText(
  p: P2pWords,
  kind: string,
  error: FieldError | string | null | undefined,
): string | undefined {
  if (!error) return undefined;
  if (error === 'required') return p.errors.required;
  if (error === 'checksum') return p.errors.checksum;
  if (error === 'exclusive') return p.errors.exclusive;
  if (error === 'duplicate') return p.errors.duplicate;
  if (error === 'rail') return p.errors.rail;
  if (error === 'currency') return p.errors.currency;
  if (error === 'amount') return p.errors.amount;
  const hint = (p.hints as Record<string, string>)[kind];
  return hint ? fmt(p.errors.format, { hint }) : p.errors.formatPlain;
}

export interface AccountDraft {
  holderName: string;
  document: string;
  details: Record<string, string>;
}

export const emptyAccount = (rail: string): AccountDraft => {
  const details: Record<string, string> = {};
  if (isRailId(rail))
    for (const f of RAILS[rail].fields) if (f.options) details[f.key] = f.options[0];
  return { holderName: '', document: '', details };
};

/** Whether the holder's document needs its own field (a rail that keeps it among its details, or
    a PIX key that is a CPF or CNPJ, already has it). */
export function needsDocument(rail: string, details: Record<string, string>): boolean {
  if (!isRailId(rail)) return true;
  if (RAILS[rail].documentKey) return false;
  return !(rail === 'br_pix' && (details.keyType === 'cpf' || details.keyType === 'cnpj'));
}

/** The account someone is paid into, per rail, each field checked as typed; a problem shows once
    the field was left (or every problem, after the form's button was pressed). */
export function AccountFields({
  rail,
  value,
  onChange,
  errors,
  showAll = false,
  withDocument = true,
}: {
  rail: string;
  value: AccountDraft;
  onChange: (next: AccountDraft) => void;
  errors: Record<string, FieldError>;
  showAll?: boolean;
  withDocument?: boolean;
}) {
  const t = useT();
  const p = t.p2p;
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const leave = (key: string) => () => setTouched((x) => ({ ...x, [key]: true }));
  const show = (key: string) => (touched[key] || showAll ? errors[key] : undefined);
  const known = isRailId(rail) ? RAILS[rail] : null;
  const fields: RailField[] = known
    ? [...known.fields]
    : Object.keys(value.details).map((key) => ({ key, kind: 'text' as const }));
  const set = (key: string, v: string) =>
    onChange({ ...value, details: { ...value.details, [key]: v } });
  const placeholders = p.placeholders as Record<string, string>;
  const hints = p.hints as Record<string, string>;
  return (
    <div className="flex flex-col gap-4">
      <Field
        label={p.fields.holderName}
        value={value.holderName}
        autoComplete="name"
        placeholder={p.placeholders.holderName}
        onChange={(e) => onChange({ ...value, holderName: e.target.value })}
        onBlur={leave('holderName')}
        error={errorText(p, 'holderName', show('holderName'))}
      />
      {fields.map((f, i) =>
        f.options ? (
          <SelectField
            key={f.key}
            label={labelOf(p, f.kind, f.key)}
            value={value.details[f.key] ?? f.options[0]}
            onChange={(e) => set(f.key, e.target.value)}
            options={f.options.map((o) => ({
              value: o,
              label: choicesOf(p, f.kind, f.key)[o] ?? o,
            }))}
          />
        ) : (
          <Field
            key={f.key}
            label={f.kind === 'text' ? f.key : labelOf(p, f.kind, f.key)}
            value={value.details[f.key] ?? ''}
            autoComplete="off"
            spellCheck={false}
            inputMode={
              ['cbu', 'clabe', 'cci', 'accountNumber', 'cuit'].includes(f.kind)
                ? 'numeric'
                : undefined
            }
            placeholder={placeholders[f.kind] ?? ''}
            onChange={(e) => set(f.key, e.target.value)}
            onBlur={leave(f.key)}
            error={errorText(p, f.kind, show(f.key))}
            hint={
              f.oneOf && i === fields.findIndex((x) => x.oneOf === f.oneOf)
                ? hints.oneOf
                : hints[f.kind]
            }
          />
        ),
      )}
      {withDocument && needsDocument(rail, value.details) && (
        <Field
          label={p.fields.document}
          value={value.document}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange({ ...value, document: e.target.value })}
          onBlur={leave('document')}
          error={errorText(p, 'document', show('document'))}
        />
      )}
    </div>
  );
}

/** A picker in a sheet: search when the list is long, arrow keys between rows. */
export function PickerSheet({
  title,
  items,
  selected,
  onPick,
  onClose,
  searchLabel,
}: {
  title: string;
  items: { key: string; mark: ReactNode; title: string; sub: string; search: string }[];
  selected: string;
  onPick: (key: string) => void;
  onClose: () => void;
  searchLabel?: string;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? items.filter((x) => x.search.toLowerCase().includes(q)) : items),
    [items, q],
  );
  const searchable = !!searchLabel && items.length > 6;
  return (
    <Dialog title={title} onClose={onClose}>
      {searchable && (
        <div className="relative mb-3">
          <Icon
            name="search"
            size={18}
            className="absolute top-1/2 left-3 -translate-y-1/2 text-ink-3"
          />
          <input
            type="search"
            className="field pl-10"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchLabel}
            aria-label={searchLabel}
          />
        </div>
      )}
      <ul
        className="flex flex-col gap-1"
        role="list"
        onKeyDown={(e) => {
          const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
          const at = rows.indexOf(document.activeElement as HTMLButtonElement);
          const go = (i: number) => {
            e.preventDefault();
            rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
          };
          if (e.key === 'ArrowDown') go(at + 1);
          else if (e.key === 'ArrowUp') go(at - 1);
        }}
      >
        {shown.map((x) => (
          <li key={x.key}>
            <button
              type="button"
              aria-pressed={x.key === selected}
              onClick={() => onPick(x.key)}
              className={`flex w-full items-center gap-3 rounded-[14px] px-3 py-3 text-left transition-colors hover:bg-well ${x.key === selected ? 'bg-well' : ''}`}
            >
              {x.mark}
              <span className="flex flex-1 flex-col">
                <b className="font-semibold">{x.title}</b>
                <span className="text-[0.875rem] text-ink-3">{x.sub}</span>
              </span>
              {x.key === selected && <Icon name="check" size={18} />}
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
