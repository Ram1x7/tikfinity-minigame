import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slicesOf, sliceAt } from '../js/play-roulette.js';

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
