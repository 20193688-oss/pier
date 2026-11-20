// Renders the app's icons (public/icons/*.png) from the SVG mark with Playwright's Chromium:
// 192 and 512 (purpose "any"), a 512 maskable one (the mark inside the safe zone on a full ink
// field) and the 180 apple-touch-icon (no transparency). Run after changing the mark:
// `npm run icons -w @pedospe/web`. The PNGs are committed.
import { mkdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { chromium } from '@playwright/test';

const INK = '#10261f';
const PAPER = '#f1f3ee';
const MARKER = '#ffd23f';
const out = fileURLToPath(new URL('../public/icons/', import.meta.url));

/** The mark (src/components/ui/Logo.tsx) on a 32-unit grid; `pad` shrinks it into the middle. */
const mark = ({ rounded, pad }) => {
  const s = 32 - pad * 2;
  const k = s / 32;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" ${rounded ? 'rx="9"' : ''} fill="${INK}"/>
  <g transform="translate(${pad} ${pad}) scale(${k})">
    <g fill="none" stroke="${PAPER}" stroke-width="3.2" stroke-linecap="round">
      <circle cx="16" cy="16" r="6.2"/><path d="M9.8 16v10.5M22.2 16V5.5"/>
    </g>
    <circle cx="16" cy="16" r="2.3" fill="${MARKER}"/>
  </g>
</svg>`;
};

const ICONS = [
  { file: 'icon-192.png', size: 192, svg: mark({ rounded: true, pad: 0 }), transparent: true },
  { file: 'icon-512.png', size: 512, svg: mark({ rounded: true, pad: 0 }), transparent: true },
  // Maskable: the platform crops to its own shape; the mark stays within the central 80 %.
  { file: 'maskable-512.png', size: 512, svg: mark({ rounded: false, pad: 5 }), transparent: false },
  { file: 'apple-touch-icon.png', size: 180, svg: mark({ rounded: false, pad: 3 }), transparent: false },
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
