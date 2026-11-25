// Renders the app's icons as the brand kit draws them (Pier_Marca v2, Pier_Icono_App): a tile
// from Marea to Abismo with diffuse cobalt and celeste lights, a glass panel with a bright rim,
// and the «P» symbol (its upper half in Aurora glass, the lower half white). The symbol comes
// from src/components/ui/logo-paths.ts. Writes public/favicon.svg and, with Playwright's
// Chromium, the PNGs in public/icons: 192 and 512 (purpose "any", rounded), a 512 maskable one
// (full bleed, the P inside the safe zone) and the 180 apple-touch-icon (full bleed, the platform
// rounds it). Run after changing the logo: `npm run icons -w @pier/web`. The files are committed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { chromium } from '@playwright/test';

const ABISMO = '#070B1F';
const out = fileURLToPath(new URL('../public/icons/', import.meta.url));
const favicon = fileURLToPath(new URL('../public/favicon.svg', import.meta.url));
// Node runs the TypeScript module as is (its types are stripped).
const { LOGO } = await import(new URL('../src/components/ui/logo-paths.ts', import.meta.url).href);
const { mark } = LOGO;

/** The icon on a 1024-unit tile; `scale` sizes the P (1 = the kit's), `rounded` clips the corners. */
const tile = ({ rounded, scale }) => {
  const [x, y, w, h] = mark.box;
  // The kit's P is 528 units tall on the 1024 tile (from 276 to 804, strokes included).
  const height = 584 * scale;
  const width = (height * w) / h;
  const px = (1024 - width) / 2;
  const py = (1024 - height) / 2;
  const clip = rounded
    ? '<rect width="1024" height="1024" rx="230.4"/>'
    : '<rect width="1024" height="1024"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#12309E"/><stop offset="1" stop-color="${ABISMO}"/></linearGradient><filter id="f" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="112.6"/></filter><linearGradient id="r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.65"/><stop offset="0.45" stop-color="#FFFFFF" stop-opacity="0.12"/><stop offset="1" stop-color="#9FE9FF" stop-opacity="0.45"/></linearGradient><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.16"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0.04"/></linearGradient><clipPath id="c">${clip}</clipPath><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="219" y1="219" x2="459" y2="511"><stop offset="0" stop-color="#C4F5FF"/><stop offset="0.5" stop-color="#7FE0FF"/><stop offset="1" stop-color="#3FBFFF"/></linearGradient></defs><g clip-path="url(#c)"><rect width="1024" height="1024" fill="url(#b)"/><g filter="url(#f)"><circle cx="184.3" cy="122.9" r="430.1" fill="#2F54FF" opacity="0.95"/><circle cx="901.1" cy="942.1" r="368.6" fill="#36C6FF" opacity="0.95"/><circle cx="972.8" cy="51.2" r="225.3" fill="#7FDBFF" opacity="0.55"/></g>${rounded ? '<rect x="61.44" y="61.44" width="901.12" height="901.12" rx="194.56" fill="url(#s)"/><rect x="61.44" y="61.44" width="901.12" height="901.12" rx="194.56" fill="none" stroke="url(#r)" stroke-width="2.87"/>' : ''}</g><svg x="${px.toFixed(2)}" y="${py.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" viewBox="${x} ${y} ${w} ${h}"><g fill="none" stroke-width="${mark.stroke}" stroke-linecap="butt" stroke-linejoin="miter"><path d="${mark.pA}" stroke="url(#g)"/><path d="${mark.pB}" stroke="#FFFFFF"/></g></svg></svg>`;
};

writeFileSync(favicon, `${tile({ rounded: true, scale: 1.08 })}\n`);
console.log('wrote public/favicon.svg');

const ICONS = [
  { file: 'icon-192.png', size: 192, svg: tile({ rounded: true, scale: 1 }), transparent: true },
  { file: 'icon-512.png', size: 512, svg: tile({ rounded: true, scale: 1 }), transparent: true },
  // Maskable: the platform crops to its own shape; the P stays within the central 80 %.
  {
    file: 'maskable-512.png',
    size: 512,
    svg: tile({ rounded: false, scale: 0.82 }),
    transparent: false,
  },
  {
    file: 'apple-touch-icon.png',
    size: 180,
    svg: tile({ rounded: false, scale: 0.92 }),
    transparent: false,
  },
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const icon of ICONS) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
    await page.setContent(
      `<html><body style="margin:0;background:${icon.transparent ? 'transparent' : ABISMO}">` +
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
