/* remember.test.ts: what the device keeps to fill forms in again (src/lib/app/remember.ts): kept,
   read back only in the right shape, all forgotten on sign-out; and the @handle an email
   suggests. */
import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  forgetFilled,
  isAccount,
  isPayer,
  recall,
  recallEmail,
  remember,
  rememberEmail,
  suggestHandle,
} from '@/lib/app/remember';

class MemoryStorage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, String(v));
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

test('a payer and an account come back as kept; another shape counts as nothing', () => {
  remember('payer.ARS', { name: 'Sofía Ruiz', document: '32964233' });
  assert.deepEqual(recall('payer.ARS', isPayer), { name: 'Sofía Ruiz', document: '32964233' });
  assert.equal(recall('payer.BRL', isPayer), null);
  remember('payer.MXN', { name: 'x' });
  assert.equal(recall('payer.MXN', isPayer), null);
  localStorage.setItem('pier.fill.payer.COP', '{not json');
  assert.equal(recall('payer.COP', isPayer), null);
  const account = { holderName: 'Sofía', document: '', details: { cbu: '0170099220000001234561' } };
  remember('account.ar_bank', account);
  assert.deepEqual(recall('account.ar_bank', isAccount), account);
  remember('account.br_pix', { holderName: 'a', document: '', details: { key: 1 } });
  assert.equal(recall('account.br_pix', isAccount), null);
});

test('sign-out forgets everything kept, and only that', () => {
  rememberEmail(' ana@gmail.com ');
  remember('payer.ARS', { name: 'A', document: '1' });
  localStorage.setItem('pier.theme', 'dark');
  assert.equal(recallEmail(), 'ana@gmail.com');
  forgetFilled();
  assert.equal(recallEmail(), null);
  assert.equal(recall('payer.ARS', isPayer), null);
  assert.equal(localStorage.getItem('pier.theme'), 'dark');
});

test('without storage nothing breaks and nothing is recalled', () => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  remember('payer.ARS', { name: 'A', document: '1' });
  assert.equal(recall('payer.ARS', isPayer), null);
  forgetFilled();
});

test('the @handle an email suggests: its local part in the handle alphabet, or nothing', () => {
  assert.equal(suggestHandle('emanuel250gameryt@gmail.com'), 'emanuel250gameryt');
  assert.equal(suggestHandle('Ana.Pérez-Gómez@empresa.com.ar'), 'ana_perez_gomez');
  assert.equal(suggestHandle('juan+pagos@x.io'), 'juan_pagos');
  assert.equal(suggestHandle('a.b@x.io'), 'a_b');
  assert.equal(suggestHandle('ab@x.io'), '');
  assert.equal(suggestHandle('averyveryverylonglocalpartname@x.io'), 'averyveryverylongloc');
  assert.equal(suggestHandle('__@x.io'), '');
  assert.equal(suggestHandle(null), '');
});
