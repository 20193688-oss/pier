/* The merchant / business dashboard in a real browser (mock mode): sign in with the wallet
   (SEP-10), put liquidity in and authorise the matcher (XDR checked, signed and submitted through
   the API), accept and release orders, pay a QR payment's shop QR, publish an offer, create an API
   key shown once, and register a new wallet with a SEP-10 proof. */
import { expect, test, type Page } from '@playwright/test';
import { dashboardSignIn, expectNoHorizontalScroll, trackErrors } from '@e2e/helpers';

async function signIn(page: Page, lang: 'es' | 'en') {
  await dashboardSignIn(page, lang, 'merchant');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    lang === 'es' ? 'Resumen' : 'Overview',
    { timeout: 15_000 },
  );
}

test('liquidity: deposit with one signature and authorise the matcher (Spanish)', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signIn(page, 'es');
  await page.goto('/dashboard/liquidity');
  await expect(page.getByText('Tesorería')).toBeVisible();
  await page.getByRole('button', { name: 'Depositar' }).first().click();
  await page.getByRole('dialog').getByLabel('Monto').fill('250');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Firmar' }).click();
  await expect(page.getByText('12.700,5 USDC')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Autorizar a Midpoint' }).first().click();
  await page.getByRole('dialog').getByLabel('Límite por orden').fill('750');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Firmar' }).click();
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
  await page.getByRole('dialog').getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Release' }).first().click();
  await expect(page.getByText(/Release only once/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign', exact: true }).click();
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

test("a QR payment: the merchant sees the shop's QR to pay and marks it paid (English)", async ({
  page,
}) => {
  const errors = trackErrors(page);
  await signIn(page, 'en');
  await page.goto('/dashboard/orders');
  await page.getByText('Kiosco La Esquina').first().click();
  await expect(page.getByRole('img', { name: /Kiosco La Esquina/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/^00020101021143/).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('a new wallet: create an organization and register the wallet with a SEP-10 proof (Spanish)', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await dashboardSignIn(page, 'es', 'fresh');
  await page.getByLabel('Nombre', { exact: true }).fill('Cambios Salta');
  await page.getByRole('button', { name: /Crear/ }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Resumen', { timeout: 15_000 });
  await page.goto('/dashboard/liquidity');
  await page.getByRole('button', { name: /Registrar/ }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: /Registrar|Firmar/ }).last().click();
  await expect(page.getByText('Billetera registrada')).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
});
