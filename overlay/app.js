// らみん民 LIVE Overlay: Firebase読み取り専用。既存の再生担当・再生位置には干渉しない。
import { getEnv } from '../js/env.js';
import { latestQueueKey, watchQueueAfter, watchConnection } from '../js/store.js';
import { normalizeOverlayEvent, applyOverlayEvent } from './event-core.js';
import { jstDate, emptyStats, applyGift } from './gift-stats.js';
const params = new URLSearchParams(location.search);
const demo = params.get('demo') === '1';
// レイアウト切替はURLのみ。配信中の設定変更でデータは書き換えない。
const layout = params.get('layout') || 'compact';
if (['compact','full','minimal'].includes(layout)) document.body.dataset.layout = layout;
else document.body.dataset.layout = 'compact';
const hide = new Set((params.get('hide') || '').split(',').filter(x => ['counter','pet','ranking','attendance','brand','mode'].includes(x)));
for (const id of hide) { const el = document.getElementById(id); if (el) el.hidden = true; }
if (hide.has('brand')) document.querySelector('.brand').hidden = true;
const env = getEnv();
const $ = id => document.getElementById(id);
const storageKey = 'raminmin-overlay-v2-' + env;
const dailyKey = jstDate;
const initial = emptyStats();
let state = { ...initial }, unsubscribeQueue, unsubscribeConnection, toastTimer, demoTimer;
let demoState = { likes: 0, follows: 0, attendance: 0 };
function fit() { $('stage').style.transform = 'scale(' + Math.min(innerWidth / 1080, innerHeight / 1920) + ')'; }
addEventListener('resize', fit); fit();
function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (parsed && typeof parsed === 'object' && Number.isSafeInteger(parsed.events) && parsed.events >= 0 &&
      Number.isSafeInteger(parsed.gifts) && parsed.gifts >= 0 && parsed.rank && typeof parsed.rank === 'object' &&
      (parsed.cursor === null || typeof parsed.cursor === 'string')) {
      state = { ...initial, ...parsed, rank: Object.fromEntries(Object.entries(parsed.rank).filter(([k,v]) => typeof k === 'string' && Number.isFinite(v) && v >= 0).slice(0, 500)) };
    }
  } catch (e) { console.warn('保存済み集計を読めません', e); }
}
function save() { if (!demo) try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch (e) { console.warn('集計保存失敗', e); } }
function notify(message) {
  const t = $('toast'); t.textContent = message; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
}
function render() {
  $('gift-count').textContent = String(state.gifts);
  const list = $('ranking'); list.replaceChildren();
  const entries = Object.entries(state.rank).sort((a,b) => b[1] - a[1]).slice(0,5);
  if (!entries.length) { const li = document.createElement('li'); li.textContent = '受信待ち'; list.append(li); }
  for (const [name, count] of entries) {
    const li = document.createElement('li'); li.textContent = name + ' — ' + count + ' 個'; list.append(li);
  }
}
function onGift(key, item) {
  const result = applyGift(state, key, item);
  if (result.stats !== state) { state = result.stats; save(); render(); }
  if (!result.changed) return;
  notify('🎁 ' + result.sender + ' さん：' + result.name + (result.quantity > 1 ? ' ×' + result.quantity : ''));
}

function demoInteraction(type, sender, count = 1) {
  const event = normalizeOverlayEvent({ type, sender, count });
  if (!event) return;
  demoState = applyOverlayEvent(demoState, event);
  if (event.type === 'like') {
    $('pet-status').textContent = 'デモいいね ' + demoState.likes + ' 件';
    const pet = $('pet-face'); pet.classList.remove('pet-bounce'); void pet.offsetWidth; pet.classList.add('pet-bounce');
    notify('💜 ' + event.sender + ' さんがいいね ×' + event.count);
  } else if (event.type === 'attendance') {
    const marks = $('stamps').children;
    for (let i = 0; i < marks.length; i++) marks[i].textContent = i < (demoState.attendance % 6) ? '🌸' : '○';
    notify('🌸 ' + event.sender + ' さんが出席（デモ）');
  } else if (event.type === 'follow') notify('✨ ' + event.sender + ' さんがフォロー（デモ）');
  else if (event.type === 'comment') notify('💬 ' + event.sender + ' さんがコメント（デモ）');
}
function startDemo() {
  state = { ...initial, rank: {} }; render(); $('mode').textContent = 'DEMO · 実データ未接続';
  const gifts = [{sender:'らみん民A',giftName:'ローズ',repeatCount:3},{sender:'らみん民B',giftName:'ハート',repeatCount:1},{sender:'らみん民A',giftName:'ローズ',repeatCount:2}];
  let index = 0;
  onGift(null,gifts[index++]);
  const sequence = [() => demoInteraction('like','らみん民A',5), () => demoInteraction('attendance','らみん民B'), () => demoInteraction('follow','らみん民C'), () => demoInteraction('comment','らみん民A')];
  let tick = 0;
  demoTimer = setInterval(() => { if (tick % 2 === 0) onGift(null,gifts[index++ % gifts.length]); else sequence[Math.floor(tick / 2) % sequence.length](); tick++; },6000);
}
async function start() {
  if (demo) { startDemo(); return; }
  load();
  if (state.day !== dailyKey()) { state = emptyStats(dailyKey(), state.cursor); save(); }
  render();
  $('mode').textContent = (env === 'prod' ? '本番' : 'テスト') + ' · 接続中';
  try {
    // 初回だけ過去のキューを飛ばす。再起動後は保存したカーソル以降を処理する。
    if (state.cursor === null) { state.cursor = await latestQueueKey(env); save(); }
    unsubscribeConnection = watchConnection(ok => {
      $('mode').textContent = (env === 'prod' ? '本番' : 'テスト') + (ok ? ' · 接続済み' : ' · オフライン');
    });
    unsubscribeQueue = watchQueueAfter(env, state.cursor, (key,item) => onGift(key,item));
  } catch(e) { $('mode').textContent = 'Firebase接続エラー'; console.error('Overlay read failed',e); }
}
addEventListener('pagehide', () => { unsubscribeQueue?.(); unsubscribeConnection?.(); clearInterval(demoTimer); });
start();
