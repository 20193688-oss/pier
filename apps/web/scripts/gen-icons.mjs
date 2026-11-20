// Renders the app's icons (public/icons/*.png) from the SVG mark with Playwright's Chromium:
// 192 and 512 (purpose "any"), a 512 maskable one (the M inside the safe zone on a full ink field)
// and the 180 apple-touch-icon (no transparency). Run after changing the mark:
// `npm run icons -w @midpoint/web`. The PNGs are committed.
import { mkdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { chromium } from '@playwright/test';

const INK = '#0a0b0e';
const out = fileURLToPath(new URL('../public/icons/', import.meta.url));

/* The slid M (src/components/ui/Logo.tsx: M_PATH, the cut, M_SLIDE, M_BOX, M_ON_TILE). */
const M_PATH =
  'M85.1 0V-687H347.9L469.7 -356.1Q476.3 -338.5 485.3 -310.9Q494.3 -283.3 503.7 -254.4Q513.1 -225.5 520.1 -202.5H527.5Q533.5 -222.6 542.2 -249.8Q550.8 -277.1 560.1 -305.4Q569.4 -333.7 576.9 -355.4L698.7 -687H955.4V0H785.9V-361.9Q785.9 -390.2 786.5 -421.5Q787.2 -452.8 788.2 -479.8Q789.3 -506.9 789.8 -521.6H781.8Q777.4 -506.2 769.4 -480.6Q761.4 -454.9 753 -428.2Q744.7 -401.5 737.6 -381.9L594 0H438.7L294.5 -381.6Q286.3 -404 277.9 -429.9Q269.5 -455.8 262.6 -480.3Q255.7 -504.8 250.6 -521.5H242.6Q243.6 -503.6 244.3 -476.3Q244.9 -449 245.6 -419.2Q246.2 -389.4 246.2 -361.9V0Z';
const CUT_TOP = 'M-200 -900L1300 -900L1300 -434L-200 -244Z';
const CUT_BOTTOM = 'M-200 -216L1300 -406L1300 200L-200 200Z';
const SLIDE = 52;
const BOX = '85.1 -687 922.3 687';
const [MX, MY, MW, MH] = [97.58, 138, 316.83, 236];

/** The mark on the 512-unit tile; `pad` shrinks the M into the middle of a full tile. */
const mark = ({ rounded, pad }) => {
  const k = (512 - pad * 2) / 512;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <clipPath id="t" clipPathUnits="userSpaceOnUse"><path d="${CUT_TOP}"/></clipPath>
    <clipPath id="b" clipPathUnits="userSpaceOnUse"><path d="${CUT_BOTTOM}"/></clipPath>
  </defs>
  <rect width="512" height="512" ${rounded ? 'rx="112"' : ''} fill="${INK}"/>
  <g transform="translate(${pad} ${pad}) scale(${k})">
    <svg x="${MX}" y="${MY}" width="${MW}" height="${MH}" viewBox="${BOX}" fill="#fff">
      <path d="${M_PATH}" clip-path="url(#t)"/>
      <path d="${M_PATH}" clip-path="url(#b)" transform="translate(${SLIDE} 0)"/>
    </svg>
  </g>
</svg>`;
};

const ICONS = [
  { file: 'icon-192.png', size: 192, svg: mark({ rounded: true, pad: 0 }), transparent: true },
  { file: 'icon-512.png', size: 512, svg: mark({ rounded: true, pad: 0 }), transparent: true },
  // Maskable: the platform crops to its own shape; the M stays within the central 80 %.
  {
    file: 'maskable-512.png',
    size: 512,
    svg: mark({ rounded: false, pad: 60 }),
    transparent: false,
  },
  {
    file: 'apple-touch-icon.png',
    size: 180,
    svg: mark({ rounded: false, pad: 30 }),
    transparent: false,
  },
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const icon of ICONS) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
    await page.setContent(
      `<html><body style="margin:0;background:${icon.transparent ? 'transparent' : INK}">` +
        `<div style="width:${icon.size}px;height:${icon.size}px">${icon.svg.replace('<svg ', `<svg width="${icon.size}" height="${icon.size}" `)}</div></body></html>`,
    );
    await page.screenshot({
      path: `${out}${icon.file}`,
      omitBackground: icon.transparent,
      clip: { x: 0, y: 0, width: icon.size, height: icon.size },
    });
    await page.close();
    console.log(`wrote public/icons/${icon.file}`);
  }
} finally {
  await browser.close();
}
