/* Small pieces: copy-to-clipboard, the order status pill, a QR code, a live clock, an address. */
import { useEffect, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { fmt, useT } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { orderPill } from '@/lib/p2p/orders';
import { shortAddress } from '@/lib/format';

/** Re-render every second while `active` (countdowns). */
export function useNow(active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label,
  className = '',
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const t = useT();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(id);
  }, [done]);
  return (
    <button
      type="button"
      className={`btn btn-line btn-sm shrink-0 ${className}`}
      onClick={async () => setDone(await writeClipboard(value))}
      aria-label={fmt(t.common.actions.copyValue, { label })}
    >
      <Icon name={done ? 'check' : 'copy'} size={16} />
      <span aria-live="polite">{done ? t.common.actions.copied : t.common.actions.copy}</span>
    </button>
  );
}

/** One labelled value a person copies into their bank app. */
export function CopyRow({
  label,
  value,
  big = false,
}: {
  label: string;
  value: string;
  big?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="text-[0.8125rem] text-ink-3">{label}</div>
        <div className={`num break-all ${big ? 'text-[1.125rem] font-semibold' : 'font-medium'}`}>
          {value}
        </div>
      </div>
      <CopyButton value={value} label={label} />
    </div>
  );
}

export function StatusPill({ status, children }: { status: string; children: ReactNode }) {
  return <span className={`pill pill-${orderPill(status)}`}>{children}</span>;
}

export function Pill({
  tone,
  children,
}: {
  tone: 'ok' | 'pend' | 'fail' | 'ref' | 'off';
  children: ReactNode;
}) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

/** A QR code for `value`, drawn as SVG in the page's ink on its paper. */
export function Qr({ value, label, size = 192 }: { value: string; label: string; size?: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toString(value, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0a0b0e', light: '#ffffff' },
    })
      .then((s) => alive && setSvg(s))
      .catch(() => alive && setSvg(null));
    return () => {
      alive = false;
    };
  }, [value]);
  if (!svg)
    return (
      <span className="skeleton block" style={{ width: size, height: size }} aria-hidden="true" />
    );
  return (
    <img
      src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
      width={size}
      height={size}
      alt={label}
      className="rounded-[12px] bg-white p-2"
    />
  );
}

export function Address({ value, className = '' }: { value: string; className?: string }) {
  return (
    <code
      className={`num rounded-md bg-well px-1.5 py-0.5 text-[0.85em] ${className}`}
      title={value}
    >
      {shortAddress(value)}
    </code>
  );
}

/** A section's empty state: what it is for and the first thing to do. */
export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[18px] border border-dashed border-line-2 px-5 py-8">
      <h3 className="text-[1.0625rem]">{title}</h3>
      <p className="max-w-prose text-ink-3">{body}</p>
      {action}
    </div>
  );
}

/** The banknote figure's size for a text of this length, so a long amount never overflows a
    phone: the longer the text, the smaller the cut. */
export function figureSize(text: string): string {
  const n = text.length;
  if (n <= 11) return 'text-[clamp(1.9rem,8.4vw,2.6rem)]';
  if (n <= 14) return 'text-[clamp(1.6rem,7vw,2.3rem)]';
  if (n <= 17) return 'text-[clamp(1.35rem,5.8vw,2rem)]';
  return 'text-[clamp(1.15rem,4.8vw,1.75rem)]';
}
