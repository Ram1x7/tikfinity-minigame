import test from 'node:test';
import assert from 'node:assert/strict';
import { processOverlayEvent, cleanupOverlayEvents } from '../worker/src/overlay-events.js';

function fakeDb() {
  const saved = new Map();
  const posts = [];
  return {
    saved, posts,
    async getWithEtag(path) { return { value: saved.get(path) ?? null, etag: 'etag' }; },
    async putIfMatch(path,value) { if (saved.has(path)) return false; saved.set(path,value); return true; },
    async post(path,payload) { posts.push({path,payload}); return {name:'-EVENT1'}; },
    async remove(path) { saved.delete(path); },
    async get() { return {}; },
    async patch() {}
  };
}
test('like event is written outside the lottery queue', async () => {
  const db=fakeDb();
  const result=await processOverlayEvent(db,'prod',{type:'like',sender:'viewer',count:3,eventId:'abc'},1000);
  assert.equal(result.status,'queued');
  assert.equal(db.posts[0].path,'envs/prod/overlay/events');
  assert.equal(db.posts[0].payload.count,3);
});
test('same eventId is not posted twice', async () => {
  const db=fakeDb();
  await processOverlayEvent(db,'prod',{type:'follow',eventId:'abc'},1000);
  const result=await processOverlayEvent(db,'prod',{type:'follow',eventId:'abc'},1100);
  assert.equal(result.status,'duplicate');
  assert.equal(db.posts.length,1);
});
test('gift is ignored by the overlay event webhook', async () => {
  const db=fakeDb();
  assert.equal((await processOverlayEvent(db,'prod',{type:'gift'},1000)).status,'skipped');
  assert.equal(db.posts.length,0);
});
test('cleanup can run against an empty event feed', async () => {
  await cleanupOverlayEvents(fakeDb(),'prod',1000);
});
