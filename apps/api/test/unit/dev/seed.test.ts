import { describe, expect, it } from 'vitest';
import {
  SEEDED_MERCHANT_METHODS,
  seededDollarTarget,
  seededOffers,
  userDollarTarget,
} from '@/dev/seed';
import { isP2pRailId, P2P_RAILS, validateRailDetails } from '@/p2p/domain/rails';

const U = 10_000_000n;

describe('the seeded merchant', () => {
  it('collects in bolivianos first, then pesos and reais, with details every rail accepts', () => {
    expect(SEEDED_MERCHANT_METHODS.map((m) => `${m.currency} ${m.rail}`)).toEqual([
      'BOB bo_bank_transfer',
      'ARS ar_bank_transfer',
      'BRL br_pix',
    ]);
    for (const m of SEEDED_MERCHANT_METHODS) {
      expect(isP2pRailId(m.rail)).toBe(true);
      if (!isP2pRailId(m.rail)) continue;
      expect(validateRailDetails(m.rail, m.currency, m.details), m.rail).toMatchObject({
        ok: true,
      });
    }
  });

  it('publishes its offers in the dollar and XLM only, bolivianos first', () => {
    const offers = seededOffers(['USDC', 'XLM']);
    expect(new Set(offers.map((o) => o.token))).toEqual(new Set(['USDC', 'XLM']));
    expect(offers.filter((o) => o.token === 'USDC')).toHaveLength(8);
    expect(offers[0]).toMatchObject({
      side: 'SELL_TOKEN',
      token: 'USDC',
      currency: 'BOB',
      rails: ['bo_bank_transfer'],
      price: '12.1',
    });
    for (const o of offers) {
      for (const rail of o.rails) {
        expect(isP2pRailId(rail) && P2P_RAILS[rail].currency).toBe(o.currency);
        // A QR rail only serves BUY_TOKEN offers.
        if (isP2pRailId(rail) && P2P_RAILS[rail].qr) expect(o.side).toBe('BUY_TOKEN');
      }
    }
  });

  it('keeps the dollar prices the chain test pins (12 500 ARS buys 10 tokens)', () => {
    const ars = seededOffers(['USDC']).find((o) => o.side === 'SELL_TOKEN' && o.currency === 'ARS');
    expect(ars).toMatchObject({ price: '1250', minFiat: '1000', maxFiat: '2000000' });
  });

  it('prices XLM from the dollar prices at a rough lumen price, up to a fifth of the maximum', () => {
    const bob = seededOffers(['XLM']).find((o) => o.side === 'SELL_TOKEN' && o.currency === 'BOB');
    expect(bob).toMatchObject({ price: '1.573', minFiat: '10', maxFiat: '4000.00' });
  });

  it('aims at 5 000 USDC (testnet) or 100 000 TUSD (local), and the user at 1 000 / 5 000', () => {
    expect(seededDollarTarget({ source: 'dex' })).toBe(5_000n * U);
    expect(seededDollarTarget({ source: 'mint' })).toBe(100_000n * U);
    expect(userDollarTarget({ source: 'dex' })).toBe(1_000n * U);
    expect(userDollarTarget({ source: 'mint' })).toBe(5_000n * U);
  });
});
