/* mock-wallet.test.ts: in mock mode an email stands in for the code sent to it and picks the demo
   persona (src/lib/mock/wallet.ts, personaForEmail). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { personaForEmail } from '@/lib/mock/wallet';

test('the persona named before the @ wins, whatever the mode or the place', () => {
  assert.equal(personaForEmail('merchant@demo.test', 'signin', 'app'), 'merchant');
  assert.equal(personaForEmail('Business@demo.test', 'signup', 'app'), 'business');
  assert.equal(personaForEmail(' fresh@demo.test', 'signin', 'dashboard'), 'fresh');
  assert.equal(personaForEmail('user@x.io', 'signup', 'dashboard'), 'user');
});

test('any other email: a new wallet to sign up, the funded person in the app, the merchant in the dashboard', () => {
  assert.equal(personaForEmail('ana@gmail.com', 'signup', 'app'), 'fresh');
  assert.equal(personaForEmail('ana@gmail.com', 'signin', 'app'), 'user');
  assert.equal(personaForEmail('ana@gmail.com', 'signin', 'dashboard'), 'merchant');
  assert.equal(personaForEmail(null, 'signin', 'app'), 'user');
  assert.equal(personaForEmail('users@demo.test', 'signin', 'dashboard'), 'merchant');
});
