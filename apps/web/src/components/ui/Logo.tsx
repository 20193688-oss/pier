/* The product's mark: the hero's capital M (Archivo at the hero's cut: width 116, weight 720),
   cut on a slant with its lower part slid to the right, one side passing to the other. Flat: the
   M in the page's paper on an ink tile (black on a light page, light on a dark one), no gradient.
   The glyph alone (LogoGlyph) takes the current colour. The outline comes from the app's own
   Archivo file; public/favicon.svg and scripts/gen-icons.mjs draw the same mark. The wordmark is
   the product's name (src/lib/brand.ts) in the hero's capitals. */
import { useId } from 'react';
import { BRAND } from '@/lib/brand';

/** The M's outline in font units (1000 per em, baseline at 0, y pointing down). */
export const M_PATH =
  'M85.1 0V-687H347.9L469.7 -356.1Q476.3 -338.5 485.3 -310.9Q494.3 -283.3 503.7 -254.4Q513.1 -225.5 520.1 -202.5H527.5Q533.5 -222.6 542.2 -249.8Q550.8 -277.1 560.1 -305.4Q569.4 -333.7 576.9 -355.4L698.7 -687H955.4V0H785.9V-361.9Q785.9 -390.2 786.5 -421.5Q787.2 -452.8 788.2 -479.8Q789.3 -506.9 789.8 -521.6H781.8Q777.4 -506.2 769.4 -480.6Q761.4 -454.9 753 -428.2Q744.7 -401.5 737.6 -381.9L594 0H438.7L294.5 -381.6Q286.3 -404 277.9 -429.9Q269.5 -455.8 262.6 -480.3Q255.7 -504.8 250.6 -521.5H242.6Q243.6 -503.6 244.3 -476.3Q244.9 -449 245.6 -419.2Q246.2 -389.4 246.2 -361.9V0Z';
/** The cut, 28 units wide: what lies above stays, what lies below moves right by M_SLIDE. */
export const M_CUT_TOP = 'M-200 -900L1300 -900L1300 -434L-200 -244Z';
export const M_CUT_BOTTOM = 'M-200 -216L1300 -406L1300 200L-200 200Z';
export const M_SLIDE = 52;
/** The slid M's box in font units: x, y, width, height. */
export const M_BOX = [85.1, -687, 922.3, 687] as const;
/** Where the slid M sits on the 512-unit tile: x, y, width, height. */
export const M_ON_TILE = [97.58, 138, 316.83, 236] as const;

/** The slid M, drawn in font units in the current fill. */
function SlidM({ id }: { id: string }) {
  return (
    <>
      <defs>
        <clipPath id={`${id}t`} clipPathUnits="userSpaceOnUse">
          <path d={M_CUT_TOP} />
        </clipPath>
        <clipPath id={`${id}b`} clipPathUnits="userSpaceOnUse">
          <path d={M_CUT_BOTTOM} />
        </clipPath>
      </defs>
      <path d={M_PATH} clipPath={`url(#${id}t)`} />
      <path d={M_PATH} clipPath={`url(#${id}b)`} transform={`translate(${M_SLIDE} 0)`} />
    </>
  );
}

const useSvgId = () => `m${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

export function LogoMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  const id = useSvgId();
  const [x, y, w, h] = M_ON_TILE;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="512" height="512" rx="112" style={{ fill: 'var(--ink)' }} />
      <svg
        x={x}
        y={y}
        width={w}
        height={h}
        viewBox={M_BOX.join(' ')}
        style={{ fill: 'var(--on-ink)' }}
      >
        <SlidM id={id} />
      </svg>
    </svg>
  );
}

/** The slid M without its tile, in the current colour; `size` is its height. */
export function LogoGlyph({ size = 120, className = '' }: { size?: number; className?: string }) {
  const id = useSvgId();
  return (
    <svg
      width={Math.round((size * M_BOX[2]) / M_BOX[3])}
      height={size}
      viewBox={M_BOX.join(' ')}
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      <SlidM id={id} />
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
      <span aria-hidden={label ? true : undefined} className="display text-[1.15rem] text-ink">
        {BRAND.name}
      </span>
    </span>
  );
}
