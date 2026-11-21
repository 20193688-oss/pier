import { describe, expect, it } from 'vitest';
import { ApiError } from '@/common/api-error';
import {
  P2P_RAIL_IDS,
  P2P_RAILS,
  beneficiaryRequires,
  validateRailDetails,
  type P2pRailId,
} from '@/p2p/domain/rails';
import { OrdersService } from '@/p2p/orders.service';

/**
 * An order's beneficiary (a sale's, a payout's: possibly someone else's
 * account) may leave out the holder's ID on every rail whose transfer system
 * does not need it; Chile and Colombia need it. A merchant's own payment
 * method keeps every required field.
 */

const AS_BENEFICIARY = { beneficiary: true };
const errorsOf = (rail: P2pRailId, currency: string, details: object, beneficiary = true) => {
  const r = validateRailDetails(rail, currency, details, { beneficiary });
  return r.ok ? [] : r.errors;
};

const BO = { bank: 'Banco Unión', accountType: 'savings', accountNumber: '1000012345678' };
const AR = { cbu: '2850590940090418135201' };
const PE = { cci: '00219300123456789012' };

describe('a beneficiary’s ID, rail by rail', () => {
  it('flags only Chile and Colombia as needing the holder’s ID', () => {
    const needed = P2P_RAIL_IDS.filter((id) => P2P_RAILS[id].beneficiaryIdRequired);
    expect(needed.sort()).toEqual(['cl_bank_transfer', 'co_bank_transfer']);
    expect(P2P_RAILS.bo_bank_transfer.holderId).toEqual(['documentType', 'documentNumber']);
    expect(P2P_RAILS.ar_bank_transfer.holderId).toEqual(['cuit']);
    expect(P2P_RAILS.pe_bank_transfer.holderId).toEqual(['documentType', 'documentNumber']);
    expect(P2P_RAILS.cl_bank_transfer.holderId).toEqual(['rut']);
    expect(P2P_RAILS.br_pix.holderId).toEqual([]);
    expect(P2P_RAILS.mx_spei.holderId).toEqual([]);
  });

  it('Bolivia: the document type and number may be left out, but come together', () => {
    expect(validateRailDetails('bo_bank_transfer', 'BOB', BO, AS_BENEFICIARY)).toEqual({
      ok: true,
      details: BO,
    });
    expect(errorsOf('bo_bank_transfer', 'BOB', { ...BO, documentType: 'CI' })).toEqual([
      'details.documentNumber is required with documentType',
    ]);
    expect(errorsOf('bo_bank_transfer', 'BOB', { ...BO, documentNumber: '4567891' })).toEqual([
      'details.documentType is required with documentNumber',
    ]);
    // Given, it is checked (and normalised) as always.
    expect(
      validateRailDetails(
        'bo_bank_transfer',
        'BOB',
        { ...BO, documentType: 'CI', documentNumber: '1234567-1a' },
        AS_BENEFICIARY,
      ),
    ).toMatchObject({ ok: true, details: { documentNumber: '12345671A' } });
    expect(
      errorsOf('bo_bank_transfer', 'BOB', { ...BO, documentType: 'CI', documentNumber: '1234' }),
    ).toEqual(['details.documentNumber must be 5 to 15 letters or digits']);
    // The account itself is still required.
    expect(errorsOf('bo_bank_transfer', 'BOB', { bank: 'Banco Unión' })).toEqual([
      'details.accountType is required',
      'details.accountNumber is required',
    ]);
  });

  it('Argentina: the CUIT may be left out; the CBU or the alias may not', () => {
    expect(validateRailDetails('ar_bank_transfer', 'ARS', AR, AS_BENEFICIARY)).toEqual({
      ok: true,
      details: AR,
    });
    expect(
      validateRailDetails('ar_bank_transfer', 'ARS', { alias: 'Mi.Alias' }, AS_BENEFICIARY),
    ).toEqual({ ok: true, details: { alias: 'mi.alias' } });
    expect(errorsOf('ar_bank_transfer', 'ARS', { ...AR, cuit: '20123456785' })).toEqual([
      'details.cuit is not a valid CUIT or CUIL',
    ]);
    expect(errorsOf('ar_bank_transfer', 'ARS', {})).toEqual([
      'details: give exactly one of cbu or alias',
    ]);
  });

  it('Peru: the document may be left out, but come whole; the CCI may not', () => {
    expect(validateRailDetails('pe_bank_transfer', 'PEN', PE, AS_BENEFICIARY)).toEqual({
      ok: true,
      details: PE,
    });
    expect(errorsOf('pe_bank_transfer', 'PEN', { ...PE, documentType: 'DNI' })).toEqual([
      'details.documentNumber is required with documentType',
    ]);
    expect(
      errorsOf('pe_bank_transfer', 'PEN', { ...PE, documentType: 'DNI', documentNumber: '1' }),
    ).toEqual(['details.documentNumber must be 5 to 15 letters or digits']);
    expect(
      errorsOf('pe_bank_transfer', 'PEN', { documentType: 'DNI', documentNumber: '12345678' }),
    ).toEqual(['details.cci is required']);
  });

  it('PIX and SPEI never asked for one', () => {
    expect(errorsOf('br_pix', 'BRL', { keyType: 'email', key: 'ana@example.com' })).toEqual([]);
    expect(errorsOf('mx_spei', 'MXN', { clabe: '002010077777777771' })).toEqual([]);
  });

  it('Chile and Colombia still need it, as a beneficiary too', () => {
    expect(
      errorsOf('cl_bank_transfer', 'CLP', {
        bank: 'Banco de Chile',
        accountType: 'vista',
        accountNumber: '00123456',
      }),
    ).toEqual(['details.rut is required']);
    expect(
      errorsOf('co_bank_transfer', 'COP', {
        bank: 'Bancolombia',
        accountType: 'savings',
        accountNumber: '123456789',
      }),
    ).toEqual(['details.documentType is required', 'details.documentNumber is required']);
  });

  it('keeps every required field on a merchant’s own payment method', () => {
    expect(errorsOf('bo_bank_transfer', 'BOB', BO, false)).toEqual([
      'details.documentType is required',
      'details.documentNumber is required',
    ]);
    expect(errorsOf('ar_bank_transfer', 'ARS', AR, false)).toEqual(['details.cuit is required']);
    expect(errorsOf('pe_bank_transfer', 'PEN', PE, false)).toEqual([
      'details.documentType is required',
      'details.documentNumber is required',
    ]);
  });

  it('says which fields a beneficiary must give (published on the market)', () => {
    const required = (id: P2pRailId) =>
      P2P_RAILS[id].fields.filter((f) => beneficiaryRequires(id, f)).map((f) => f.name);
    expect(required('bo_bank_transfer')).toEqual(['bank', 'accountType', 'accountNumber']);
    expect(required('ar_bank_transfer')).toEqual([]);
    expect(required('pe_bank_transfer')).toEqual(['cci']);
    expect(required('cl_bank_transfer')).toEqual(['bank', 'accountType', 'accountNumber', 'rut']);
    expect(required('co_bank_transfer')).toEqual([
      'bank',
      'accountType',
      'accountNumber',
      'documentType',
      'documentNumber',
    ]);
  });
});

