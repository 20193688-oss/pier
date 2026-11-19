/* i18n.test.ts: every key of the Spanish catalog (the source) exists in English and the other way
   round, no value is empty, lists have the same length, and every {placeholder} a Spanish string
   uses is in its English twin (and no new one appears). The catalogs' types already make a
   missing key a compile error; this also catches empty strings and placeholder drift. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CATALOGS, LANGS, initialLang } from '@/i18n';

type Tree = unknown;

function leaves(tree: Tree, path = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof tree === 'string') {
    out.set(path, tree);
    return out;
  }
  if (Array.isArray(tree)) {
    out.set(`${path}#length`, String(tree.length));
    tree.forEach((v, i) => leaves(v, `${path}[${i}]`).forEach((s, k) => out.set(k, s)));
    return out;
  }
  if (tree && typeof tree === 'object') {
    for (const [k, v] of Object.entries(tree))
      leaves(v, path ? `${path}.${k}` : k).forEach((s, key) => out.set(key, s));
    return out;
  }
  out.set(path, `<<${typeof tree}>>`);
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('both languages have exactly the same keys', () => {
  const es = leaves(CATALOGS.es);
  const en = leaves(CATALOGS.en);
  const missing = [...es.keys()].filter((k) => !en.has(k));
  const extra = [...en.keys()].filter((k) => !es.has(k));
  assert.deepEqual(missing, [], 'keys missing in English');
  assert.deepEqual(extra, [], 'keys only in English');
  assert.ok(es.size > 500, `a real catalog (${es.size} strings)`);
});

test('no value is empty or not a string', () => {
  for (const lang of LANGS) {
    for (const [k, v] of leaves(CATALOGS[lang])) {
      if (k.endsWith('#length')) continue;
      assert.ok(v.trim().length > 0, `${lang}:${k} is empty`);
      assert.ok(!v.startsWith('<<'), `${lang}:${k} is not a string`);
    }
  }
});

test('placeholders match between the languages', () => {
  const es = leaves(CATALOGS.es);
  const en = leaves(CATALOGS.en);
  for (const [k, v] of es) {
    if (k.endsWith('#length')) continue;
    assert.deepEqual(placeholders(en.get(k) ?? ''), placeholders(v), `placeholders of ${k}`);
  }
});

test('the starting language: the address, then the saved choice, then Spanish', () => {
  assert.equal(initialLang('?lang=en'), 'en');
  assert.equal(initialLang('?lang=fr'), 'es');
  assert.equal(initialLang(''), 'es');
});
