import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeConfig, buildQueueItem, encodeKey, youtubeVideoId } from '../shared/core.js';
import { awardTimer, advanceTimers, controlTimers } from '../shared/restraint-timers.js';

const url = 'https://example.com/workout.mp3';

test('縛りBGMは抽選結果からタイマー状態まで引き継がれる', () => {
  const { config, errors } = sanitizeConfig({
    tables: { t: { title: 'test', items: [{ label: '筋トレ', weight: 1, timer: { enabled: true, id: 'workout', minutes: 10, group: 'parallel', bgmUrl: url } }] } },
    gifts: { [encodeKey('Rose')]: { giftName: 'Rose', tableId: 't', mode: 'roulette' } },
  });
  assert.deepEqual(errors, []);
  const rule = buildQueueItem({ giftName: 'Rose', repeatCount: 1 }, config, () => 0).item.rolls[0].timer;
  assert.equal(rule.bgmUrl, url);
  const state = awardTimer(null, rule, 1000);
  assert.equal(state.entries[0].bgmUrl, url);
  assert.equal(state.entries[0].startedAt, 1000);
});

test('YouTube動画URLは公式埋め込み用BGMとして保存される', () => {
  const { config, errors } = sanitizeConfig({
    tables: { t: { title: 'test', items: [{ label: '筋トレ', weight: 1, timer: { enabled: true, id: 'workout', minutes: 10, bgmUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } }] } },
  });
  assert.deepEqual(errors, []);
  assert.equal(config.tables.t.items[0].timer.bgmUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://evil.example/watch?v=dQw4w9WgXcQ'), '');
});

test('待機中の縛りは開始するまでBGMの開始時刻を持たない', () => {
  const first = { id: 'a', label: 'A', durationMs: 1000, group: 'exclusive', bgmUrl: url };
  const next = { id: 'b', label: 'B', durationMs: 1000, group: 'exclusive', bgmUrl: 'https://example.com/b.mp3' };
  let state = awardTimer(null, first, 1000);
  state = awardTimer(state, next, 1000);
  assert.equal(state.entries[1].startedAt, null);
  state = advanceTimers(state, 2000);
  assert.equal(state.entries[1].status, 'active');
  assert.equal(state.entries[1].startedAt, 2000);
  state = controlTimers(state, 'finish', 2000, 'b');
  assert.equal(state.entries[1].status, 'done');
});
