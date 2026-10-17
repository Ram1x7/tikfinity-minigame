import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLayout, layoutToParams, fitPanel, DEFAULT_LAYOUT } from '../js/layout.js';

test('parseLayout: 指定が無ければ既定値', () => {
  assert.deepEqual(parseLayout(new URLSearchParams('')), DEFAULT_LAYOUT);
});

test('parseLayout: ガチャ・ルーレット別の位置・大きさ、範囲外は丸める', () => {
  const l = parseLayout(new URLSearchParams('theme=wafu&g=200,90&r=5,999&safe=1300'));
  assert.equal(l.theme, 'wafu');
  assert.deepEqual(l.gacha, { top: 200, scale: 90 });
  assert.deepEqual(l.roulette, { top: 40, scale: 130 });
  assert.equal(l.safeBottom, 1300);
  assert.equal(parseLayout(new URLSearchParams('theme=../x')).theme, '', '不正なテーマ名は無視');
  assert.deepEqual(parseLayout(new URLSearchParams('g=abc')).gacha, DEFAULT_LAYOUT.gacha);
});

test('parseLayout: 古い top= は両方の上端になる', () => {
  const l = parseLayout(new URLSearchParams('top=300'));
  assert.equal(l.gacha.top, 300);
  assert.equal(l.roulette.top, 300);
});

test('layoutToParams と parseLayout は往復で同じになる', () => {
  const l = { theme: 'wafu', gacha: { top: 150, scale: 95 }, roulette: { top: 90, scale: 110 }, safeBottom: 1350 };
  assert.deepEqual(parseLayout(new URLSearchParams(layoutToParams(l))), l);
});

test('fitPanel: 下端が safe を越えるときだけ縮める', () => {
  const ok = fitPanel({ top: 110, scale: 100 }, 1200, 1400);
  assert.equal(ok.zoom, 1);
  assert.equal(ok.shrunk, false);
  assert.equal(ok.bottom, 1310);

  const big = fitPanel({ top: 110, scale: 100 }, 1400, 1400);
  assert.ok(big.shrunk);
  assert.ok(big.bottom <= 1400);

  const small = fitPanel({ top: 110, scale: 80 }, 1400, 1400);
  assert.equal(small.zoom, 0.8, '設定の大きさが収まるならそのまま');
});
