// らみん民 LIVE Overlay: Firebase読み取り専用。既存の再生担当・再生位置には干渉しない。
import { getEnv } from '../js/env.js';
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
let state = { ...initial }, unsubscribeQueue, unsubscribeOverlay, unsubscribeConnection, toastTimer, demoTimer;
const overlayCursorKey = 'raminmin-overlay-event-cursor-' + env;
let overlayCursor = null;
const overlayDailyKey = 'raminmin-overlay-event-totals-' + env;
function loadEventTotals() {
  try { const saved = JSON.parse(localStorage.getItem(overlayDailyKey) || 'null');
    if (saved && saved.day === dailyKey()) return {likes:Number(saved.likes)||0,follows:Number(saved.follows)||0,attendance:Number(saved.attendance)||0};
  } catch {}
  return {likes:0,follows:0,attendance:0};
}
function saveEventTotals() {
  if (demo) return;
  try { localStorage.setItem(overlayDailyKey, JSON.stringify({...demoState,day:dailyKey()})); } catch {}
}
let demoState = { likes: 0, follows: 0, attendance: 0 };
function resetForNewDay() {
  if (demo || state.day === dailyKey()) return;
  state = emptyStats(dailyKey(), state.cursor);
  save();
  demoState = { likes: 0, follows: 0, attendance: 0 };
  saveEventTotals();
  $('pet-status').textContent = 'いいね 0 件';
  for (const mark of $('stamps').children) mark.textContent = '○';
  render();
}
function fit() { $('stage').style.transform = 'scale(' + Math.min(innerWidth / 1080, innerHeight / 1920) + ')'; }
addEventListener('resize', fit); fit();
function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (parsed && typeof parsed === 'object' && Number.isSafeInteger(parsed.events) && parsed.events >= 0 &&
      Number.isSafeInteger(parsed.gifts) && parsed.gifts >= 0 && parsed.rank && typeof parsed.rank === 'object' &&
      (parsed.cursor === null || typeof parsed.cursor === 'string')) {
      const safeRank = Object.assign(Object.create(null), Object.fromEntries(Object.entries(parsed.rank).filter(([k,v]) => typeof k === 'string' && Number.isFinite(v) && v >= 0).slice(0, 500)));
      state = { ...initial, ...parsed, rank: safeRank };
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

function demoInteraction(type, sender, count = 1, isDemo = true) {
  const event = normalizeOverlayEvent({ type, sender, count });
  if (!event) return;
  demoState = applyOverlayEvent(demoState, event);
  if (!isDemo) saveEventTotals();
  if (event.type === 'like') {
    $('pet-status').textContent = (isDemo ? 'デモいいね ' : 'いいね ') + demoState.likes + ' 件';
    const pet = $('pet-face'); pet.classList.remove('pet-bounce'); void pet.offsetWidth; pet.classList.add('pet-bounce');
    notify('💜 ' + event.sender + ' さんがいいね ×' + event.count);
  } else if (event.type === 'attendance') {
    const marks = $('stamps').children;
    for (let i = 0; i < marks.length; i++) marks[i].textContent = i < (demoState.attendance % 6) ? '🌸' : '○';
    notify('🌸 ' + event.sender + ' さんが出席' + (isDemo ? '（デモ）' : ''));
  } else if (event.type === 'follow') notify('✨ ' + event.sender + ' さんがフォロー' + (isDemo ? '（デモ）' : ''));
  else if (event.type === 'comment') notify('💬 ' + event.sender + ' さんがコメント' + (isDemo ? '（デモ）' : ''));
}
function onOverlayEvent(key, raw) {
  if (overlayCursor && key <= overlayCursor) return;
  overlayCursor = key;
  try { localStorage.setItem(overlayCursorKey, key); } catch (e) { console.warn('イベント位置の保存失敗', e); }
  const event = normalizeOverlayEvent(raw);
  if (!event || event.type === 'gift') return;
  if (event.timestamp && jstDate(event.timestamp) !== dailyKey()) return;
  demoInteraction(event.type, event.sender, event.count, false);
}
function startDemo() {
  state = emptyStats(); render(); $('mode').textContent = 'DEMO · 実データ未接続';
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
  demoState = loadEventTotals();
  $('pet-status').textContent = 'いいね ' + demoState.likes + ' 件';
  const marks = $('stamps').children;
  for (let i = 0; i < marks.length; i++) marks[i].textContent = i < (demoState.attendance % 6) ? '🌸' : '○';
  resetForNewDay();
  render();
  setInterval(resetForNewDay, 30000);
  document.addEventListener('visibilitychange', resetForNewDay);
  $('mode').textContent = (env === 'prod' ? '本番' : 'テスト') + ' · 接続中';
  try {
    // デモ時はFirebase SDKを一切読み込まない。実配信時だけ遅延ロードする。
    const { latestQueueKey, watchQueueAfter, watchConnection, latestOverlayEventKey, watchOverlayEventsAfter } = await import('../js/store.js');
    // 初回だけ過去のキューを飛ばす。再起動後は保存したカーソル以降を処理する。
    if (state.cursor === null) { state.cursor = await latestQueueKey(env); save(); }
    unsubscribeConnection = watchConnection(ok => {
      $('mode').textContent = (env === 'prod' ? '本番' : 'テスト') + (ok ? ' · 接続済み' : ' · オフライン');
    });
    unsubscribeQueue = watchQueueAfter(env, state.cursor, (key,item) => onGift(key,item));
    try {
      overlayCursor = localStorage.getItem(overlayCursorKey);
      if (!overlayCursor) { overlayCursor = await latestOverlayEventKey(env); if (overlayCursor) localStorage.setItem(overlayCursorKey, overlayCursor); }
      unsubscribeOverlay = watchOverlayEventsAfter(env, overlayCursor, onOverlayEvent);
    } catch (e) { console.warn('追加イベント購読失敗', e); }
  } catch(e) { $('mode').textContent = 'Firebase接続エラー'; console.error('Overlay read failed',e); }
}
addEventListener('pagehide', () => { unsubscribeQueue?.(); unsubscribeOverlay?.(); unsubscribeConnection?.(); clearInterval(demoTimer); });
start();
