import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeKey, decodeKey, normalizeGift, rollCount, weightedPick, probabilities,
  sanitizeConfig, buildQueueItem, dedupeRule, isDuplicate,
} from '../shared/core.js';

test('encodeKey: Firebaseで使えない文字を可逆に置き換える', () => {
  for (const s of ['Rose', 'TikTok.Universe', 'a/b#c$d[e]', '100%', 'バラ']) {
    const k = encodeKey(s);
    assert.ok(!/[.#$[\]/]/.test(k), k);
    assert.equal(decodeKey(k), s);
  }
});

test('normalizeGift: 名前の揺れと型を吸収する', () => {
  const g = normalizeGift({ giftName: ' Rose ', repeatCount: '5', nickname: 'たろう', uniqueId: 'taro', repeatEnd: 'true' });
  assert.equal(g.giftName, 'Rose');
  assert.equal(g.repeatCount, 5);
  assert.equal(g.sender, 'たろう');
  assert.equal(g.userKey, 'taro');
  assert.equal(g.repeatEnd, true);

  const h = normalizeGift({ gift_name: 'Rose', repeat_count: 'abc', id: 'user-1', name: 'x' });
  assert.equal(h.giftName, 'Rose');
  assert.equal(h.repeatCount, 1);
  assert.equal(h.sender, '視聴者');
  assert.equal(h.repeatEnd, undefined);
  assert.equal(h.msgId, '', '汎用的な id は重複判定に使わない');

  assert.equal(normalizeGift({ giftName: 'x', repeatCount: '999999' }).repeatCount, 9999);
});

test('rollCount: 連続ギフトの扱い', () => {
  assert.equal(rollCount({ combo: 'once' }, 30), 1);
  assert.equal(rollCount({ combo: 'perCount', maxRolls: 10 }, 3), 3);
  assert.equal(rollCount({ combo: 'perCount', maxRolls: 10 }, 99), 10);
  assert.equal(rollCount({ combo: 'everyN', comboN: 5, maxRolls: 10 }, 4), 0);
  assert.equal(rollCount({ combo: 'everyN', comboN: 5, maxRolls: 10 }, 12), 2);
  assert.equal(rollCount({}, 7), 1);
});

test('weightedPick: 重みに従い、重み0は選ばれない', () => {
  const items = [{ label: 'A', weight: 1 }, { label: 'B', weight: 0 }, { label: 'C', weight: 3 }];
  assert.equal(weightedPick(items, () => 0).label, 'A');
  assert.equal(weightedPick(items, () => 0.24).label, 'A');
  assert.equal(weightedPick(items, () => 0.26).label, 'C');
  assert.equal(weightedPick(items, () => 0.999999).label, 'C');
  assert.equal(weightedPick([{ label: 'X', weight: 0 }]), null);

  // 実際の乱数でも分布がおおむね重み通りになる
  const counts = { A: 0, C: 0 };
  for (let i = 0; i < 20000; i++) counts[weightedPick(items).label]++;
  const ratio = counts.A / 20000;
  assert.ok(ratio > 0.22 && ratio < 0.28, `A の割合 ${ratio}`);
});

test('probabilities: 管理画面用の確率表示', () => {
  assert.deepEqual(probabilities([{ weight: 1 }, { weight: 3 }]), [25, 75]);
  assert.deepEqual(probabilities([{ weight: 0 }]), [0]);
});

const sampleInput = {
  tables: {
    shibari: { title: '縛りガチャ', items: [{ label: '釣り禁止', weight: 1, rarity: 'R', color: '#ff0000' }, { label: '', weight: 5 }] },
  },
  gifts: {
    any1: { giftName: 'Rose', mode: 'roulette', tableId: 'shibari', combo: 'perCount', maxRolls: 3 },
    any2: { giftName: 'Bad', tableId: 'missing' },
  },
  settings: { staleMinutes: '5', dedupeWindowSec: 99 },
};

test('sanitizeConfig: 不正な値を直し、警告を返す', () => {
  const { config, errors } = sanitizeConfig(sampleInput);
  assert.equal(config.tables.shibari.items.length, 1, 'ラベルが空の候補は捨てる');
  assert.equal(config.gifts.Rose.mode, 'roulette');
  assert.equal(config.gifts.Rose.combo, 'perCount');
  assert.equal(config.gifts.Bad.mode, 'gacha');
  assert.equal(config.settings.staleMinutes, 5);
  assert.equal(config.settings.dedupeWindowSec, 60);
  assert.ok(errors.some((e) => e.includes('missing')));
});

test('buildQueueItem: 設定に従って抽選結果を確定する', () => {
  const { config } = sanitizeConfig(sampleInput);
  const ok = buildQueueItem({ giftName: 'Rose', repeatCount: 5, sender: 'たろう' }, config, () => 0);
  assert.equal(ok.item.rolls.length, 3);
  assert.equal(ok.item.rolls[0].label, '釣り禁止');
  assert.equal(ok.item.mode, 'roulette');
  assert.equal(ok.item.title, '縛りガチャ');

  assert.match(buildQueueItem({ giftName: 'Unknown', repeatCount: 1 }, config).skip, /未設定/);
  assert.match(buildQueueItem({ giftName: 'Rose', repeatCount: 1, repeatEnd: false }, config).skip, /途中/);
  config.gifts.Rose.enabled = false;
  assert.match(buildQueueItem({ giftName: 'Rose', repeatCount: 1 }, config).skip, /無効/);
});

test('dedupeRule / isDuplicate: msgId と時間窓', async () => {
  const a = await dedupeRule({ msgId: 'm1', giftName: 'Rose' }, 3);
  const b = await dedupeRule({ msgId: 'm1', giftName: 'Other' }, 3);
  assert.equal(a.key, b.key);
  assert.equal(a.windowMs, null);
  assert.equal(isDuplicate(1000, 9_999_999, null), true);

  const c = await dedupeRule({ giftName: 'Rose', userKey: 'u', repeatCount: 1 }, 3);
  const d = await dedupeRule({ giftName: 'Rose', userKey: 'u', repeatCount: 2 }, 3);
  assert.notEqual(c.key, d.key);
  assert.equal(c.windowMs, 3000);
  assert.equal(isDuplicate(1000, 3999, 3000), true);
  assert.equal(isDuplicate(1000, 4000, 3000), false);
  assert.equal(isDuplicate(null, 4000, 3000), false);

  assert.equal(await dedupeRule({ giftName: 'Rose' }, 0), null);
});
