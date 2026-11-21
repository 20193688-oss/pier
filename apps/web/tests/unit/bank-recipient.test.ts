/* bank-recipient.test.ts: a bank account typed where Send expects a person
   (src/lib/app/bank-recipient.ts): CBU/CVU (with their check digits), alias, CCI and CLABE are
   told apart from @handles and Stellar addresses, and the send screen opens filled in. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { bankRecipient, bankSendPath, maskAccount } from '@/lib/app/bank-recipient';

test('a CBU or CVU (valid check digits), an alias, a CCI and a CLABE are bank accounts', () => {
  assert.deepEqual(bankRecipient('0170099222000001234561'), {
    kind: 'cbu',
    currency: 'ARS',
    country: 'AR',
    rail: 'ar_bank_transfer',
    details: { cbu: '0170099222000001234561' },
  });
  assert.equal(bankRecipient('0000003100012345678907')?.kind, 'cvu');
  assert.equal(bankRecipient('0170 0992 2200 0001 2345 61')?.details.cbu, '0170099222000001234561');
  assert.deepEqual(bankRecipient(' Sofia.Ruiz.MP '), {
    kind: 'alias',
    currency: 'ARS',
    country: 'AR',
    rail: 'ar_bank_transfer',
    details: { alias: 'sofia.ruiz.mp' },
  });
  assert.deepEqual(bankRecipient('002-193-00123456789012'), {
    kind: 'cci',
    currency: 'PEN',
    country: 'PE',
    rail: 'pe_bank_transfer',
    details: { cci: '00219300123456789012' },
  });
  assert.equal(bankRecipient('002010077777777771')?.rail, 'mx_spei');
});

test('people and addresses are not bank accounts, nor numbers that fail their check', () => {
  for (const x of [
    '',
    '@lucia',
    'lucia',
    'lucia_2',
    'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    '0170099222000001234562', // a CBU with a wrong check digit
    '002010077777777772', // a CLABE with a wrong check digit
    '12345',
    'ana', // too short for an alias, and a handle anyway
  ])
    assert.equal(bankRecipient(x), null, x);
});

test('the send screen opens with the account filled in; an account shows only its end', () => {
  assert.equal(
    bankSendPath({ currency: 'PEN', rail: 'pe_bank_transfer', details: { cci: '00219300123456789012' } }),
    '/app/send/bank?currency=PEN&rail=pe_bank_transfer&cci=00219300123456789012',
  );
  assert.equal(maskAccount('00219300123456789012'), '••••9012');
  assert.equal(maskAccount('123'), '123');
});
