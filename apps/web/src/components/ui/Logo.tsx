/* The product's logo, from the brand kit (src/components/ui/logo-paths.ts): the symbol is the
   «P» of Pier, a pier-shaped P split in two halves; the wordmark sets it before «ier». The upper
   half and the dot of the i carry the Aurora gradient (its glass version on the dark and on the
   aura, set by --logo-1..3 in global.css); the lower half and «ier» take the current colour (the
   page's ink by default). Brand rules: the wordmark is at least 80px wide on screen and the
   symbol 24px tall; no shadow, glass or rotation on either. The app icons are drawn by
   scripts/gen-icons.mjs from the same geometry. */
import { useId } from 'react';
import { LOGO } from '@/components/ui/logo-paths';
import { BRAND } from '@/lib/brand';

const widthFor = (box: readonly number[], height: number) => Math.round((height * box[2]) / box[3]);

/** The Aurora gradient across the P (and, as its own box, across the dot). */
function Aurora({ id, box }: { id: string; box?: boolean }) {
  const stops = (
    <>
      <stop offset="0" stopColor="var(--logo-1)" />
      <stop offset="0.5" stopColor="var(--logo-2)" />
      <stop offset="1" stopColor="var(--logo-3)" />
    </>
  );
  return box ? (
    <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
      {stops}
    </linearGradient>
  ) : (
    <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="219" y1="219" x2="459" y2="511">
      {stops}
    </linearGradient>
  );
}

function PierSymbol({ grad }: { grad: string }) {
  const { mark } = LOGO;
  return (
    <g fill="none" strokeWidth={mark.stroke} strokeLinecap="butt" strokeLinejoin="miter">
      <path d={mark.pA} stroke={`url(#${grad})`} />
      <path d={mark.pB} stroke="currentColor" />
    </g>
  );
}

/** The symbol (the P) alone; `size` is its height in px (24 at least). */
export function LogoGlyph({ size = 120, className = '' }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg
      width={widthFor(LOGO.mark.box, size)}
      height={size}
      viewBox={LOGO.mark.box.join(' ')}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <Aurora id={`${id}-p`} />
      </defs>
      <PierSymbol grad={`${id}-p`} />
    </svg>
  );
}

/** The wordmark; `size` is its height in px (32 by default, so it is 80px wide or more).
    Assistive tech reads `label`, else the product's name. */
export function Logo({
  size = 32,
  label,
  className = 'block text-ink',
}: {
  size?: number;
  label?: string;
  className?: string;
}) {
  const id = useId().replace(/:/g, '');
  const { wordmark } = LOGO;
  return (
    <svg
      width={widthFor(wordmark.box, size)}
      height={size}
      viewBox={wordmark.box.join(' ')}
      className={className}
      role="img"
      aria-label={label ?? BRAND.name}
      focusable="false"
    >
      <defs>
        <Aurora id={`${id}-p`} />
        <Aurora id={`${id}-d`} box />
      </defs>
      <PierSymbol grad={`${id}-p`} />
      <path d={wordmark.ier} fill="currentColor" />
      <circle cx={wordmark.dot.cx} cy={wordmark.dot.cy} r={wordmark.dot.r} fill={`url(#${id}-d)`} />
    </svg>
  );
}
