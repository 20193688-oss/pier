/* The product's mark: two points joined by one segment (the two people of a trade) and, at its
   midpoint, the marker-yellow dot where they meet: the order the contract holds until both sides
   are done. The geometry is shared with public/favicon.svg and scripts/gen-icons.mjs. The wordmark
   is the product's name (src/lib/brand.ts), set in lowercase, wide. */
import { BRAND } from '@/lib/brand';

export function LogoMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="9" fill="var(--ink)" />
      <path d="M9.5 22.5 22.5 9.5" stroke="var(--paper)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="9.5" cy="22.5" r="3.3" fill="var(--paper)" />
      <circle cx="22.5" cy="9.5" r="3.3" fill="var(--paper)" />
      <circle cx="16" cy="16" r="4" fill="var(--marker)" stroke="var(--ink)" strokeWidth="1.8" />
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
        className="text-[1.3rem] leading-none font-[780] tracking-[-0.03em] text-ink lowercase"
        style={{ fontStretch: '125%' }}
      >
        {BRAND.name}
      </span>
    </span>
  );
}
