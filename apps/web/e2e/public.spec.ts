/* The public site in a real browser (mock mode): the landing in both languages. Buying and selling
   now live in the payments app (e2e/app.spec.ts). */
import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, trackErrors } from '@e2e/helpers';

test('the landing reads in Spanish by default and in English after switching', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'De soles a dólares digitales, con Yape',
  );
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Ver en English' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'From soles to digital dollars, with Yape',
  );
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'How a purchase works' })).toBeVisible();
  expect(errors).toEqual([]);
});
