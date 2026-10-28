import test from 'node:test';
import assert from 'node:assert/strict';
import { updateRestraints, readRestraints } from '../worker/src/restraint.js';

const fish = { id: 'fish', label: '釣り縛り', durationMs: 600000, group: 'exclusive' };
const bug = { id: 'bug', label: '虫捕り縛り', durationMs: 600000, group: 'exclusive' };
function mockDb() {
  let value = null, version = 0;
  return {
    getWithEtag: async () => ({ value: structuredClone(value), etag: String(version) }),
    putIfMatch: async (_, next, tag) => {
      if (tag !== String(version)) return false;
      value = structuredClone(next); version++; return true;
    },
    get: async () => structuredClone(value),
  };
}
test('Worker初回当選で自動開始し、同一イベントの再送では加算しない', async () => {
  const db = mockDb();
  const action = { type: 'award', eventId: '-abcdefghij:0', rule: fish };
  const first = await updateRestraints(db, 'test', action, 1000);
  assert.equal(first.duplicate, false);
  assert.equal(first.state.paused, false);
  assert.equal(first.state.entries[0].status, 'active');
  const duplicate = await updateRestraints(db, 'test', action, 1000);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state.entries[0].remainingMs, 600000);
});
test('Workerで釣り→虫捕り待機→重複加算→自動切替を保持', async () => {
  const db = mockDb();
  await updateRestraints(db, 'test', { type:'award', eventId:'-abcdefghij:0', rule:fish }, 1000);
  await updateRestraints(db, 'test', { type:'award', eventId:'-abcdefghij:1', rule:bug }, 2000);
  await updateRestraints(db, 'test', { type:'award', eventId:'-abcdefghij:2', rule:bug }, 3000);
  const state = await readRestraints(db, 'test', 601000);
  assert.equal(state.entries[0].status, 'done');
  assert.equal(state.entries[1].status, 'active');
  assert.equal(state.entries[1].remainingMs, 1200000);
});
test('Worker全停止・再開は停止中の時間を減算しない', async () => {
  const db = mockDb();
  await updateRestraints(db, 'test', { type:'award', eventId:'-abcdefghij:0', rule:fish }, 1000);
  await updateRestraints(db, 'test', { type:'pause-all' }, 61000);
  const paused = await readRestraints(db, 'test', 360000);
  assert.equal(paused.entries[0].remainingMs, 540000);
  await updateRestraints(db, 'test', { type:'resume-all' }, 360000);
  const resumed = await readRestraints(db, 'test', 420000);
  assert.equal(resumed.entries[0].remainingMs, 480000);
});

test('全リセットはタイマーのみ削除し、重複イベント履歴を保持する', async () => {
  const db = mockDb();
  const action = { type: 'award', eventId: '-abcdefghij:0', rule: fish };
  await updateRestraints(db, 'prod', action, 1000);
  const result = await updateRestraints(db, 'prod', { type: 'reset-all' }, 2000);
  assert.deepEqual(result.state.entries, []);
  assert.equal(result.state.paused, false);
  assert.ok(result.state.applied['-abcdefghij:0']);
  const retry = await updateRestraints(db, 'prod', action, 3000);
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.state.entries, []);
  const next = await updateRestraints(db, 'prod', { ...action, eventId: '-abcdefghij:1' }, 4000);
  assert.equal(next.duplicate, false);
  assert.equal(next.state.entries[0].status, 'active');
});
