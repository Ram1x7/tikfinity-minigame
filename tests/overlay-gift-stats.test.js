import test from 'node:test';
import assert from 'node:assert/strict';
import {jstDate,emptyStats,applyGift} from '../overlay/gift-stats.js';
test('JST midnight is used',()=>{
 assert.notEqual(jstDate(Date.parse('2026-10-25T14:59:59Z')),jstDate(Date.parse('2026-10-25T15:00:00Z')));
});
test('gift quantities accumulate and duplicate keys are ignored',()=>{
 const now=Date.parse('2026-10-25T12:00:00Z');
 const first=applyGift(emptyStats(jstDate(now)),'-A',{sender:'a',giftName:'rose',repeatCount:3,receivedAt:now},now);
 assert.equal(first.stats.gifts,3);
 assert.equal(applyGift(first.stats,'-A',{sender:'a',repeatCount:3},now).changed,false);
 assert.equal(applyGift(first.stats,'-B',{sender:'a',repeatCount:2,receivedAt:now},now).stats.gifts,5);
});
test('yesterday gifts do not enter today totals',()=>{
 const today=Date.parse('2026-10-25T15:30:00Z');
 const yesterday=Date.parse('2026-10-25T14:30:00Z');
 const result=applyGift(emptyStats(jstDate(today)),'-A',{sender:'a',receivedAt:yesterday},today);
 assert.equal(result.stats.gifts,0);
 assert.equal(result.stats.cursor,'-A');
});
test('dangerous usernames do not pollute prototypes',()=>{
 const now=Date.parse('2026-10-25T12:00:00Z');
 const r=applyGift(emptyStats(jstDate(now)),'-A',{sender:'__proto__',receivedAt:now},now);
 assert.equal(r.stats.rank.__proto__,1);
 assert.equal(Object.getPrototypeOf(r.stats.rank),null);
});
test('saved rank with a hostile username can be restored safely',()=>{
 const now=Date.parse('2026-10-25T12:00:00Z');
 const first=applyGift(emptyStats(jstDate(now)),'-A',{sender:'__proto__',receivedAt:now},now).stats;
 const restored={...first,rank:Object.assign(Object.create(null),JSON.parse(JSON.stringify(first.rank)))};
 const next=applyGift(restored,'-B',{sender:'__proto__',receivedAt:now},now).stats;
 assert.equal(next.rank.__proto__,2);
 assert.equal(Object.getPrototypeOf(next.rank),null);
});
