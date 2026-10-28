import test from 'node:test';
import assert from 'node:assert/strict';
import { processGift } from '../worker/src/index.js';

function fakeDb(mode='gacha') {
  let serial = 0;
  const pending = {};
  const db = {
    get: async path => path.endsWith('/config') ? {
      gifts: { Rose: { enabled:true, mode, tableId:'t1', combo:'once' } },
      tables: { t1: { title:'やること', items:[{ label:'虫を1匹捕まえる', weight:1, rarity:'N' }] } },
      settings: { dedupeWindowSec: 0 },
    } : null,
    post: async path => path.endsWith('/queue') ? { name: `-Abcdefghij1234567${serial++}` } : { name:'-log' },
    patch: async (path, body) => { assert.equal(path, 'envs/prod/state/gachaTodo/pending'); Object.assign(pending,body); },
  };
  return { db, pending };
}
test('Webhookのガチャ2回分は同じ当選でも別々の未完了タスクとして記録', async () => {
  const {db,pending}=fakeDb();
  const a=await processGift(db,'prod',{giftName:'Rose',nickname:'視聴者'},'webhook');
  const b=await processGift(db,'prod',{giftName:'Rose',nickname:'視聴者'},'webhook');
  assert.equal(a.status,'queued'); assert.equal(b.status,'queued');
  assert.equal(Object.keys(pending).length,2);
  assert.deepEqual(Object.values(pending).map(x=>x.label),['虫を1匹捕まえる','虫を1匹捕まえる']);
});
test('ルーレット結果はガチャ未完了リストに入らない', async () => {
  const {db,pending}=fakeDb('roulette');
  const result=await processGift(db,'prod',{giftName:'Rose'},'webhook');
  assert.equal(result.status,'queued'); assert.deepEqual(pending,{});
});
