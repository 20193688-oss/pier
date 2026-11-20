// Renders the app's icons (public/icons/*.png) from the SVG mark with Playwright's Chromium:
// 192 and 512 (purpose "any"), a 512 maskable one (the glyph inside the safe zone on a full aura
// field) and the 180 apple-touch-icon (no transparency). Run after changing the mark:
// `npm run icons -w @midpoint/web`. The PNGs are committed.
import { mkdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { chromium } from '@playwright/test';

const NIGHT = '#0a0b0e';
/* The aura's stops on the tile, top to bottom (src/components/ui/Logo.tsx, MARK_STOPS). */
const STOPS = [
  [0, '#b4ecfa'],
  [0.34, '#5d93dc'],
  [0.68, '#1f2b8e'],
  [1, '#06071a'],
];
const out = fileURLToPath(new URL('../public/icons/', import.meta.url));

/** The mark (src/components/ui/Logo.tsx) on a 32-unit grid; `pad` shrinks the glyph into the
    middle of a full tile. */
const mark = ({ rounded, pad }) => {
  const k = (32 - pad * 2) / 32;
  const stops = STOPS.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs><linearGradient id="a" x1="0" y1="0" x2=".35" y2="1">${stops}</linearGradient></defs>
  <rect width="32" height="32" ${rounded ? 'rx="9"' : ''} fill="url(#a)"/>
  <g transform="translate(${pad} ${pad}) scale(${k})">
    <path d="M9.5 22.5 22.5 9.5" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="9.5" cy="22.5" r="3.1" fill="#fff"/>
    <circle cx="22.5" cy="9.5" r="3.1" fill="#fff"/>
    <circle cx="16" cy="16" r="3.9" fill="${NIGHT}" stroke="#fff" stroke-width="1.9"/>
  </g>
</svg>`;
};

const ICONS = [
  { file: 'icon-192.png', size: 192, svg: mark({ rounded: true, pad: 0 }), transparent: true },
  { file: 'icon-512.png', size: 512, svg: mark({ rounded: true, pad: 0 }), transparent: true },
  // Maskable: the platform crops to its own shape; the glyph stays within the central 80 %.
  {
    file: 'maskable-512.png',
    size: 512,
    svg: mark({ rounded: false, pad: 5 }),
    transparent: false,
  },
  {
    file: 'apple-touch-icon.png',
    size: 180,
    svg: mark({ rounded: false, pad: 3 }),
    transparent: false,
  },
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const icon of ICONS) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
    await page.setContent(
      `<html><body style="margin:0;background:${icon.transparent ? 'transparent' : NIGHT}">` +
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
