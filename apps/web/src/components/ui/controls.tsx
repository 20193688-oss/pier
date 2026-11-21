/* Form controls with their label, hint and error wired for assistive tech (the error replaces the
   hint and marks the control invalid). */
import {
  useEffect,
  useId,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { useToast } from '@/components/ui/Toast';

interface FieldFrame {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
}

function Frame({
  id,
  label,
  hint,
  error,
  className = '',
  children,
}: FieldFrame & { id: string; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-[0.875rem] font-semibold text-ink-2">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-msg`} className="text-[0.8125rem] text-bad">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-msg`} className="text-[0.8125rem] text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  className,
  id: idProp,
  ...input
}: FieldFrame & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <Frame id={id} label={label} hint={hint} error={error} className={className}>
      <input
        id={id}
        className="field"
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-msg` : undefined}
        {...input}
      />
    </Frame>
  );
}

export function TextArea({
  label,
  hint,
  error,
  className,
  id: idProp,
  ...input
}: FieldFrame & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <Frame id={id} label={label} hint={hint} error={error} className={className}>
      <textarea
        id={id}
        className="field min-h-24"
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-msg` : undefined}
        {...input}
      />
    </Frame>
  );
}

export function SelectField({
  label,
  hint,
  error,
  className,
  options,
  id: idProp,
  ...select
}: FieldFrame &
  SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[] }) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <Frame id={id} label={label} hint={hint} error={error} className={className}>
      <select
        id={id}
        className="field"
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-msg` : undefined}
        {...select}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Frame>
  );
}

/** A checkbox with a title and an optional description under it. */
export function Check({
  checked,
  onChange,
  title,
  desc,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: ReactNode;
  desc?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-5 shrink-0 accent-[var(--ink)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={desc ? `${id}-d` : undefined}
      />
      <label htmlFor={id} className="flex flex-col gap-0.5">
        <span className="font-semibold">{title}</span>
        {desc && (
          <span id={`${id}-d`} className="text-[0.875rem] text-ink-3">
            {desc}
          </span>
        )}
      </label>
    </div>
  );
}

/** An on/off switch (a checkbox with the switch role). */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${checked ? 'bg-ink' : 'bg-line-2'}`}
    >
      <span
        className={`absolute top-1 size-5 rounded-full bg-sheet transition-[left] ${checked ? 'left-6' : 'left-1'}`}
      />
    </button>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`spinner ${className}`} aria-hidden="true" />;
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`skeleton block ${className}`} aria-hidden="true" />;
}

/** A line saying what happened: an error (alert), a note (status). */
export function Notice({
  tone = 'info',
  children,
  className = '',
  stay = false,
}: {
  tone?: 'info' | 'error' | 'ok' | 'warn';
  children: ReactNode;
  className?: string;
  /* An error that is a state of the screen (could not load, a QR not taken, a file missing
     columns) stays on it as a line; any other error is only a toast. */
  stay?: boolean;
}) {
  const tones = {
    info: 'bg-info-soft text-info',
    error: 'bg-bad-soft text-bad',
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-warn-soft text-warn',
  } as const;
  // An error comes up as a toast each time its words change (src/components/ui/Toast.tsx): the
  // toast is what the person reads, and announces it, unless the line stays on screen too.
  const inline = tone !== 'error' || stay;
  const toast = useToast();
  const line = useRef<HTMLParagraphElement>(null);
  const words = useRef<HTMLSpanElement>(null);
  const said = useRef('');
  useEffect(() => {
    if (tone !== 'error') return;
    const text = (line.current ?? words.current)?.textContent?.trim() ?? '';
    if (text && text !== said.current) toast(text, 'error', { silent: inline });
    said.current = text;
  });
  if (!inline)
    return (
      <span ref={words} hidden>
        {children}
      </span>
    );
  return (
    <p
      ref={line}
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-[12px] px-3.5 py-2.5 text-[0.9375rem] ${tones[tone]} ${className}`}
    >
      {children}
    </p>
  );
}
