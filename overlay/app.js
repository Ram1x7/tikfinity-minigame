// 読み取り専用のオーバーレイ。既存キュー・カーソル・抽選処理は変更しない。
import { getEnv } from '../js/env.js';
import { latestQueueKey, watchQueueAfter, watchConnection } from '../js/store.js';
const params=new URLSearchParams(location.search);
const demo=params.get('demo')==='1';
const env=getEnv();
const $=id=>document.getElementById(id);
let count=0,rank=new Map(),unsubQueue=null,unsubConnection=null,toastTimer=null;
function fit(){const s=Math.min(innerWidth/1080,innerHeight/1920);$('stage').style.transform='scale('+s+')'}
addEventListener('resize',fit);fit();
function notify(message){const t=$('toast');t.textContent=message;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),4200)}
function updateRanking(){const list=$('ranking');list.replaceChildren();const entries=[...rank.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5);if(!entries.length){const li=document.createElement('li');li.textContent='受信待ち';list.append(li);return}for(const [name,score] of entries){const li=document.createElement('li');li.textContent=name+' — '+score+' 回';list.append(li)}}
function onGift(item){if(!item||typeof item!=='object')return;const sender=String(item.sender||item.nickname||'視聴者').slice(0,40);const name=String(item.giftName||item.gift||'ギフト').slice(0,70);count++;$('gift-count').textContent=String(count);rank.set(sender,(rank.get(sender)||0)+1);updateRanking();notify('🎁 '+sender+' さん：'+name)}
function demoStart(){$('mode').textContent='DEMO（実データ未接続）';const gifts=[{sender:'らみん民A',giftName:'ローズ'},{sender:'らみん民B',giftName:'ハート'},{sender:'らみん民A',giftName:'ローズ'}];let i=0;onGift(gifts[i++]);setInterval(()=>onGift(gifts[i++%gifts.length]),6000)}
async function start(){if(demo){demoStart();return}$('mode').textContent=env==='prod'?'本番データ接続中':'テストデータ接続中';try{const cursor=await latestQueueKey(env);unsubConnection=watchConnection(ok=>{$('mode').textContent=(env==='prod'?'本番':'テスト')+(ok?' · 接続中':' · オフライン')});unsubQueue=watchQueueAfter(env,cursor,(_key,item)=>onGift(item));}catch(e){$('mode').textContent='Firebase接続エラー';console.error('Overlay read failed',e)}}
addEventListener('pagehide',()=>{unsubQueue?.();unsubConnection?.()});start();
