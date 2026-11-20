/* The product's mark: one bowl shared by a "p" (its stem down-left) and a "d" (its stem up-right),
   two people meeting at one point, with the locked order as the marker-yellow dot in the middle.
   "pe dos pe" is P2P said in Spanish. The wordmark is the product's name (src/lib/brand.ts), set in
   lowercase, wide. */
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
      <g fill="none" stroke="var(--paper)" strokeWidth="3.2" strokeLinecap="round">
        <circle cx="16" cy="16" r="6.2" />
        <path d="M9.8 16v10.5M22.2 16V5.5" />
      </g>
      <circle cx="16" cy="16" r="2.3" fill="var(--marker)" />
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
        className="text-[1.3rem] leading-none font-[780] tracking-[-0.03em] text-ink"
        style={{ fontStretch: '125%' }}
      >
        {BRAND.name}
      </span>
    </span>
  );
}
