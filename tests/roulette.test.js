import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slicesOf, sliceAt, unifyPlans } from '../js/play-roulette.js';
import { effectFor, isQuiet } from '../js/effects.js';

test('sliceAt: 針(真上)の下にある候補を返す', () => {
  const slices = slicesOf([{ label: 'A', weight: 1 }, { label: 'B', weight: 1 }, { label: 'C', weight: 2 }], ['#000']);
  // 回転0のとき真上(-90度 = 270度)は C(180〜360度)
  assert.equal(sliceAt(slices, 0).label, 'C');
  // B の真ん中(135度)が真上に来る回転
  const rotB = -Math.PI / 2 - (Math.PI * 3) / 4;
  assert.equal(sliceAt(slices, rotB).label, 'B');
  // 何周しても同じ
  assert.equal(sliceAt(slices, rotB + Math.PI * 2 * 7).label, 'B');
});

test('slicesOf: 扇形の大きさは確率(重み)どおり', () => {
  const slices = slicesOf([{ label: 'A', weight: 3 }, { label: 'B', weight: 1 }], ['#000']);
  assert.ok(Math.abs(slices[0].sweep - Math.PI * 1.5) < 1e-9);
  assert.ok(Math.abs(slices[1].sweep - Math.PI * 0.5) < 1e-9);
});

test('unifyPlans: 番号の扇形が1つでもあれば全部を番号にそろえ、無ければそのまま', () => {
  const slices = slicesOf([{ label: '釣り', weight: 5 }, { label: '虫とり', weight: 5 }, { label: 'とても長い候補の名前', weight: 1 }], ['#000']);
  const named = [{ mode: 'text', text: '釣り' }, { mode: 'text', text: '虫とり' }, { mode: 'text', text: 'とても長い' }];
  assert.equal(unifyPlans(named, slices, 0.5), named, '全部収まるなら名前のまま');
  const mixed = [{ mode: 'text', text: '釣り' }, { mode: 'text', text: '虫とり' }, { mode: 'number', text: '3', fontSize: 56, drawable: true }];
  const out = unifyPlans(mixed, slices, 0.5);
  assert.deepEqual(out.map((p) => p.mode), ['number', 'number', 'number']);
  assert.deepEqual(out.map((p) => p.text), ['1', '2', '3']);
});

test('effectFor: レア度別の演出は既定値とテーマの設定を合わせ、範囲内に収める', () => {
  assert.ok(isQuiet(effectFor(null, 'N')), 'N は既定で演出なし');
  assert.ok(!isQuiet(effectFor(null, 'SSR')));
  const theme = { effects: { SR: { sakura: 999, glow: 5, duration: 99999, color: '#abcdef' } } };
  const sr = effectFor(theme, 'sr');
  assert.equal(sr.sakura, 30, '花びらは最大30');
  assert.equal(sr.glow, 1, '光は最大1');
  assert.equal(sr.duration, 2500, '長さは最大2.5秒');
  assert.equal(sr.color, '#abcdef');
  assert.equal(effectFor(theme, 'R').gold, 4, '書いていないレア度は既定値');
});
