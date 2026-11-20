/* admin.test.ts: the rules behind the dashboard's charges, payouts, webhooks and team views
   (src/features/dashboard/views/admin-model.ts). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  batchProgress,
  chargeFigures,
  CHARGE_EXPIRIES,
  expiryIso,
  grantableRoles,
  isMemberAddress,
  isWebhookUrl,
  payoutFigures,
} from '@/features/dashboard/views/admin-model';
import type { P2pPayoutItem } from '@/lib/p2p/types';

test("a charge's expiry: the chosen span from now, or none", () => {
  const now = Date.parse('2026-11-19T12:00:00.000Z');
  assert.equal(expiryIso('1h', now), '2026-11-19T13:00:00.000Z');
  assert.equal(expiryIso('24h', now), '2026-11-20T12:00:00.000Z');
  assert.equal(expiryIso('7d', now), '2026-11-26T12:00:00.000Z');
  assert.equal(expiryIso('30d', now), '2026-12-19T12:00:00.000Z');
  assert.equal(expiryIso('never', now), undefined, 'the field is left out');
  assert.deepEqual([...CHARGE_EXPIRIES], ['1h', '24h', '7d', '30d', 'never']);
});

test('charge figures: open, paid, open and reusable, expired', () => {
  assert.deepEqual(
    chargeFigures([
      { status: 'open', multiUse: false },
      { status: 'open', multiUse: true },
      { status: 'paid', multiUse: true },
      { status: 'expired', multiUse: false },
      { status: 'cancelled', multiUse: false },
    ]),
    { open: 2, paid: 1, reusable: 1, expired: 1 },
  );
});

const item = (status: P2pPayoutItem['status']): P2pPayoutItem => ({
  index: 0,
  orderId: 'o',
  status,
  currency: 'ARS',
  fiatAmount: '1',
  rail: 'ar_bank_transfer',
  beneficiaryName: 'Ana',
  externalReference: null,
});

test("a payout batch's progress and the figures over batches", () => {
  const b = {
    items: [
      item('completed'),
      item('paid'),
      item('paid'),
      item('rejected'),
      item('awaiting_payment'),
    ],
    itemCount: 5,
  };
  assert.deepEqual(batchProgress(b), { done: 1, total: 5, toRelease: 2, rejected: 1 });
  assert.equal(
    batchProgress({ items: [], itemCount: 3 }).total,
    3,
    'a list answer without its orders keeps its size',
  );
  assert.deepEqual(payoutFigures([b, { items: [item('resolved')], itemCount: 1 }]), {
    batches: 2,
    items: 6,
    completed: 2,
    toRelease: 2,
  });
});

test('a webhook URL is https with a host and no credentials', () => {
  assert.ok(isWebhookUrl('https://bot.example/hooks/pedospe'));
  assert.ok(isWebhookUrl(' https://bot.example:8443/x?y=1 '));
  for (const bad of [
    'http://bot.example/hooks',
    'ftp://x',
    'https://user:pass@bot.example/',
    'bot.example',
    '',
    `https://x/${'a'.repeat(2050)}`,
  ])
    assert.equal(isWebhookUrl(bad), false, bad);
});

test('a member address is a Stellar account, written exactly', () => {
  const g = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
  assert.ok(isMemberAddress(g));
  assert.ok(isMemberAddress(` ${g} `), 'surrounding spaces are ignored');
  assert.ok(!isMemberAddress(g.toLowerCase()), 'a StrKey keeps its case');
  assert.ok(!isMemberAddress(`${g.slice(0, -1)}A`), 'a bad checksum');
  assert.ok(
    !isMemberAddress('CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE'),
    'a contract signs nothing in',
  );
  assert.ok(!isMemberAddress('0xde3000000000000000000000000000000000a11e'), 'not an EVM address');
});

test('only an owner names another owner; members grant nothing', () => {
  assert.deepEqual(grantableRoles('owner'), ['owner', 'admin', 'member']);
  assert.deepEqual(grantableRoles('admin'), ['admin', 'member']);
  assert.deepEqual(grantableRoles('member'), []);
});
