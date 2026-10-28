import test from 'node:test';
import assert from 'node:assert/strict';
import { todoEntries, todoSorted } from '../shared/gacha-todo.js';

const first = '-Abcdefghij123456789';
const second = '-Abcdefghij123456790';
test('ガチャの同一結果をまとめず抽選ごとに独立保存する', () => {
  const item = { mode:'gacha', sender:'らみ', giftName:'Rose', rolls:[{label:'りんごを拾う'},{label:'りんごを拾う'},{label:'虫を捕まえる'}] };
  const tasks = { ...todoEntries(first,item), ...todoEntries(second,item) };
  const sorted = todoSorted(tasks);
  assert.equal(sorted.length, 6);
  assert.deepEqual(sorted.map(x=>x.label), ['りんごを拾う','りんごを拾う','虫を捕まえる','りんごを拾う','りんごを拾う','虫を捕まえる']);
  assert.equal(new Set(sorted.map(x=>x.id)).size, 6);
});
test('完了すると先頭5件の次の1件が表示対象になる', () => {
  const item = { mode:'gacha', rolls:Array.from({length:7},(_,i)=>({label:`行動${i+1}`})) };
  const pending = todoEntries(first,item);
  assert.deepEqual(todoSorted(pending).slice(0,5).map(x=>x.label), ['行動1','行動2','行動3','行動4','行動5']);
  delete pending[`${first}_000`];
  assert.deepEqual(todoSorted(pending).slice(0,5).map(x=>x.label), ['行動2','行動3','行動4','行動5','行動6']);
});
test('ルーレットの当選はガチャのリストに追加しない', () => {
  assert.deepEqual(todoEntries(first,{mode:'roulette',rolls:[{label:'釣り'}]}),{});
});
