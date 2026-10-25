// らみん民 LIVE Overlay: Firebase読み取り専用。既存の再生担当・再生位置には干渉しない。
import { getEnv } from '../js/env.js';
import { latestQueueKey, watchQueueAfter, watchConnection } from '../js/store.js';
const params = new URLSearchParams(location.search);
const demo = params.get('demo') === '1';
const env = getEnv();
const $ = id => document.getElementById(id);
const storageKey = 'raminmin-overlay-v2-' + env;
const dailyKey = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
const initial = { cursor: null, events: 0, gifts: 0, rank: {}, updatedAt: 0, day: dailyKey() };
let state = { ...initial }, unsubscribeQueue, unsubscribeConnection, toastTimer, demoTimer;
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
  // 集計はJST日付ごとに切り替え。キュー位置は維持し、過去イベントの再計上を防ぐ。
  if (state.day !== dailyKey()) { state = { ...initial, cursor: state.cursor, rank: {} }; render(); }
  if (!item || typeof item !== 'object') return;
  if (key && state.cursor && key <= state.cursor) return;
  const sender = String(item.sender || '視聴者').slice(0,40);
  const name = String(item.giftName || 'ギフト').slice(0,70);
  const quantity = Math.max(1, Math.min(9999, Math.floor(Number(item.repeatCount) || 1)));
  state.events += 1; state.gifts += quantity;
  // 表示名に '__proto__' などが来ても辞書のプロトタイプを汚染しない。
  if (Object.hasOwn(state.rank, sender)) state.rank[sender] += quantity;
  else Object.defineProperty(state.rank, sender, { value: quantity, enumerable: true, writable: true, configurable: true });
  if (key) state.cursor = key;
  state.updatedAt = Date.now(); save(); render();
  notify('🎁 ' + sender + ' さん：' + name + (quantity > 1 ? ' ×' + quantity : ''));
}
function startDemo() {
  state = { ...initial, rank: {} }; render(); $('mode').textContent = 'DEMO · 実データ未接続';
  const gifts = [{sender:'らみん民A',giftName:'ローズ',repeatCount:3},{sender:'らみん民B',giftName:'ハート',repeatCount:1},{sender:'らみん民A',giftName:'ローズ',repeatCount:2}];
  let index = 0;
  onGift(null,gifts[index++]); demoTimer = setInterval(() => onGift(null,gifts[index++ % gifts.length]),6000);
}
async function start() {
  if (demo) { startDemo(); return; }
  load();
  if (state.day !== dailyKey()) { state = { ...initial, cursor: state.cursor, rank: {} }; save(); }
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
