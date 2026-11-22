import { describe, expect, it } from 'vitest';
import {
  isDocumentNumber,
  isPersonName,
  isValidCbu,
  isValidCbuAlias,
  isValidClabe,
  isValidCnpj,
  isValidCpf,
  isValidCuit,
  isValidRut,
  P2P_RAIL_IDS,
  P2P_RAILS,
  railsFor,
  validateRailDetails,
} from '@/p2p/domain/rails';

/** Flips one digit, so a valid number's checksum stops matching. */
function bump(value: string, index: number): string {
  const d = (Number(value[index]) + 1) % 10;
  return value.slice(0, index) + d + value.slice(index + 1);
}

describe('P2P rails: checksums', () => {
  it('checks both blocks of a CBU / CVU', () => {
    // Bank 285, branch 0590: the widely published example, both checks hold.
    expect(isValidCbu('2850590940090418135201')).toBe(true);
    expect(isValidCbu(bump('2850590940090418135201', 7))).toBe(false);
    expect(isValidCbu(bump('2850590940090418135201', 21))).toBe(false);
    expect(isValidCbu(bump('2850590940090418135201', 12))).toBe(false);
    expect(isValidCbu('285059094009041813520')).toBe(false);
    expect(isValidCbu('285059094009041813520a')).toBe(false);
  });

  it('takes an alias of 6 to 20 lowercase letters, digits, dots and hyphens', () => {
    expect(isValidCbuAlias('mi.alias-123')).toBe(true);
    expect(isValidCbuAlias('corto')).toBe(false);
    expect(isValidCbuAlias('Mayusculas.no')).toBe(false);
    expect(isValidCbuAlias('a'.repeat(21))).toBe(false);
  });

  it('checks a CUIT / CUIL', () => {
    expect(isValidCuit('20123456786')).toBe(true);
    expect(isValidCuit('20123456785')).toBe(false);
    expect(isValidCuit('2012345678')).toBe(false);
  });

  it('checks a CPF and a CNPJ, and refuses repeated digits', () => {
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('52998224726')).toBe(false);
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(isValidCnpj('11222333000182')).toBe(false);
    expect(isValidCnpj('00000000000000')).toBe(false);
  });

  it('checks a CLABE', () => {
    expect(isValidClabe('002010077777777771')).toBe(true);
    expect(isValidClabe('002010077777777772')).toBe(false);
    expect(isValidClabe(bump('002010077777777771', 3))).toBe(false);
  });

  it('checks a RUT, K included, with or without dots', () => {
    expect(isValidRut('12345678-5')).toBe(true);
    expect(isValidRut('12.345.678-5')).toBe(true);
    expect(isValidRut('12345678-4')).toBe(false);
    // 10.000.013-K: the check digit is K.
    expect(isValidRut('10000013-K')).toBe(true);
    expect(isValidRut('10000013-k')).toBe(true);
  });

  it('takes names and document numbers in the shapes people give them', () => {
    expect(isPersonName('María José Pérez')).toBe(true);
    expect(isPersonName("O'Brien")).toBe(true);
    expect(isPersonName('1abc')).toBe(false);
    expect(isPersonName('x')).toBe(false);
    expect(isDocumentNumber('20.123.456')).toBe(true);
    expect(isDocumentNumber('a b')).toBe(false);
  });
});

