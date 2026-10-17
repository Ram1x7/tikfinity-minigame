import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLayout, layoutToParams, fitPanel, defaultLayout, DEFAULT_LAYOUT } from '../js/layout.js';

test('従来デザインの初期値は以前の表示と同じ(上端300・100%・コメント欄よけなし)', () => {
  const l = parseLayout(new URLSearchParams(''));
  assert.deepEqual(l, DEFAULT_LAYOUT);
  assert.deepEqual(l.gacha, { top: 300, scale: 100 });
  assert.deepEqual(l.roulette, { top: 300, scale: 100 });
  assert.equal(l.safeBottom, 0);
  // 倍率は100%のまま縮めない
  assert.deepEqual(fitPanel(l.gacha, 1800, l.safeBottom), { zoom: 1, shrunk: false, bottom: 2100 });
});

test('テーマごとに初期値が独立している', () => {
  const wafu = parseLayout(new URLSearchParams('theme=wafu'));
  assert.deepEqual(wafu.gacha, { top: 110, scale: 100 });
  assert.equal(wafu.safeBottom, 1400);
  assert.equal(wafu.panel, true);
  // 和風の初期値を変えても従来の初期値は変わらない
  const w = defaultLayout('wafu');
  w.gacha.top = 999;
  assert.equal(defaultLayout('').gacha.top, 300);
  assert.equal(defaultLayout('wafu').gacha.top, 110);
});

test('parseLayout: ガチャ・ルーレット別の位置・大きさ、範囲外は丸める', () => {
  const l = parseLayout(new URLSearchParams('theme=wafu&g=200,90&r=5,999&safe=1300&panel=0'));
  assert.equal(l.theme, 'wafu');
  assert.deepEqual(l.gacha, { top: 200, scale: 90 });
  assert.deepEqual(l.roulette, { top: 40, scale: 130 });
  assert.equal(l.safeBottom, 1300);
  assert.equal(l.panel, false);
  assert.equal(parseLayout(new URLSearchParams('theme=../x')).theme, '', '不正なテーマ名は無視');
  assert.deepEqual(parseLayout(new URLSearchParams('g=abc')).gacha, DEFAULT_LAYOUT.gacha);
  assert.equal(parseLayout(new URLSearchParams('theme=wafu&safe=0')).safeBottom, 0, 'safe=0 で使わない');
});

test('parseLayout: 古い top= は両方の上端になる', () => {
  const l = parseLayout(new URLSearchParams('top=500'));
  assert.equal(l.gacha.top, 500);
  assert.equal(l.roulette.top, 500);
});

test('layoutToParams と parseLayout は往復で同じになる', () => {
  for (const l of [
    { theme: 'wafu', gacha: { top: 150, scale: 95 }, roulette: { top: 90, scale: 110 }, safeBottom: 1350, panel: false },
    { theme: '', gacha: { top: 300, scale: 100 }, roulette: { top: 280, scale: 90 }, safeBottom: 0, panel: true },
  ]) {
    assert.deepEqual(parseLayout(new URLSearchParams(layoutToParams(l))), l);
  }
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
