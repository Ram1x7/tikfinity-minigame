import test from 'node:test';
import assert from 'node:assert/strict';
import { awardTimer, advanceTimers, controlTimers } from '../shared/restraint-timers.js';

const fish = { id: 'fish', label: '釣り縛り', durationMs: 600000, group: 'exclusive' };
const bug = { id: 'bug', label: '虫捕り縛り', durationMs: 600000, group: 'exclusive' };
const jump = { id: 'jump', label: 'ジャンプ禁止', durationMs: 300000, group: 'parallel' };

test('釣り中の虫捕りは待機、待機中の再当選は時間加算', () => {
  let s = awardTimer(null, fish, 1000);
  s = awardTimer(s, bug, 181000);
  assert.equal(s.entries[0].remainingMs, 420000);
  assert.equal(s.entries[1].status, 'waiting');
  s = awardTimer(s, bug, 301000);
  assert.equal(s.entries[1].remainingMs, 1200000);
  s = advanceTimers(s, 601000);
  assert.equal(s.entries[0].status, 'done');
  assert.equal(s.entries[1].status, 'active');
  assert.equal(s.entries[1].remainingMs, 1200000);
});

test('移動時間も進み、終了したら残り経過時間で次の縛りを減らす', () => {
  let s = awardTimer(null, fish, 1000);
  s = awardTimer(s, bug, 1000);
  s = advanceTimers(s, 661000);
  assert.equal(s.entries[0].status, 'done');
  assert.equal(s.entries[1].remainingMs, 540000);
});

test('両立可能な縛りは同時進行', () => {
  let s = awardTimer(null, fish, 1000);
  s = awardTimer(s, jump, 1000);
  s = advanceTimers(s, 121000);
  assert.equal(s.entries[0].remainingMs, 480000);
  assert.equal(s.entries[1].remainingMs, 180000);
});

test('一時停止中は減らず、加算でき、再開から進む', () => {
  let s = awardTimer(null, fish, 1000);
  s = controlTimers(s, 'pause-all', 61000);
  s = awardTimer(s, fish, 300000);
  assert.equal(s.entries[0].remainingMs, 1140000);
  s = controlTimers(s, 'resume-all', 500000);
  s = advanceTimers(s, 560000);
  assert.equal(s.entries[0].remainingMs, 1080000);
});

test('手動終了で次の待機が実行中になる', () => {
  let s = awardTimer(null, fish, 1000);
  s = awardTimer(s, bug, 1000);
  s = controlTimers(s, 'finish', 1000, 'fish');
  assert.equal(s.entries[1].status, 'active');
});

test('時間切れ後の再当選は新規に開始', () => {
  let s = awardTimer(null, fish, 1000);
  s = awardTimer(s, fish, 601000);
  assert.equal(s.entries.length, 2);
  assert.equal(s.entries[1].status, 'active');
});

test('不正な設定は拒否', () => {
  assert.throws(() => awardTimer(null, { ...fish, durationMs: -1 }, 1000));
  assert.throws(() => awardTimer(null, { ...fish, id: 'a/b' }, 1000));
});
