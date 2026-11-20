/* The payments app (/app) in a real browser, mock mode: sign in with SEP-10 and claim a handle,
   send to a handle, receive (payment link and SEP-7), scan a pasted payload, pay a shop's QR
   through a merchant, add money (buy), withdraw (sell), pay a charge from the balance, activate a
   new wallet, and the profile. Spanish and English. */
import { expect, test } from '@playwright/test';
import { appSignIn, demoQr, expectNoHorizontalScroll, trackErrors } from '@e2e/helpers';

test('sign in, claim a handle, and the home screen (Spanish)', async ({ page }) => {
  const errors = trackErrors(page);
  await appSignIn(page, 'es', 'user', { keepHandleOffer: true });
  await expect(page.getByRole('heading', { name: 'Elige tu @usuario' })).toBeVisible();
  await page.getByLabel('Usuario').fill('lucia');
  await page.getByRole('button', { name: 'Guardar @usuario' }).click();
  await expect(page.getByText('Alguien ya tiene @lucia')).toBeVisible();
  await page.getByLabel('Usuario').fill('sofia_r');
  await page.getByRole('button', { name: 'Guardar @usuario' }).click();
  await expect(page.getByText('Hola, @sofia_r')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('balance')).toHaveText('US$ 248,35');
  await expect(page.getByText(/≈ .*ARS/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('navigation', { name: 'Secciones de la app' }).first()).toBeVisible();
  await expect(page.getByText('Recibiste de @lucia')).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('send to a handle with a note: review the resolved address, sign, done (Spanish)', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await appSignIn(page, 'es');
  await page.getByRole('link', { name: 'Enviar' }).click();
  await page.getByLabel('@usuario o dirección de Stellar').fill('@nadie_aqui');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByText('Nadie tiene @nadie_aqui.')).toBeVisible();
  await page.getByLabel('@usuario o dirección de Stellar').fill('@lucia');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByLabel('Cuánto envías, en dólares').fill('9999');
  await expect(page.getByText('Es más que tu saldo.')).toBeVisible();
  await page.getByLabel('Cuánto envías, en dólares').fill('12.5');
  await page.getByLabel('Nota (opcional)').fill('Pizza');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Revisa el envío' })).toBeVisible();
  await expect(page.getByText(/^G[A-Z2-7]{55}$/)).toBeVisible();
  await page.getByRole('button', { name: 'Enviar US$ 12,50' }).click();
  await expect(page.getByRole('heading', { name: 'Enviado' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('link', { name: 'Listo' }).click();
  await expect(page.getByTestId('balance')).toHaveText('US$ 235,85', { timeout: 15_000 });
  await page.getByRole('link', { name: 'Actividad' }).click();
  await expect(page.getByText('Enviaste a @lucia').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('receive: a payment link with a handle, or a SEP-7 request (English)', async ({ page }) => {
  const errors = trackErrors(page);
  await appSignIn(page, 'en');
  await page.getByRole('link', { name: 'Receive' }).first().click();
  await expect(page.getByRole('img', { name: 'QR code to pay you' })).toBeVisible();
  await page.getByLabel('Ask for an amount (optional)').fill('20');
  const link = page.getByText(/\/app\/send\?to=G[A-Z2-7]{55}&amount=20&asset=USDC/);
  await expect(link).toBeVisible();
  await page.getByRole('switch', { name: 'For other Stellar wallets' }).click();
  await expect(page.getByText(/\/app\/send/)).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('scan a pasted payload: a payment link opens send, a secret key warns (English)', async ({
  page,
  baseURL,
}) => {
  const errors = trackErrors(page);
  await appSignIn(page, 'en');
  await page.goto('/app/scan');
  await page
    .getByLabel('Code, link, address or @handle')
    .fill('SBU2RRGLXH3E5CQHTD3ODLDF2BWDCYUSSBLLZ5GNW7JXHDIYKXZWHOKR');
  await page.getByRole('button', { name: 'Read' }).click();
  await expect(page.getByRole('heading', { name: 'That is a secret key' })).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  await page.getByLabel('Code, link, address or @handle').fill('https://evil.example/app/send?to=%40lucia');
  await page.getByRole('button', { name: 'Read' }).click();
  await expect(page.getByText(/That link is not from/)).toBeVisible();
  await page
    .getByLabel('Code, link, address or @handle')
    .fill(`${baseURL}/app/send?to=%40lucia&amount=3&note=Coffee`);
  await page.getByRole('button', { name: 'Read' }).click();
  await expect(page.getByRole('heading', { name: 'Check the payment' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('@lucia')).toBeVisible();
  await expect(page.getByText('Coffee')).toBeVisible();
  expect(errors).toEqual([]);
});

test("pay a shop's QR through a merchant: confirm, wait, the shop got paid, release (Spanish)", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = trackErrors(page);
  await appSignIn(page, 'es');
  const qr = await demoQr(page, 'cafe');
  await page.goto('/app/scan');
  await page.getByLabel('Código, enlace, dirección o @usuario').fill(qr);
  await page.getByRole('button', { name: 'Leer' }).click();
  await expect(page.getByTestId('shop-name')).toHaveText('Cafe El Molino');
  await expect(page.locator('.marker')).toHaveText(/12\.500,00\sARS/);
  await page.getByRole('button', { name: /^Pagar US\$/ }).click({ timeout: 15_000 });
  await expect(page.getByTestId('qr-status')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Sí, el comercio cobró' }).click({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Sí, el comercio cobró' }).click();
  await expect(page.getByText('El comercio cobró 12.500,00 ARS.')).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('add money: amount, who pays, the exact transfer, then the USDC arrive (Spanish)', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = trackErrors(page);
  await appSignIn(page, 'es');
  await page.getByRole('link', { name: 'Agregar' }).click();
  await page.locator('#trade-amount').fill('150000');
  await expect(page.getByText('1 USDC = 1488,5 ARS')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByLabel('Nombre completo').fill('Sofía Ruiz');
  await page.getByLabel('Número de documento').fill('32964233');
  await page.getByRole('button', { name: 'Abrir orden' }).click();
  await expect(page.getByText('Transfiere exactamente')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.marker')).toHaveText(/150\.000,00\sARS/);
  await page.getByRole('button', { name: 'Ya transferí' }).click();
  await expect(page.getByText('Orden completada')).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

test('withdraw: the payout account, one signature, the merchant pays, release (English)', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = trackErrors(page);
  await appSignIn(page, 'en');
  await page.getByRole('link', { name: 'Withdraw' }).click();
  await page.locator('#trade-amount').fill('40');
  await expect(page.getByText('1 USDC = 1,452 ARS')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Account holder').fill('Sofía Ruiz');
  await page.getByLabel('Alias').fill('sofia.ruiz.mp');
  await page.getByLabel('CUIT or CUIL').fill('20329642330');
  await page.getByRole('button', { name: 'Open order' }).click();
  await page.getByRole('button', { name: 'Sign', exact: true }).click({ timeout: 15_000 });
  await expect(page.getByText('Waiting for a merchant to accept the order.')).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Release USDC' }).click({ timeout: 40_000 });
  await expect(page.getByText('Order completed')).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('pay a charge from the balance, or in pesos through the checkout (English)', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await appSignIn(page, 'en', 'user', { path: '/app/charge/ch_pedido1042' });
  await expect(page.getByText('Tienda Lerma')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: 'Pay in ARS by transfer' })).toHaveAttribute(
    'href',
    '/pay/ch_pedido1042',
  );
  await page.getByRole('button', { name: /^Pay \$\d/ }).click();
  await expect(page.getByRole('heading', { name: 'Paid' })).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('a new wallet activates for free, then can receive (Spanish)', async ({ page }) => {
  const errors = trackErrors(page);
  await appSignIn(page, 'es', 'fresh');
  await expect(page.getByRole('heading', { name: 'Activa tu wallet' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Activar wallet' }).click();
  await expect(page.getByText('Tu wallet está lista para recibir USDC.')).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId('balance')).toHaveText('US$ 0,00');
  await expect(page.getByRole('heading', { name: 'Activa tu wallet' })).toBeHidden();
  expect(errors).toEqual([]);
});

test('profile: address, language, and sign out (English)', async ({ page }) => {
  const errors = trackErrors(page);
  await appSignIn(page, 'en');
  await page.getByRole('link', { name: 'Profile' }).click();
  await expect(page.getByText('Your address')).toBeVisible();
  await expect(page.getByText(/^G[A-Z2-7]{55}$/)).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Your dollars, in your pocket' })).toBeVisible();
  expect(errors).toEqual([]);
});