describe('P2P rails: details', () => {
  it('has one rail per id, each paying in a currency it lists; only QR rails take no fields', () => {
    for (const id of P2P_RAIL_IDS) {
      expect(railsFor(P2P_RAILS[id].currency)).toContain(id);
      expect(P2P_RAILS[id].fields.length > 0).toBe(!P2P_RAILS[id].qr);
    }
  });

  it('takes a CBU or an alias (never both) and a valid CUIT in Argentina', () => {
    expect(
      validateRailDetails('ar_bank_transfer', 'ARS', {
        cbu: '2850590940090418135201',
        cuit: '20-12345678-6',
      }),
    ).toEqual({
      ok: true,
      details: { cbu: '2850590940090418135201', cuit: '20123456786' },
    });
    expect(
      validateRailDetails('ar_bank_transfer', 'ARS', {
        alias: 'Mi.Alias',
        cuit: '20123456786',
      }),
    ).toEqual({
      ok: true,
      details: { alias: 'mi.alias', cuit: '20123456786' },
    });
    const both = validateRailDetails('ar_bank_transfer', 'ARS', {
      cbu: '2850590940090418135201',
      alias: 'mi.alias',
      cuit: '20123456786',
    });
    expect(both.ok).toBe(false);
    const bad = validateRailDetails('ar_bank_transfer', 'ARS', {
      cbu: '2850590940090418135202',
      cuit: '20123456785',
    });
    expect(bad).toEqual({
      ok: false,
      errors: [
        'details.cbu is not a valid CBU or CVU (22 digits with check digits)',
        'details.cuit is not a valid CUIT or CUIL',
      ],
    });
  });

  it('checks a PIX key by its type', () => {
    expect(
      validateRailDetails('br_pix', 'BRL', {
        keyType: 'cpf',
        key: '529.982.247-25',
      }),
    ).toEqual({ ok: true, details: { keyType: 'cpf', key: '52998224725' } });
    expect(
      validateRailDetails('br_pix', 'BRL', {
        keyType: 'phone',
        key: '+55 (11) 91234-5678',
      }),
    ).toEqual({
      ok: true,
      details: { keyType: 'phone', key: '+5511912345678' },
    });
    expect(
      validateRailDetails('br_pix', 'BRL', {
        keyType: 'evp',
        key: '123E4567-E89B-12D3-A456-426614174000',
      }).ok,
    ).toBe(true);
    expect(validateRailDetails('br_pix', 'BRL', { keyType: 'email', key: 'no-at' }).ok).toBe(false);
    expect(validateRailDetails('br_pix', 'BRL', { keyType: 'iban', key: 'x' }).ok).toBe(false);
  });

  it('refuses another currency, unknown fields and non-objects', () => {
    expect(validateRailDetails('mx_spei', 'ARS', { clabe: '002010077777777771' })).toEqual({
      ok: false,
      errors: ['rail mx_spei pays in MXN, not ARS'],
    });
    expect(
      validateRailDetails('mx_spei', 'MXN', {
        clabe: '002010077777777771',
        extra: 'x',
      }),
    ).toEqual({
      ok: false,
      errors: ['details.extra is not a field of this rail'],
    });
    expect(validateRailDetails('mx_spei', 'MXN', 'clabe').ok).toBe(false);
    expect(validateRailDetails('mx_spei', 'MXN', null).ok).toBe(false);
  });

  it('checks the Colombian, Peruvian and Chilean bank transfers', () => {
    expect(
      validateRailDetails('co_bank_transfer', 'COP', {
        bank: 'Bancolombia',
        accountType: 'savings',
        accountNumber: '123-456789',
        documentType: 'CC',
        documentNumber: '1020304050',
      }),
    ).toEqual({
      ok: true,
      details: {
        bank: 'Bancolombia',
        accountType: 'savings',
        accountNumber: '123456789',
        documentType: 'CC',
        documentNumber: '1020304050',
      },
    });
    expect(
      validateRailDetails('pe_bank_transfer', 'PEN', {
        cci: '0021 9100 1234 5678 9012',
        documentType: 'DNI',
        documentNumber: '12345678',
      }).ok,
    ).toBe(true);
    expect(
      validateRailDetails('pe_bank_transfer', 'PEN', {
        cci: '123',
        documentType: 'DNI',
        documentNumber: '12345678',
      }).ok,
    ).toBe(false);
    expect(
      validateRailDetails('cl_bank_transfer', 'CLP', {
        bank: 'Banco de Chile',
        accountType: 'vista',
        accountNumber: '00123456',
        rut: '12.345.678-5',
      }),
    ).toEqual({
      ok: true,
      details: {
        bank: 'Banco de Chile',
        accountType: 'vista',
        accountNumber: '00123456',
        rut: '12345678-5',
      },
    });
  });

  it('masks what a summary shows', () => {
    expect(P2P_RAILS.ar_bank_transfer.summary({ cbu: '2850590940090418135201' })).toBe(
      'CBU ••••5201',
    );
    expect(P2P_RAILS.mx_spei.summary({ clabe: '002010077777777771' })).toBe('CLABE ••••7771');
  });
});

