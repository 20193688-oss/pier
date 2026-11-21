/* rails.test.ts: the account and document checks the screens run before anything leaves the
   browser (src/lib/p2p/rails.ts). Each mirrors the API's rail table; a value the API would refuse
   must be refused here first, and a real account must never be. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  RAILS,
  RAIL_IDS,
  accountRails,
  isQrRailId,
  railsFor,
  fiatDecimals,
  checkCbu,
  checkAlias,
  checkCuit,
  checkDni,
  checkCpf,
  checkCnpj,
  checkPixKey,
  checkClabe,
  checkRfc,
  checkCurp,
  checkCci,
  checkRuc,
  checkDniRuc,
  checkRut,
  checkNitCc,
  checkCiNit,
  idOptional,
  withoutId,
  checkAccount,
  defaultCurrency,
  HOME_CURRENCY,
  normalizeDetails,
  checkPayerDocument,
  checkEmail,
  checkHolderName,
  isRailId,
  checkBeneficiary,
  documentOf,
  oneOfKey,
} from '@/lib/p2p/rails';

test('the rail table names each rail once, with its currency and a document', () => {
  assert.deepEqual([...RAIL_IDS].sort(), [
    'ar_bank_transfer',
    'ar_qr',
    'bo_bank_transfer',
    'br_pix',
    'br_pix_qr',
    'cl_bank_transfer',
    'co_bank_transfer',
    'mx_spei',
    'pe_bank_transfer',
    'pe_qr',
  ]);
  for (const id of RAIL_IDS) {
    assert.equal(RAILS[id].id, id);
    assert.match(RAILS[id].currency, /^[A-Z]{3}$/);
    // An account rail asks for an account; a QR rail asks for nothing (the QR is the destination).
    assert.equal(RAILS[id].fields.length > 0, !RAILS[id].qr, id);
  }
  assert.deepEqual(
    railsFor('ARS').map((r) => r.id),
    ['ar_bank_transfer', 'ar_qr'],
  );
  assert.deepEqual(railsFor('EUR'), []);
  assert.equal(fiatDecimals('CLP'), 0);
  assert.equal(fiatDecimals('ARS'), 2);
  assert.ok(isRailId('br_pix'));
  assert.ok(!isRailId('toString'));
});

test('CBU and CVU: 22 digits and both check digits', () => {
  assert.equal(checkCbu('0170099222000001234561'), null);
  assert.equal(checkCbu('2850590940090418135201'), null);
  assert.equal(checkCbu('0000003110000000123456'), null, 'a CVU uses the same checks');
  assert.equal(checkCbu('0170 0992 2200 0001 2345 61'), null, 'spaces are ignored');
  assert.equal(checkCbu('0170099322000001234561'), 'checksum', "first block's check digit");
  assert.equal(checkCbu('0170099222000001234562'), 'checksum', "second block's check digit");
  assert.equal(checkCbu('017009922200000123456'), 'format');
  assert.equal(checkCbu('01700992220000012345ab'), 'format');
});

test('alias: 6 to 20 letters, digits, dots or hyphens', () => {
  for (const ok of ['mi.alias.mp', 'CASA-PERRO-SOL', 'abc123'])
    assert.equal(checkAlias(ok), null, ok);
  for (const bad of ['corto', 'un alias', 'a'.repeat(21), 'alias_con_guion'])
    assert.equal(checkAlias(bad), 'format', bad);
});

test('CUIT, CUIL and DNI', () => {
  assert.equal(checkCuit('20-32964233-0'), null);
  assert.equal(checkCuit('30500010912'), null);
  assert.equal(checkCuit('20329642331'), 'checksum');
  assert.equal(checkCuit('99329642330'), 'format', 'unknown type prefix');
  assert.equal(checkDni('32.964.233'), null);
  assert.equal(checkDni('123'), 'format');
});

test('CPF and CNPJ, and the PIX key types', () => {
  assert.equal(checkCpf('529.982.247-25'), null);
  assert.equal(checkCpf('52998224724'), 'checksum');
  assert.equal(checkCpf('11111111111'), 'checksum', 'all the same digit');
  assert.equal(checkCnpj('11.222.333/0001-81'), null);
  assert.equal(checkCnpj('11222333000182'), 'checksum');
  assert.equal(checkPixKey('cpf', '52998224725'), null);
  assert.equal(checkPixKey('cnpj', '11222333000181'), null);
  assert.equal(checkPixKey('email', 'joao@example.com'), null);
  assert.equal(checkPixKey('email', 'joao@'), 'format');
  assert.equal(checkPixKey('phone', '+55 11 91234-5678'), null);
  assert.equal(checkPixKey('phone', '11912345678'), 'format', 'the country code is required');
  assert.equal(checkPixKey('evp', '123e4567-e89b-12d3-a456-426614174000'), null);
  assert.equal(checkPixKey('evp', '123e4567e89b12d3a456426614174000'), 'format');
  assert.equal(checkPixKey('other', 'x'), 'format');
  assert.equal(checkPixKey('email', ' '), 'required');
});

test('CLABE, RFC and CURP', () => {
  assert.equal(checkClabe('002010077777777771'), null);
  assert.equal(checkClabe('032180000118359719'), null);
  assert.equal(checkClabe('002010077777777772'), 'checksum');
  assert.equal(checkClabe('00201007777777777'), 'format');
  assert.equal(checkRfc('GODE561231GR8'), null);
  assert.equal(checkRfc('ABC010101AB1'), null, "a company's has 12 characters");
  assert.equal(checkRfc('GODE5612'), 'format');
  assert.equal(checkCurp('GODE561231HDFRRN09'), null);
});

test('Peru, Chile and Colombia', () => {
  assert.equal(checkCci('00219300123456789012'), null);
  assert.equal(checkCci('0021930012345678901'), 'format');
  assert.equal(checkRuc('20100070970'), null);
  assert.equal(checkRuc('20100070971'), 'checksum');
  assert.equal(checkDniRuc('46779354'), null);
  assert.equal(checkRut('12.345.678-5'), null);
  assert.equal(checkRut('11111111-1'), null);
  assert.equal(checkRut('12.345.678-K'), 'checksum');
  assert.equal(checkRut('123'), 'format');
  assert.equal(checkNitCc('1020304050'), null);
  assert.equal(checkNitCc('12'), 'format');
});

test("an account: holder and the rail's details, as the server names them", () => {
  const ar = (details: Record<string, string>) =>
    checkAccount('ar_bank_transfer', { holderName: 'Ana Gómez', details });
  assert.deepEqual(ar({ cbu: '0170099222000001234561', cuit: '20329642330' }), {});
  assert.deepEqual(
    ar({ alias: 'ana.gomez.mp', cuit: '20329642330' }),
    {},
    'an alias alone is enough',
  );
  assert.deepEqual(ar({ cuit: '20329642330' }), { cbu: 'required' }, 'a CBU or an alias');
  assert.deepEqual(
    ar({ cbu: '0170099222000001234561', alias: 'ana.gomez.mp', cuit: '20329642330' }),
    { alias: 'exclusive' },
    'never both',
  );
  assert.deepEqual(ar({ cbu: '0170099222000001234562', cuit: '20329642330' }), { cbu: 'checksum' });
  assert.deepEqual(
    ar({ alias: 'ana.gomez.mp' }),
    { cuit: 'required' },
    "the holder's CUIT is a detail",
  );
  assert.deepEqual(
    checkAccount('br_pix', {
      holderName: 'João',
      details: { keyType: 'phone', key: '+5511912345678' },
    }),
    {},
  );
  assert.deepEqual(
    checkAccount('br_pix', { holderName: 'João', details: { keyType: 'fax', key: '1' } }),
    { keyType: 'format', key: 'format' },
  );
  assert.deepEqual(
    checkAccount('mx_spei', { holderName: 'María', details: { clabe: '002010077777777771' } }),
    {},
  );
  assert.deepEqual(checkAccount('mx_spei', { holderName: '1', details: { clabe: '1' } }), {
    holderName: 'format',
    clabe: 'format',
  });
  assert.deepEqual(
    checkAccount('co_bank_transfer', {
      holderName: 'Juan',
      details: {
        bank: 'Bancolombia',
        accountType: 'savings',
        accountNumber: '12345',
        documentType: 'CC',
        documentNumber: '1020304050',
      },
    }),
    { accountNumber: 'format' },
    'six digits at least in Colombia',
  );
  assert.deepEqual(
    checkAccount('pe_bank_transfer', {
      holderName: 'Rosa',
      details: { cci: '00219300123456789012', documentType: 'DNI', documentNumber: '46779354' },
    }),
    {},
  );
  assert.deepEqual(
    checkAccount('pe_bank_transfer', {
      holderName: 'Rosa',
      details: { cci: '00219300123456789012', documentType: 'XX', documentNumber: '4' },
    }),
    { documentType: 'format', documentNumber: 'format' },
  );
  assert.deepEqual(
    checkAccount('cl_bank_transfer', {
      holderName: 'Pedro',
      details: {
        bank: 'Banco Estado',
        accountType: 'vista',
        accountNumber: '12345678',
        rut: '12345678-5',
      },
    }),
    {},
  );
  assert.deepEqual(checkAccount('unknown_rail', { holderName: 'Pedro', details: { iban: '' } }), {
    iban: 'required',
  });
});

test("a beneficiary also carries a document, the rail's own when it keeps one", () => {
  assert.equal(documentOf('ar_bank_transfer', { cuit: '20329642330' }), '20329642330');
  assert.equal(documentOf('br_pix', { keyType: 'cpf', key: '529.982.247-25' }), '52998224725');
  assert.equal(documentOf('br_pix', { keyType: 'email', key: 'a@b.co' }), '');
  assert.deepEqual(
    checkBeneficiary('ar_bank_transfer', {
      holderName: 'Ana',
      details: { alias: 'ana.gomez.mp', cuit: '20329642330' },
    }),
    {},
  );
  assert.deepEqual(
    checkBeneficiary('mx_spei', { holderName: 'María', details: { clabe: '002010077777777771' } }),
    { document: 'required' },
  );
  assert.deepEqual(
    checkBeneficiary('mx_spei', {
      holderName: 'María',
      document: 'GODE561231GR8',
      details: { clabe: '002010077777777771' },
    }),
    {},
  );
  assert.deepEqual(
    checkBeneficiary('mx_spei', {
      holderName: 'María',
      document: 'x',
      details: { clabe: '002010077777777771' },
    }),
    { document: 'format' },
  );
});

test('details are kept trimmed, known keys only, account numbers without separators', () => {
  assert.deepEqual(
    normalizeDetails('ar_bank_transfer', {
      cbu: ' 0170 0992 2200 0001 2345 61 ',
      alias: ' ANA.GOMEZ ',
      extra: 'x',
    }),
    { cbu: '0170099222000001234561', alias: 'ana.gomez' },
  );
  assert.deepEqual(normalizeDetails('unknown', { a: ' 1 ', b: '' }), { a: '1' });
});

test("the payer's document follows the currency", () => {
  assert.equal(checkPayerDocument('ARS', '32964233'), null, 'a DNI');
  assert.equal(checkPayerDocument('ARS', '20329642330'), null, 'a CUIL');
  assert.equal(checkPayerDocument('ARS', '20329642331'), 'checksum');
  assert.equal(checkPayerDocument('BRL', '52998224725'), null);
  assert.equal(checkPayerDocument('MXN', 'GODE561231HDFRRN09'), null);
  assert.equal(checkPayerDocument('CLP', '12345678-5'), null);
  assert.equal(checkPayerDocument('PEN', '46779354'), null);
  assert.equal(checkPayerDocument('USD', 'AB1234'), null);
  assert.equal(checkPayerDocument('ARS', ''), 'required');
  assert.equal(checkEmail('ana@example.com'), null);
  assert.equal(checkEmail('ana@'), 'format');
  assert.equal(checkHolderName('12345'), 'format', 'a name has letters');
  assert.equal(checkHolderName('Ana'), null);
});

test('the QR rails: ARS and BRL, never an account, kept out of account pickers', () => {
  assert.deepEqual([RAILS.ar_qr.currency, RAILS.br_pix_qr.currency], ['ARS', 'BRL']);
  assert.ok(isQrRailId('ar_qr') && isQrRailId('br_pix_qr'));
  assert.ok(!isQrRailId('ar_bank_transfer') && !isQrRailId('br_pix') && !isQrRailId('nope'));
  assert.deepEqual(accountRails(['ar_bank_transfer', 'ar_qr', 'br_pix_qr', 'br_pix']), [
    'ar_bank_transfer',
    'br_pix',
  ]);
});

test('Bolivia: a bank account with the holder CI or NIT, kept as the API keeps it', () => {
  const details = {
    bank: 'Banco Unión',
    accountType: 'savings',
    accountNumber: '1000-0234-5678',
    documentType: 'CI',
    documentNumber: '6543210-1a',
  };
  assert.deepEqual(
    railsFor('BOB').map((r) => r.id),
    ['bo_bank_transfer'],
  );
  assert.deepEqual(checkAccount('bo_bank_transfer', { holderName: 'Ana Quispe', details }), {});
  assert.deepEqual(normalizeDetails('bo_bank_transfer', details), {
    ...details,
    accountNumber: '100002345678',
    documentNumber: '65432101A',
  });
  assert.equal(documentOf('bo_bank_transfer', details), '6543210-1a');
  const bad = checkAccount('bo_bank_transfer', {
    holderName: 'Ana Quispe',
    details: { ...details, accountType: 'vista', accountNumber: '123', documentType: 'DNI' },
  });
  assert.deepEqual(Object.keys(bad).sort(), ['accountNumber', 'accountType', 'documentType']);
  assert.equal(
    checkAccount('bo_bank_transfer', {
      holderName: 'Ana Quispe',
      details: { ...details, documentNumber: '12/34' },
    }).documentNumber,
    'format',
  );
});

test('Bolivia: a CI (with its complement or department) or a NIT pays', () => {
  for (const ok of ['6543210', '6543210-1A', '6543210 LP', '1020304025', '1023456789012'])
    assert.equal(checkCiNit(ok), null, ok);
  for (const bad of ['1234', '12345678901234', 'ABC1234', '6543210-ABC'])
    assert.equal(checkCiNit(bad), 'format', bad);
  assert.equal(checkPayerDocument('BOB', '6543210 LP'), null);
  assert.equal(checkPayerDocument('BOB', 'GODE561231GR8'), 'format');
});

test('the boliviano is preselected wherever the market lists it', () => {
  assert.equal(HOME_CURRENCY, 'BOB');
  assert.equal(defaultCurrency([{ code: 'ARS' }, { code: 'BOB' }]), 'BOB');
  assert.equal(defaultCurrency([{ code: 'ARS' }, { code: 'BRL' }]), 'ARS');
  assert.equal(defaultCurrency([]), '');
});

test("a third party's ID: optional where the rail's transfers do not need it, checked when given", () => {
  for (const r of ['ar_bank_transfer', 'pe_bank_transfer', 'bo_bank_transfer', 'br_pix', 'mx_spei'])
    assert.ok(idOptional(r), r);
  for (const r of ['cl_bank_transfer', 'co_bank_transfer', 'nope']) assert.ok(!idOptional(r), r);
  // An Argentine CVU with only the holder's name: refused as one's own account, fine for someone else.
  const cvu = { holderName: 'Martín Gómez', details: { cbu: '0000003100012345678907' } };
  assert.deepEqual(Object.keys(checkBeneficiary('ar_bank_transfer', cvu)).sort(), [
    'cuit',
    'document',
  ]);
  assert.deepEqual(checkBeneficiary('ar_bank_transfer', cvu, { idOptional: true }), {});
  // Given anyway, it is still checked.
  assert.equal(
    checkBeneficiary(
      'ar_bank_transfer',
      { ...cvu, details: { ...cvu.details, cuit: '20329642331' } },
      { idOptional: true },
    ).cuit,
    'checksum',
  );
  // A CCI without the document type and number the form no longer shows.
  const cci = { cci: '00219300123456789012', documentType: 'DNI', documentNumber: '' };
  assert.deepEqual(withoutId('pe_bank_transfer', cci), { cci: '00219300123456789012' });
  assert.deepEqual(
    checkBeneficiary(
      'pe_bank_transfer',
      { holderName: 'Rosa Quispe', details: withoutId('pe_bank_transfer', cci) },
      { idOptional: true },
    ),
    {},
  );
  // Chile still needs the RUT, even of someone else.
  const rut = checkBeneficiary(
    'cl_bank_transfer',
    {
      holderName: 'Ana Soto',
      details: { bank: 'Banco Estado', accountType: 'checking', accountNumber: '12345678' },
    },
    { idOptional: true },
  );
  assert.equal(rut.rut, 'required');
  assert.equal(rut.document, 'required');
});

test('one field for a CBU, a CVU or an alias: what is typed goes to its own detail', () => {
  const members = RAILS.ar_bank_transfer.fields.filter((f) => f.oneOf === 'account');
  assert.equal(oneOfKey(members, '0000003100012345678907'), 'cbu');
  assert.equal(oneOfKey(members, '0000 0031 0001-2345.678907'), 'cbu', 'spaced or dotted digits');
  assert.equal(oneOfKey(members, '00000031'), 'cbu', 'digits still being typed');
  assert.equal(oneOfKey(members, 'ana.gomez.mp'), 'alias');
  assert.equal(oneOfKey(members, 'ana2024'), 'alias', 'letters and digits: an alias');
  assert.equal(oneOfKey(members, ''), 'alias', 'nothing typed');
});
