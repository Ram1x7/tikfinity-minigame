import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../shared/config-normalize.js';
import { sanitizeConfig } from '../shared/core.js';

test('Firebaseから再読み込みしてもいいね・フォロールールと複数アクションが残る', () => {
  const original = {
    gifts: {},
    tables: {},
    triggers: [
      { id: 'like100', type: 'like', threshold: 100, actions: [{ type: 'message', text: 'ありがとう！' }] },
      { id: 'follow1', type: 'follow', actions: [{ type: 'todo', label: '石を5個' }, { type: 'message', text: 'フォローありがとう！' }] },
    ],
    settings: { staleMinutes: 10 },
  };
  const { config, errors } = sanitizeConfig(original);
  assert.deepEqual(errors, []);
  // Firebase RTDB は配列をキー付きオブジェクトとして返す場合がある
  const firebaseValue = { ...config, triggers: Object.fromEntries(config.triggers.map((r, i) => [i, r])) };
  const restored = normalizeConfig(firebaseValue);
  assert.equal(restored.triggers.length, 2);
  assert.equal(restored.triggers[0].threshold, 100);
  assert.equal(restored.triggers[0].actions[0].text, 'ありがとう！');
  assert.equal(restored.triggers[1].actions.length, 2);
  assert.equal(restored.triggers[1].actions[0].label, '石を5個');
});

test('旧設定とFirebaseの空データでも従来のギフト設定は保持', () => {
  assert.deepEqual(normalizeConfig(null), { gifts: {}, tables: {}, triggers: [], settings: {} });
  const restored = normalizeConfig({
    gifts: { Rose: { giftName: 'Rose' } },
    tables: { t1: { title: 'テスト', items: { 0: { label: '釣り', weight: 1 }, 2: { label: '料理', weight: 2 } } } },
  });
  assert.equal(restored.gifts.Rose.giftName, 'Rose');
  assert.deepEqual(restored.tables.t1.items.map((x) => x.label), ['釣り', '料理']);
  assert.deepEqual(restored.triggers, []);
});
