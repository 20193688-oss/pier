/* Shared steps for the browser checks: they run against the dev server in mock mode (the mock API
   and the demo wallet), so every flow can be clicked through without a backend or a wallet. */
import { expect, type Locator, type Page } from '@playwright/test';

/* The demo personas (src/lib/mock/fixtures.ts). In mock mode the email stands in for the code
   sent to it: `<persona>@demo.test` signs in as that persona, and any 6-digit code works. */
export type Persona = 'user' | 'merchant' | 'business' | 'fresh';

const WORDS = {
  es: { signUp: 'Crear cuenta', signIn: 'Iniciar sesión', next: 'Continuar', code: 'Código' },
  en: { signUp: 'Create account', signIn: 'Sign in', next: 'Continue', code: 'Code' },
} as const;

/** The email form, then the code: what a person types to sign up or sign in. */
async function emailCode(
  scope: Page | Locator,
  lang: 'es' | 'en',
  persona: Persona,
  final: string,
) {
  const w = WORDS[lang];
  await scope.getByLabel('Email').fill(`${persona}@demo.test`);
  await scope.getByRole('button', { name: w.next, exact: true }).click();
  await scope.getByLabel(w.code).fill('123456');
  await scope.getByRole('button', { name: final, exact: true }).click();
}

/** Sign up (a new wallet) or sign in to the payments app as a demo persona (SEP-10 against the
    mock API), skipping the handle offer unless asked to keep it. */
export async function appSignIn(
  page: Page,
  lang: 'es' | 'en',
  persona: Persona = 'user',
  opts: { path?: string; keepHandleOffer?: boolean } = {},
) {
  const w = WORDS[lang];
  await page.goto(
    `${opts.path ?? '/app'}${(opts.path ?? '/app').includes('?') ? '&' : '?'}lang=${lang}`,
  );
  const final = persona === 'fresh' ? w.signUp : w.signIn;
  await page.getByRole('button', { name: final, exact: true }).click();
  await emailCode(page, lang, persona, final);
  if (!opts.keepHandleOffer && (opts.path ?? '/app') === '/app') {
    const skip = page.getByRole('button', { name: lang === 'es' ? 'Ahora no' : 'Not now' });
    await skip.click({ timeout: 15_000 });
    await expect(page.getByTestId('balance')).toBeVisible({ timeout: 15_000 });
  }
}

/** Sign in on the dashboard's sign-in page as a demo persona. */
export async function dashboardSignIn(
  page: Page,
  lang: 'es' | 'en',
  persona: Persona = 'merchant',
) {
  await page.goto(`/dashboard?lang=${lang}`);
  const main = page.getByRole('main');
  await emailCode(main, lang, persona, WORDS[lang].signIn);
  await expect(main.getByLabel('Email')).toBeHidden({ timeout: 15_000 });
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
export async function demoQr(
  page: Page,
  which: 'cafe' | 'kiosk' | 'pix' = 'cafe',
): Promise<string> {
  // Imported inside the page from the dev server (mock mode serves the source).
  return page.evaluate(
    async ([w, path]) => {
      const mod = (await import(/* @vite-ignore */ path)) as { DEMO_QRS: Record<string, string> };
      return mod.DEMO_QRS[w];
    },
    [which, '/src/lib/mock/qr.ts'] as const,
  );
}
