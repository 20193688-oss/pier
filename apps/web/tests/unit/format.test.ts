/* format.test.ts: money, token amounts, rates, durations and addresses in the reader's language
   (src/lib/format.ts), and the catalogs' placeholder filler (src/i18n/format.ts). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  ago,
  amountOnly,
  currencyName,
  duration,
  money,
  NBSP,
  percent,
  plainAmount,
  rate,
  shortAddress,
  units,
} from '@/lib/format';
import { fmt } from '@/i18n/format';

const WORDS = {
  seconds: '{n} s',
  minutes: '{n} min',
  hours: '{n} h',
  days: '{n} d',
  justNow: 'just now',
  ago: '{time} ago',
};

test('local money keeps its currency decimals, in the reader language', () => {
  assert.equal(money('es', '150000', 'ARS'), `150.000,00${NBSP}ARS`);
  assert.equal(money('en', 150000, 'ARS'), `150,000.00${NBSP}ARS`);
  assert.equal(money('es', '9510', 'CLP'), `9510${NBSP}CLP`, 'Chilean pesos have no decimals');
  assert.equal(
    amountOnly('en', 'abc', 'ARS'),
    'abc',
    'a value that is not a number is shown as it is',
  );
  assert.equal(plainAmount('150000', 'ARS'), '150000.00', 'what a person types into a bank app');
  assert.equal(plainAmount('9510', 'CLP'), '9510');
});

test('token amounts: two decimals from 1 up, up to six below', () => {
  assert.equal(units('en', '100.4712', 'USDC'), `100.47${NBSP}USDC`);
  assert.equal(units('es', '0.302317', 'USDC'), `0,302317${NBSP}USDC`);
  assert.equal(rate('es', '1488.5'), '1488,5');
  assert.equal(rate('en', '5.4712'), '5.4712');
  assert.equal(percent('en', 0.992), '99.2%');
});

test('durations, ago and addresses', () => {
  assert.equal(duration(42, WORDS), '42 s');
  assert.equal(duration(140, WORDS), '2 min');
  assert.equal(duration(7200, WORDS), '2 h');
  assert.equal(duration(3 * 86400, WORDS), '3 d');
  const now = Date.parse('2026-11-19T12:00:00Z');
  assert.equal(ago('2026-11-19T11:59:30Z', WORDS, now), 'just now');
  assert.equal(ago('2026-11-19T11:55:00Z', WORDS, now), '5 min ago');
  assert.equal(ago('nope', WORDS, now), '');
  assert.equal(shortAddress('0xde3000000000000000000000000000000000a11e'), '0xde30…a11e');
  assert.equal(shortAddress('0x12'), '0x12');
  assert.ok(['argentine peso', 'ars'].includes(currencyName('ARS', 'en').toLowerCase()));
});

test('placeholders are filled by name; unknown ones stay', () => {
  assert.equal(fmt('Pay within {time}', { time: '29:54' }), 'Pay within 29:54');
  assert.equal(fmt('{a} and {b}', { a: 1 }), '1 and {b}');
  assert.equal(fmt('{toString}', {}), '{toString}', 'no prototype keys');
});
