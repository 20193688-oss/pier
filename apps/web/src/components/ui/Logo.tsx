/* The product's mark: two points joined by one segment (the two people of a trade) and, at its
   midpoint, the ringed node where they meet: the order the contract holds until both sides are
   done. The tile carries the aura (ice to night); the glyph alone (LogoGlyph) is the line drawing
   the welcome sets large. The geometry is shared with public/favicon.svg and
   scripts/gen-icons.mjs. The wordmark is the product's name (src/lib/brand.ts), set in lowercase. */
import { useId } from 'react';
import { BRAND } from '@/lib/brand';

/** The aura's stops on the mark's tile, top to bottom. */
export const MARK_STOPS: [number, string][] = [
  [0, '#b4ecfa'],
  [0.34, '#5d93dc'],
  [0.68, '#1f2b8e'],
  [1, '#06071a'],
];

export function LogoMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  const id = `mk${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0.35" y2="1">
          {MARK_STOPS.map(([o, c]) => (
            <stop key={o} offset={o} stopColor={c} />
          ))}
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id})`} />
      <path d="M9.5 22.5 22.5 9.5" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="9.5" cy="22.5" r="3.1" fill="#fff" />
      <circle cx="22.5" cy="9.5" r="3.1" fill="#fff" />
      <circle cx="16" cy="16" r="3.9" fill="#0a0b0e" stroke="#fff" strokeWidth="1.9" />
    </svg>
  );
}

/** The glyph without its tile, in the current colour: a line drawing for large, quiet uses. */
export function LogoGlyph({ size = 120, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
    >
      <path d="M5 27 27 5" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="5" cy="27" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="27" cy="5" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="16" cy="16" r="3.4" strokeWidth="1.6" />
    </svg>
  );
}

export function Logo({ size = 28, label }: { size?: number; label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-2"
      aria-label={label}
      role={label ? 'img' : undefined}
    >
      <LogoMark size={size} />
      <span
        aria-hidden={label ? true : undefined}
        className="text-[1.3rem] leading-none font-[700] tracking-[-0.04em] text-ink lowercase"
      >
        {BRAND.name}
      </span>
    </span>
  );
}
