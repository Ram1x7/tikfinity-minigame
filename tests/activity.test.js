import {test} from 'node:test';
import assert from 'node:assert/strict';
import {saveActivity,getActivity} from '../worker/src/activity.js';

function fakeDb(){
 const data=new Map();let seq=0;
 return {
  data,
  async get(path,query){
   if(query?.shallow)return Object.fromEntries([...data].filter(([k])=>k.startsWith(path+'/')).map(([k])=>[k.slice(path.length+1).split('/')[0],true]));
   if(query?.limitToLast){const entries=[...data].filter(([k])=>k.startsWith(path+'/')).slice(-Number(query.limitToLast));return Object.fromEntries(entries.map(([k,v])=>[k.slice(path.length+1),v]));}
   if(data.has(path))return data.get(path);
   const entries=[...data].filter(([k])=>k.startsWith(path+'/')).map(([k,v])=>[k.slice(path.length+1),v]);
   return entries.length?Object.fromEntries(entries):null;
  },
  async getWithEtag(path){return {value:data.get(path)??null,etag:String(seq)}},
  async putIfMatch(path,value){data.set(path,value);return true},
  async post(path,value){const name='-test'+(++seq);data.set(path+'/'+name,value);return {name}},
  async patch(path,patch){for(const [k,v] of Object.entries(patch))v===null?data.delete(path+'/'+k):data.set(path+'/'+k,v);return null},
 };
}
test('same viewer attendance is one JST calendar day',async()=>{
 const db=fakeDb(), now=Date.parse('2026-10-27T00:30:00+09:00');
 await saveActivity(db,'test',{userId:'viewerA',nickname:'Alice'},'attendance',now);
 await saveActivity(db,'test',{userId:'viewerA',nickname:'Alice'},'attendance',now+3000);
 const snap=await getActivity(db,'test');
 assert.equal(snap.users.length,1);
 assert.deepEqual(snap.users[0].days,['2026-10-27']);
});
test('likes are grouped by viewer, not by display name',async()=>{
 const db=fakeDb(), now=Date.parse('2026-10-27T00:30:00+09:00');
 await saveActivity(db,'test',{userId:'a',nickname:'Guest',count:3},'like',now);
 await saveActivity(db,'test',{userId:'a',nickname:'Guest',count:2},'like',now+1);
 await saveActivity(db,'test',{userId:'b',nickname:'Guest',count:5},'like',now+2);
 const snap=await getActivity(db,'test');
 assert.equal(snap.users.length,2);
 assert.deepEqual(snap.users.map(u=>u.likes),[5,5]);
 assert.ok(snap.users.every(u=>u.id!=='a'&&u.id!=='b'));
});
test('comment text and gift name are readable only from private snapshot',async()=>{
 const db=fakeDb();
 await saveActivity(db,'test',{nickname:'A',comment:'こんばんは'},'comment');
 await saveActivity(db,'test',{nickname:'B',giftName:'バラ',repeatCount:3},'gift');
 const snap=await getActivity(db,'test');
 assert.equal(snap.recent.find(x=>x.type==='comment').message,'こんばんは');
 assert.equal(snap.recent.find(x=>x.type==='gift').gift,'バラ');
 assert.equal(snap.recent.find(x=>x.type==='gift').amount,3);
});
