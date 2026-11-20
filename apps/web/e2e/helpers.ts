/* Shared steps for the browser checks: they run against the dev server in mock mode (the mock API
   and the demo wallet), so every flow can be clicked through without a backend or a wallet. */
import { expect, type Page } from '@playwright/test';

export const PERSONA = {
  es: {
    user: 'Persona (wallet de prueba)',
    merchant: 'Comerciante: Norte Cambios',
    business: 'Empresa: Tienda Lerma',
    fresh: 'Wallet nueva, sin registrar',
  },
  en: {
    user: 'A person (test wallet)',
    merchant: 'Merchant: Norte Cambios',
    business: 'Business: Tienda Lerma',
    fresh: 'A new wallet, not registered',
  },
} as const;

type Persona = keyof (typeof PERSONA)['es'];

/** Sign in to the payments app as a demo persona (SEP-10 against the mock API), skipping the
    handle offer unless asked to keep it. */
export async function appSignIn(
  page: Page,
  lang: 'es' | 'en',
  persona: Persona = 'user',
  opts: { path?: string; keepHandleOffer?: boolean } = {},
) {
  await page.goto(`${opts.path ?? '/app'}${(opts.path ?? '/app').includes('?') ? '&' : '?'}lang=${lang}`);
  await page.getByRole('button', { name: PERSONA[lang][persona] }).click();
  if (!opts.keepHandleOffer && (opts.path ?? '/app') === '/app') {
    const skip = page.getByRole('button', { name: lang === 'es' ? 'Ahora no' : 'Not now' });
    await skip.click({ timeout: 15_000 });
    await expect(page.getByTestId('balance')).toBeVisible({ timeout: 15_000 });
  }
}

/** Sign in from the dashboard's dialog as a demo persona. */
export async function dashboardSignIn(page: Page, lang: 'es' | 'en', persona: Persona = 'merchant') {
  await page.goto(`/dashboard?lang=${lang}`);
  await page
    .getByRole('main')
    .getByRole('button', { name: lang === 'es' ? 'Conectar wallet' : 'Connect wallet' })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: PERSONA[lang][persona] }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

/** The page never scrolls sideways. */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

/** Collect uncaught page errors; the test fails if any happened. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** A merchant QR the demo knows, built like the mock's (src/lib/mock/qr.ts). */
export async function demoQr(page: Page, which: 'cafe' | 'kiosk' | 'pix' = 'cafe'): Promise<string> {
  // Imported inside the page from the dev server (mock mode serves the source).
  return page.evaluate(
    async ([w, path]) => {
      const mod = (await import(/* @vite-ignore */ path)) as { DEMO_QRS: Record<string, string> };
      return mod.DEMO_QRS[w];
    },
    [which, '/src/lib/mock/qr.ts'] as const,
  );
}
