import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOrb, orbLayersFor, DEFAULT_ORB_RARITY, ORB_PARTS } from '../js/orb.js';

const wafu = JSON.parse(readFileSync(new URL('../images/themes/wafu/theme.json', import.meta.url), 'utf8'));

test('和風の宝珠: 7枚の部品と、素材の切れ端の補正を画像ごとに読む', () => {
  const orb = parseOrb(wafu);
  assert.deepEqual(Object.keys(orb.files).sort(), [...ORB_PARTS].sort());
  assert.equal(orb.files.base, 'orb-open-base.png');
  assert.deepEqual(orb.fixes.base, { clip: 'inset(0 0 0 7%)' });
  assert.deepEqual(orb.fixes.energy, { clip: 'inset(35% 0 0 0)' });
  assert.deepEqual(orb.fixes.petals, { softEdge: true });
  assert.equal(orb.fixes.closed, undefined, '補正のない画像は何もしない');
});

test('和風の宝珠: レア度ごとの光(N は桜なし、SSR が最も多い)', () => {
  const orb = parseOrb(wafu);
  assert.deepEqual(orbLayersFor(orb, 'N'), ['core', 'sparkles']);
  assert.ok(!orbLayersFor(orb, 'N').includes('petals'), 'N は桜を出さない');
  assert.ok(!orbLayersFor(orb, 'R').includes('petals'), 'R は桜を出さない');
  assert.ok(orbLayersFor(orb, 'R').includes('energy'), 'R は光の輪');
  assert.ok(orbLayersFor(orb, 'SR').includes('petals'), 'SR は桜');
  assert.deepEqual(orbLayersFor(orb, 'ssr'), ['core', 'energy', 'petals', 'sparkles', 'dust']);
  for (const r of ['N', 'R', 'SR']) assert.ok(orbLayersFor(orb, r).length < orbLayersFor(orb, 'SSR').length);
});

test('宝珠の設定: 文字列だけの書き方・未知の部品・不正な補正', () => {
  const orb = parseOrb({
    orbParts: {
      closed: 'a.png',
      base: { file: 'b.png', clip: 'url(evil.svg)' },
      lid: { clip: 'inset(1%)' },
      extra: 'x.png',
      petals: { file: 'p.png', softEdge: 'yes' },
    },
    orbRarity: { N: ['petals', 'unknown', 'core'] },
  });
  assert.deepEqual(orb.files, { closed: 'a.png', base: 'b.png', petals: 'p.png' });
  assert.deepEqual(orb.fixes, {}, 'inset() 以外の clip と true 以外の softEdge は使わない');
  assert.deepEqual(orb.rarity.N, ['core', 'petals'], '知らない部品名は無視し、順番はそろえる');
  assert.deepEqual(orb.rarity.SSR, DEFAULT_ORB_RARITY.SSR, '書かなかったレア度は既定値');
  assert.deepEqual(parseOrb({}).files, {});
});
