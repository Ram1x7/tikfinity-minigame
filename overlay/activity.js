import { getEnv } from '../js/env.js';
import { DEFAULT_WORKER_URL } from '../js/config.js';
const params=new URLSearchParams(location.search);
const demo=params.get('demo')==='1';
const env=getEnv(), dk=params.get('dk')||'';
const endpoint=String(params.get('w')||DEFAULT_WORKER_URL||'').replace(/\/+$/,'')+'/overlay/activity?env='+encodeURIComponent(env);
const $=id=>document.getElementById(id);
const layout=params.get('layout')||'full';
document.body.dataset.layout=['full','compact','minimal'].includes(layout)?layout:'full';
const hide=new Set((params.get('hide')||'').split(','));
for(const [key,id] of [['attendance','calendar-panel'],['ranking','likes-panel'],['gifts','gift-panel'],['comments','comment-panel']])if(hide.has(key))document.querySelector('.'+id).hidden=true;
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function fit(){$('stage').style.transform='scale('+Math.min(innerWidth/1080,innerHeight/1920)+')'}
addEventListener('resize',fit);fit();
let saved={users:[],recent:[]};let chosen='';
function calendar(days=[]){
 const ym=today().slice(0,7),[y,m]=ym.split('-').map(Number);
 $('month').textContent=ym;
 const c=$('calendar');c.replaceChildren();
 const first=(new Date(Date.UTC(y,m-1,1)).getUTCDay()+6)%7;
 const end=new Date(Date.UTC(y,m,0)).getUTCDate();
 for(let i=0;i<first;i++){const x=document.createElement('span');x.className='muted';c.append(x)}
 for(let d=1;d<=end;d++){const date=ym+'-'+String(d).padStart(2,'0');const x=document.createElement('span');x.textContent=String(d);if(days.includes(date))x.className='active';c.append(x)}
}
function itemLine(record,detail){
 const x=document.createElement('div');x.className='item';
 const name=document.createElement('strong');name.textContent=record.name||'視聴者';
 const text=document.createElement('span');text.className='detail';text.textContent=detail;
 x.append(name,text);return x;
}
function render(data){
 saved=data;
 const users=Array.isArray(data.users)?data.users:[];
 const select=$('viewer');const current=chosen||select.value;
 select.replaceChildren();
 if(!users.length){const opt=document.createElement('option');opt.textContent='入室データ待機中';opt.value='';select.append(opt)}
 for(const u of users){const opt=document.createElement('option');opt.value=u.id;opt.textContent=u.name+'（'+(u.days||[]).length+'日）';select.append(opt)}
 chosen=users.some(u=>u.id===current)?current:(users.find(u=>(u.days||[]).length>0)?.id||users[0]?.id||'');
 select.value=chosen; calendar(users.find(u=>u.id===chosen)?.days||[]);
 const likes=$('likes-ranking');likes.replaceChildren();
 const ranked=users.filter(u=>u.likes>0).sort((a,b)=>b.likes-a.likes).slice(0,5);
 if(!ranked.length){const li=document.createElement('li');li.textContent='—';likes.append(li)}
 for(const u of ranked){const li=document.createElement('li');li.textContent=u.name+'  ♡'+u.likes.toLocaleString('ja-JP');likes.append(li)}
 const recent=Array.isArray(data.recent)?data.recent:[];
 const feeds=[['gift-feed','gift'],['comment-feed','comment']];
 for(const [target,type] of feeds){
  const root=$(target);root.replaceChildren();
  const entries=recent.filter(x=>x.type===type).slice(0,5);
  if(!entries.length){const line=document.createElement('div');line.className='item';line.textContent='—';root.append(line)}
  for(const e of entries)root.append(itemLine(e,type==='gift'?(e.gift||'ギフト')+' ×'+(e.amount||1):e.message||'（本文未取得）'));
 }
}
$('viewer').addEventListener('change',()=>{chosen=$('viewer').value;calendar(saved.users.find(x=>x.id===chosen)?.days||[])});
let timer=0, rotation=0, working=false;
function rotateCalendar(){const list=(saved.users||[]).filter(u=>(u.days||[]).length);if(list.length<2)return;const i=list.findIndex(u=>u.id===chosen);chosen=list[(i+1)%list.length].id;$('viewer').value=chosen;calendar(list.find(u=>u.id===chosen)?.days||[])}
async function refresh(){
 if(working)return;working=true;
 try{
  const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dk}),cache:'no-store'});
  if(!res.ok)throw Error('HTTP '+res.status);
  render(await res.json());$('status').textContent='';
 }catch(e){$('status').textContent='データ取得不可 · '+String(e.message).slice(0,40)}
 finally{working=false}
}
function start(){
 if(demo){
  const day=today(), people=[{id:'a',name:'視聴者A',likes:135,days:[day]},{id:'b',name:'視聴者B',likes:80,days:[day]}];
  render({users:people,recent:[{type:'gift',name:'視聴者A',gift:'バラ',amount:3},{type:'comment',name:'視聴者B',message:'こんばんは！'}]});
  $('status').textContent='DEMO';return;
 }
 if(!dk){$('status').textContent='表示用URLに dk が必要です';calendar();return}
 refresh();timer=setInterval(refresh,4000);rotation=setInterval(rotateCalendar,12000);
}
addEventListener('pagehide',()=>clearInterval(timer);clearInterval(rotation)});start();
