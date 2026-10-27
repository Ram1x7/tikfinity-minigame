import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeConfig, buildQueueItem, encodeKey } from '../shared/core.js';

function config(timer) {
  return {
    tables: { t1: { title: '縛り', items: [{ label: '釣り10分', weight: 1, rarity: 'N', timer }] } },
    gifts: { [encodeKey('Rose')]: { giftName: 'Rose', mode: 'roulette', tableId: 't1' } },
  };
}
const gift = { giftName: 'Rose', sender: 'test', repeatCount: 1 };
test('有効な縛り設定は保存・抽選結果に伝搬する', () => {
  const { config: c } = sanitizeConfig(config({ enabled: true, id: 'fish', minutes: 10, group: 'exclusive' }));
  const roll = buildQueueItem(gift, c, () => 0).item.rolls[0];
  assert.deepEqual(roll.timer, { id: 'fish', durationMs: 600000, group: 'exclusive', label: '釣り10分' });
});
test('タイマーを指定しなければ従来の抽選結果を維持する', () => {
  const { config: c } = sanitizeConfig(config(null));
  const roll = buildQueueItem(gift, c, () => 0).item.rolls[0];
  assert.equal('timer' in roll, false);
});
test('無効な時間とIDはタイマーを付与しない', () => {
  for (const timer of [
    { enabled: true, id: 'a/b', minutes: 10 },
    { enabled: true, id: 'fish', minutes: -5 },
    { enabled: true, id: 'fish', minutes: 10000 },
  ]) {
    const { config: c } = sanitizeConfig(config(timer));
    assert.equal(buildQueueItem(gift, c, () => 0).item.rolls[0].timer, undefined);
  }
});
