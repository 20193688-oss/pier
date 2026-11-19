/* The merchant / business dashboard in a real browser (mock mode): sign in with the wallet, put
   liquidity in, accept and release orders, publish an offer, create an API key shown once. */
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, pickDemoWallet, trackErrors } from '@e2e/helpers';

async function signIn(page: Page, lang: 'es' | 'en') {
  await page.goto(`/dashboard?lang=${lang}`);
  await page
    .getByRole('main')
    .getByRole('button', { name: lang === 'es' ? 'Conectar wallet' : 'Connect wallet' })
    .click();
  await pickDemoWallet(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    lang === 'es' ? 'Resumen' : 'Overview',
    { timeout: 15_000 },
  );
}

test('liquidity: deposit with two signatures and authorise the matcher (Spanish)', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signIn(page, 'es');
  await page.goto('/dashboard/liquidity');
  await expect(page.getByText('Tesorería')).toBeVisible();
  await page.getByRole('button', { name: 'Depositar' }).first().click();
  await page.getByRole('dialog').getByLabel('Monto').fill('250');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByText(/Permitir que el mercado tome 250 USDC/)).toBeVisible();
  await page.getByRole('button', { name: /Firmar con mi wallet/ }).click();
  await expect(page.getByText('Listo. El saldo se actualiza en unos segundos.')).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('12.700,5 USDC')).toBeVisible();

  await page.getByRole('button', { name: 'Autorizar a pedospe' }).first().click();
  await page.getByRole('dialog').getByLabel('Red').selectOption('arbitrum');
  await page.getByRole('dialog').getByLabel('Límite por orden').fill('750');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: /Firmar con mi wallet/ }).click();
  await expect(page.getByText('Hasta 750 USDC')).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('orders: accept a sale and release a purchase from the merchant wallet (English)', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signIn(page, 'en');
  await page.goto('/dashboard/orders');
  await page.getByRole('button', { name: 'Accept' }).first().click();
  await page.getByRole('button', { name: /Sign with my wallet/ }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Release' }).first().click();
  await expect(page.getByText(/Release only once/)).toBeVisible();
  await page.getByRole('button', { name: /Sign with my wallet/ }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('offers and API keys: publish an offer; a new key is shown once (Spanish)', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signIn(page, 'es');
  await page.goto('/dashboard/offers');
  await page.getByRole('button', { name: 'Nueva oferta' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Precio de 1/).fill('1490');
  await dialog.getByLabel(/Mínimo por orden/).fill('5000');
  await dialog.getByLabel(/Máximo por orden/).fill('900000');
  await dialog.getByRole('button', { name: 'Nueva oferta' }).click();
  await expect(page.getByText('Oferta publicada')).toBeVisible({ timeout: 10_000 });

  await page.goto('/dashboard/keys');
  await page.getByRole('button', { name: 'Crear clave' }).click();
  await page.getByRole('dialog').getByLabel('Nombre').fill('Bot de liberación');
  await page.getByRole('dialog').getByRole('button', { name: 'Crear clave' }).click();
  await expect(page.getByTestId('new-api-key')).toHaveText(/^pk_test_[a-z0-9]{20,}$/);
  await page.getByRole('button', { name: 'La guardé' }).click();
  await expect(page.getByTestId('new-api-key')).toHaveCount(0);
  await expect(page.getByText('Bot de liberación')).toBeVisible();
  expect(errors).toEqual([]);
});
