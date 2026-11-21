// Renders the app's icons from the logo's cut P (src/components/ui/logo-paths.ts, made by
// scripts/gen-logo.py) on an ink tile: public/favicon.svg, and with Playwright's Chromium the PNGs
// in public/icons: 192 and 512 (purpose "any"), a 512 maskable one (the P inside the safe zone on
// a full ink field) and the 180 apple-touch-icon (no transparency). Run after changing the logo:
// `npm run icons -w @pier/web`. The files are committed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { chromium } from '@playwright/test';

const INK = '#0a0b0e';
const out = fileURLToPath(new URL('../public/icons/', import.meta.url));
const favicon = fileURLToPath(new URL('../public/favicon.svg', import.meta.url));
// Node runs the TypeScript module as is (its types are stripped).
const { LOGO } = await import(new URL('../src/components/ui/logo-paths.ts', import.meta.url).href);
const { mark } = LOGO;

/** The P on a 512-unit tile, 236 units tall and centred; `pad` shrinks it further in. */
const tile = ({ rounded, pad }) => {
  const [x, y, w, h] = mark.box;
  const height = 236 * ((512 - pad * 2) / 512);
  const width = (height * w) / h;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512"${rounded ? ' rx="112"' : ''} fill="${INK}"/><svg x="${((512 - width) / 2).toFixed(2)}" y="${((512 - height) / 2).toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" viewBox="${x} ${y} ${w} ${h}"><path d="${mark.d}" fill="#fff"/></svg></svg>`;
};

writeFileSync(favicon, `${tile({ rounded: true, pad: 0 })}\n`);
console.log('wrote public/favicon.svg');

const ICONS = [
  { file: 'icon-192.png', size: 192, svg: tile({ rounded: true, pad: 0 }), transparent: true },
  { file: 'icon-512.png', size: 512, svg: tile({ rounded: true, pad: 0 }), transparent: true },
  // Maskable: the platform crops to its own shape; the P stays within the central 80 %.
  {
    file: 'maskable-512.png',
    size: 512,
    svg: tile({ rounded: false, pad: 60 }),
    transparent: false,
  },
  {
    file: 'apple-touch-icon.png',
    size: 180,
    svg: tile({ rounded: false, pad: 30 }),
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
