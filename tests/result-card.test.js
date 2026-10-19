import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseResultCard } from '../js/result-card.js';

const wafu = JSON.parse(readFileSync(new URL('../images/themes/wafu/theme.json', import.meta.url), 'utf8'));

test('和風の結果カード: レア度ごとの枠と文字の場所を読む', () => {
  const rc = parseResultCard(wafu);
  assert.deepEqual(rc.frames, { N: 'card-n.png', R: 'card-r.png', SR: 'card-sr.png', SSR: 'card-ssr.png' });
  // 文字の場所は左右対称で、上下が重ならない(景品名の下に送信者名の枠)
  assert.equal(rc.label.left, rc.label.right);
  assert.ok(100 - rc.label.bottom <= rc.sub.top, '景品名と送信者名の枠が重ならない');
  assert.ok(rc.body.top + rc.body.bottom < 30);
  // 本体(透明な余白を除く)が和風の再生の枠 760px に収まる
  assert.ok(rc.height * (1 - (rc.body.top + rc.body.bottom) / 100) <= 760, `本体の高さ ${rc.height}`);
});

test('結果カード: 4枚そろわない・設定が無い・不正な値', () => {
  assert.equal(parseResultCard({}), null, '設定が無ければ従来の札');
  assert.equal(parseResultCard({ resultCard: { frames: { N: 'a.png', R: 'b.png', SR: 'c.png' } } }), null, '1枚欠けたら従来の札');
  const rc = parseResultCard({
    resultCard: {
      frames: { n: 'a.png', r: 'b.png', sr: 'c.png', ssr: 'd.png' },
      label: { left: 80, right: 10, top: 10, bottom: 10 },
      sub: { left: 10, right: 10, top: 60, bottom: 50 },
      height: 5000,
    },
  });
  assert.equal(rc.frames.SSR, 'd.png', '小文字のレア度名も読む');
  assert.deepEqual(rc.label, { left: 22, right: 22, top: 23.5, bottom: 42.5 }, '範囲外の値は既定値');
  assert.equal(rc.sub, null, '上下が重なる枠は使わない');
  assert.equal(rc.height, 880, '大きすぎる高さは既定値');
  assert.deepEqual(rc.body, { left: 0, right: 0, top: 0, bottom: 0 });
});
