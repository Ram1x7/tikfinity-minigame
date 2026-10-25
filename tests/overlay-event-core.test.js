import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOverlayEvent, applyOverlayEvent } from '../overlay/event-core.js';

test('accepts explicit known event types', () => {
  const event = normalizeOverlayEvent({type:'like', sender:'viewer', count:5});
  assert.equal(event.type,'like');
  assert.equal(event.count,5);
});
test('rejects unknown events and invalid payloads', () => {
  assert.equal(normalizeOverlayEvent({type:'unknown'}),null);
  assert.equal(normalizeOverlayEvent(null),null);
  assert.equal(normalizeOverlayEvent([]),null);
});
test('clamps event counts and limits display names', () => {
  const event=normalizeOverlayEvent({type:'gift',sender:'a'.repeat(100),count:999999});
  assert.equal(event.count,9999);
  assert.equal(event.sender.length,40);
});
test('like, follow, attendance update independent counters', () => {
  let state={likes:0,follows:0,attendance:0};
  for(const type of ['like','follow','attendance'])state=applyOverlayEvent(state,{type,count:3});
  assert.deepEqual(state,{likes:3,follows:1,attendance:1});
});