describe('P2P rails: the Bolivian bank transfer (bo_bank_transfer)', () => {
  const valid = {
    bank: 'Banco Unión',
    accountType: 'savings',
    accountNumber: '1000012345678',
    documentType: 'CI',
    documentNumber: '4567891',
  };
  const check = (details: Record<string, unknown>) =>
    validateRailDetails('bo_bank_transfer', 'BOB', details);
  const errorsOf = (details: Record<string, unknown>) => {
    const r = check(details);
    return r.ok ? [] : r.errors;
  };

  it('is the first rail, pays in BOB, and is the only BOB rail', () => {
    expect(P2P_RAIL_IDS[0]).toBe('bo_bank_transfer');
    expect(railsFor('BOB')).toEqual(['bo_bank_transfer']);
    const rail = P2P_RAILS.bo_bank_transfer;
    expect(rail).toMatchObject({ currency: 'BOB', name: 'Bank transfer' });
    expect(rail.qr).toBeUndefined();
    expect(rail.fields.map((f) => [f.name, f.required, f.options ?? null])).toEqual([
      ['bank', true, null],
      ['accountType', true, ['savings', 'checking']],
      ['accountNumber', true, null],
      ['documentType', true, ['CI', 'NIT', 'CE', 'PP']],
      ['documentNumber', true, null],
    ]);
  });

  it('takes valid details as they are', () => {
    expect(check(valid)).toEqual({ ok: true, details: valid });
    expect(
      check({
        ...valid,
        accountType: 'checking',
        documentType: 'NIT',
        documentNumber: '1023456789',
      }).ok,
    ).toBe(true);
  });

  it('drops spaces, dots and hyphens and uppercases the document (a CI with its complement)', () => {
    expect(
      check({
        bank: '  Banco Mercantil Santa Cruz ',
        accountType: 'checking',
        accountNumber: '401-012.345 6',
        documentType: 'CI',
        documentNumber: '1234567-1a',
      }),
    ).toEqual({
      ok: true,
      details: {
        bank: 'Banco Mercantil Santa Cruz',
        accountType: 'checking',
        accountNumber: '4010123456',
        documentType: 'CI',
        documentNumber: '12345671A',
      },
    });
    expect(check({ ...valid, documentNumber: '1234567-1A' })).toMatchObject({
      ok: true,
      details: { documentNumber: '12345671A' },
    });
    expect(check({ ...valid, documentNumber: '1.023.456.789' })).toMatchObject({
      ok: true,
      details: { documentNumber: '1023456789' },
    });
  });

  it('requires every field', () => {
    for (const name of Object.keys(valid)) {
      expect(errorsOf({ ...valid, [name]: undefined }), name).toEqual([
        `details.${name} is required`,
      ]);
      expect(errorsOf({ ...valid, [name]: '' }), name).toEqual([`details.${name} is required`]);
    }
  });

  it('refuses a bank that is not a name', () => {
    expect(errorsOf({ ...valid, bank: 'B' })).toEqual(['details.bank must be a bank name']);
    expect(errorsOf({ ...valid, bank: 'Banco <script>' })).toEqual([
      'details.bank must be a bank name',
    ]);
  });

  it('refuses an account type or a document type it does not list', () => {
    expect(errorsOf({ ...valid, accountType: 'vista' })).toEqual([
      'details.accountType must be one of savings, checking',
      'details.accountType is required',
    ]);
    for (const documentType of ['DNI', 'ci']) {
      expect(errorsOf({ ...valid, documentType }), documentType).toEqual([
        'details.documentType must be one of CI, NIT, CE, PP',
        'details.documentType is required',
      ]);
    }
  });

  it('takes an account number of 6 to 20 digits only', () => {
    expect(check({ ...valid, accountNumber: '123456' }).ok).toBe(true);
    expect(check({ ...valid, accountNumber: '1'.repeat(20) }).ok).toBe(true);
    for (const accountNumber of ['12345', '1'.repeat(21), '12345A789', '1234/5678']) {
      expect(errorsOf({ ...valid, accountNumber }), accountNumber).toEqual([
        'details.accountNumber must be 6 to 20 digits',
      ]);
    }
  });

  it('takes a document number of 5 to 15 letters or digits only', () => {
    expect(check({ ...valid, documentNumber: '12345' }).ok).toBe(true);
    expect(check({ ...valid, documentNumber: 'A'.repeat(15) }).ok).toBe(true);
    for (const documentNumber of ['1234', 'A'.repeat(16), '1234567/1A', '12345_67', 'Ñ12345']) {
      expect(errorsOf({ ...valid, documentNumber }), documentNumber).toEqual([
        'details.documentNumber must be 5 to 15 letters or digits',
      ]);
    }
  });

  it('refuses another currency and fields it does not declare', () => {
    expect(validateRailDetails('bo_bank_transfer', 'ARS', valid)).toEqual({
      ok: false,
      errors: ['rail bo_bank_transfer pays in BOB, not ARS'],
    });
    expect(errorsOf({ ...valid, cbu: '2850590940090418135201' })).toEqual([
      'details.cbu is not a field of this rail',
    ]);
  });

  it('summarises with the bank and the masked account', () => {
    expect(P2P_RAILS.bo_bank_transfer.summary({ ...valid, accountNumber: '4010123456' })).toBe(
      'Banco Unión ••••3456',
    );
  });
});

describe('pe_wallet (Yape or Plin)', () => {
  it('takes a wallet and a 9-digit mobile number starting with 9, without +51', () => {
    const r = validateRailDetails('pe_wallet', 'PEN', { wallet: 'yape', phone: '+51 987 654 321' });
    expect(r).toEqual({ ok: true, details: { wallet: 'yape', phone: '987654321' } });
    expect(P2P_RAILS.pe_wallet.summary({ wallet: 'plin', phone: '987654321' })).toBe(
      'Plin ••••4321',
    );
  });

  it('refuses another wallet or a number that is not a Peruvian mobile', () => {
    expect(
      validateRailDetails('pe_wallet', 'PEN', { wallet: 'tunki', phone: '987654321' }).ok,
    ).toBe(false);
    expect(validateRailDetails('pe_wallet', 'PEN', { wallet: 'yape', phone: '887654321' }).ok).toBe(
      false,
    );
    expect(validateRailDetails('pe_wallet', 'PEN', { wallet: 'yape' }).ok).toBe(false);
  });
});
