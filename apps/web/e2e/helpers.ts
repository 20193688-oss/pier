/* Shared steps for the browser checks: they run against the dev server in mock mode (the mock API
   and the demo wallet), so every flow can be clicked through without a backend or a wallet. */
import { expect, type Page } from '@playwright/test';

/** Pick the demo wallet in the open connect dialog and wait for the sign-in to finish. */
export async function pickDemoWallet(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /pedospe demo/ }).click();
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