describe('OrdersService.checkBeneficiary', () => {
  // The beneficiary check reads nothing but its arguments.
  const orders = new OrdersService(
    ...(Array.from({ length: 9 }, () => null) as unknown as ConstructorParameters<
      typeof OrdersService
    >),
  );
  const refused = (fn: () => unknown): string[] => {
    try {
      fn();
    } catch (err) {
      if (err instanceof ApiError) return err.details ?? [];
      throw err;
    }
    throw new Error('not refused');
  };

  it('takes a third party’s account with no ID where the rail does not need one', () => {
    expect(
      orders.checkBeneficiary(
        { holderName: 'Rosa Quispe', details: PE },
        'pe_bank_transfer',
        'PEN',
      ),
    ).toEqual({ holderName: 'Rosa Quispe', document: null, rail: 'pe_bank_transfer', details: PE });
    expect(
      orders.checkBeneficiary(
        { holderName: 'Rosa Quispe', document: '  ', details: BO },
        'bo_bank_transfer',
        'BOB',
      ).document,
    ).toBeNull();
    expect(
      orders.checkBeneficiary(
        { holderName: 'Ana López', document: ' 27234567891 ', details: AR },
        'ar_bank_transfer',
        'ARS',
      ).document,
    ).toBe('27234567891');
  });

  it('checks an ID that is given, and wants one in Chile and Colombia', () => {
    expect(
      refused(() =>
        orders.checkBeneficiary(
          { holderName: 'Rosa Quispe', document: 'a b', details: PE },
          'pe_bank_transfer',
          'PEN',
        ),
      ),
    ).toEqual(['beneficiary.document must be 4 to 20 letters, digits, dots or hyphens']);
    expect(
      refused(() =>
        orders.checkBeneficiary(
          {
            holderName: 'Ana Soto',
            details: { bank: 'Banco de Chile', accountType: 'vista', accountNumber: '00123456' },
          },
          'cl_bank_transfer',
          'CLP',
        ),
      ),
    ).toEqual([
      'beneficiary.document is required: cl_bank_transfer transfers need the holder’s ID',
      'beneficiary.details.rut is required',
    ]);
  });
});
