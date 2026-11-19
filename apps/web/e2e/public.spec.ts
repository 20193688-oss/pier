/* The public site in a real browser (mock mode): the landing in both languages, the buy flow in
   Spanish and the sell flow in English, end to end with the demo wallet. */
import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, pickDemoWallet, trackErrors } from '@e2e/helpers';

test('the landing reads in Spanish by default and in English after switching', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'USDC por transferencia bancaria, de persona a persona',
  );
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Ver en English' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'USDC by bank transfer, person to person',
  );
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'How a purchase works' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('buy: amount, price, who pays, the exact transfer, then the USDC arrives', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/app?lang=es');
  await page.getByLabel('Pagas', { exact: true }).fill('150000');
  await page.getByRole('button', { name: 'Conectar una wallet para ver el precio' }).click();
  await pickDemoWallet(page);
  await expect(page.getByText('1 USDC = 1488,5 ARS')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Continuar' }).click();

  // The payer's document is checked as typed (a DNI or a CUIT/CUIL for pesos).
  await page.getByLabel('Nombre completo').fill('Lucía Fernández');
  await page.getByLabel('Número de documento').fill('20329642331');
  await page.getByRole('button', { name: 'Abrir orden' }).click();
  await expect(page.getByText('El dígito verificador no coincide')).toBeVisible();
  await page.getByLabel('Número de documento').fill('32964233');
  await page.getByRole('button', { name: 'Abrir orden' }).click();

  // The slip: the exact amount, the merchant's account, the clock.
  await expect(page.getByText('Transfiere exactamente')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.marker')).toHaveText(/150\.000,00\sARS/);
  await expect(page.getByText('0170099222000001234561')).toBeVisible();
  await expect(page.getByRole('timer')).toContainText('para pagar');
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Ya transferí' }).click();
  await expect(page.getByText('Transferencia informada')).toBeVisible();
  await expect(page.getByText('Orden completada')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/llegaron a tu wallet/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('sell: the payout account, two signatures, the merchant pays, the seller releases', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = trackErrors(page);
  await page.goto('/app?side=sell&lang=en');
  await page.getByLabel('You sell', { exact: true }).fill('40');
  await page.getByRole('button', { name: 'Connect a wallet to see the price' }).click();
  await pickDemoWallet(page);
  await expect(page.getByText('1 USDC = 1,452 ARS')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Account holder').fill('Sofía Ruiz');
  // An alias and a CBU together are refused: one or the other.
  await page.getByLabel('Alias').fill('sofia.ruiz.mp');
  await page.getByLabel('CUIT or CUIL').fill('20329642330');
  await page.getByRole('button', { name: 'Open order' }).click();

  await expect(page.getByRole('heading', { name: 'Lock your USDC in the order' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Sign with my wallet' }).click();
  await expect(page.getByText('Waiting for a merchant to accept the order.')).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('heading', { name: 'Check your account' })).toBeVisible({
    timeout: 40_000,
  });
  await page.getByRole('button', { name: 'Release USDC' }).click();
  await expect(page.getByText('Order completed')).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});
