// ============================================================
// js/display.js  表示画面(PRISM LIVE に重ねるページ)
// ------------------------------------------------------------
// Worker がキューに積んだ結果を、届いた順に1件ずつ最後まで再生する。
// 抽選はしない。再生が終わるたびに「どこまで再生したか」を Firebase に保存するので、
// ページを読み込み直しても続きから再生され、二重再生も取りこぼしも起きない。
//
// URL パラメータ
//   ?env=prod      本番のキューを再生(省略時はテスト)
//   &skip=1        起動時に溜まっている未再生分を飛ばして最新から始める
//   &speed=2       演出の速さ(テスト用)
//   &top=300      カードの上端の位置(1080×1920 基準のpx)。ゲーム画面の見せたい所を避けて調整する
//   &preview=1     プレビュー用。開いた後に届いた分だけ再生し、再生位置を保存しない
// ============================================================
import { getEnv } from './env.js';
import {
  isConfigured, watchConfig, watchConnection, getCursor, setCursor,
  latestQueueKey, watchQueueAfter,
} from './store.js';
import { playGacha } from './play-gacha.js';
import { playRoulette } from './play-roulette.js';
import { rarityColor, sleep } from './visual.js';

const params = new URLSearchParams(location.search);
const env = getEnv();
const speed = Math.min(5, Math.max(0.2, Number(params.get('speed')) || 1));
const preview = params.get('preview') === '1';

const ROLL_GAP_MS = 500 / speed;      // 連続抽選の間隔
const RESULT_HOLD_MS = 1600 / speed;  // 1回ごとの結果を見せる時間
const TAIL_MS = 2600 / speed;         // 全部終わった後に表示しておく時間

const stage = document.getElementById('stage');
const eventEl = document.getElementById('event');
const senderEl = document.getElementById('ev-sender');
const giftEl = document.getElementById('ev-gift');
const titleEl = document.getElementById('ev-title');
const countEl = document.getElementById('ev-count');
const playEl = document.getElementById('ev-play');
const resultsEl = document.getElementById('ev-results');
const pendingEl = document.getElementById('pending');
const noticeEl = document.getElementById('notice');

// ---------------- キャンバスの拡縮 ----------------
function fit() {
  const scale = Math.min(window.innerWidth / 1080, window.innerHeight / 1920);
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
}
window.addEventListener('resize', fit);
fit();

if (env === 'test') document.getElementById('env-badge').hidden = false;

const top = Number(params.get('top'));
if (Number.isFinite(top) && params.has('top')) {
  stage.style.setProperty('--event-top', `${Math.min(1700, Math.max(90, top))}px`);
}

function notice(text) {
  noticeEl.hidden = !text;
  noticeEl.textContent = text || '';
}

// ---------------- 再生 ----------------
const queue = [];
let playing = false;
let settings = { staleMinutes: 10 };

function updatePending() {
  const rest = queue.length;
  pendingEl.hidden = rest === 0;
  pendingEl.textContent = `あと ${rest} 件`;
}

function addChip(roll) {
  const li = document.createElement('li');
  li.className = 'chip';
  li.style.setProperty('--rarity', rarityColor(roll.rarity, roll.color));
  const r = document.createElement('span');
  r.className = 'chip__rarity';
  r.textContent = roll.rarity || 'N';
  li.append(r, document.createTextNode(roll.label));
  resultsEl.append(li);
}

async function playItem(item) {
  const rolls = Array.isArray(item.rolls) ? item.rolls : Object.values(item.rolls || {});
  const pool = Array.isArray(item.pool) ? item.pool : Object.values(item.pool || {});
  if (rolls.length === 0) return;

  senderEl.textContent = `${item.sender || '視聴者'} さん`;
  giftEl.textContent = item.repeatCount > 1 ? `${item.giftName} ×${item.repeatCount}` : item.giftName;
  titleEl.textContent = item.title || '';
  resultsEl.replaceChildren();
  playEl.replaceChildren();
  countEl.textContent = '';
  eventEl.classList.add('show');
  await sleep(350);

  for (let i = 0; i < rolls.length; i++) {
    countEl.textContent = rolls.length > 1 ? `${i + 1} / ${rolls.length} 回目` : '';
    if (item.mode === 'roulette') await playRoulette(playEl, rolls[i], pool, { speed });
    else await playGacha(playEl, rolls[i], { speed });
    addChip(rolls[i]);
    await sleep(RESULT_HOLD_MS);
    if (i < rolls.length - 1) await sleep(ROLL_GAP_MS);
  }

  countEl.textContent = rolls.length > 1 ? `結果 ${rolls.length} 件` : '';
  await sleep(TAIL_MS + Math.max(0, rolls.length - 1) * 400);
}

function isStale(item) {
  const minutes = Number(settings.staleMinutes) || 0;
  if (minutes <= 0 || typeof item.receivedAt !== 'number') return false;
  return Date.now() - item.receivedAt > minutes * 60 * 1000;
}

async function drain() {
  if (playing) return;
  playing = true;
  while (queue.length > 0) {
    const { key, item } = queue.shift();
    updatePending();
    try {
      if (!isStale(item)) await playItem(item);
    } catch (err) {
      console.error('再生に失敗しました', err);
    }
    // 失敗しても先に進む(同じ項目で止まり続けないように)
    if (!preview) {
      try { await setCursor(env, key); } catch (err) { console.error('再生位置の保存に失敗', err); }
    }
  }
  eventEl.classList.remove('show');
  playing = false;
}

// ---------------- 起動 ----------------
async function start() {
  if (!isConfigured()) {
    notice('js/config.js に Firebase の接続情報を設定してください');
    return;
  }

  watchConnection((ok) => notice(ok ? '' : 'Firebase に接続できません'));
  watchConfig(env, (config) => { settings = { staleMinutes: 10, ...config.settings }; });

  let cursor = preview || params.get('skip') === '1' ? null : await getCursor(env);
  if (!cursor) {
    // 初回(またはskip・プレビュー)は、今あるキューは再生済みとして扱い、これから届く分だけ再生する
    cursor = await latestQueueKey(env);
    if (cursor && !preview) await setCursor(env, cursor);
  }

  const seen = new Set();
  watchQueueAfter(env, cursor, (key, item) => {
    if (seen.has(key) || !item) return;
    seen.add(key);
    queue.push({ key, item });
    updatePending();
    drain();
  });
}

start().catch((err) => {
  console.error(err);
  notice(`起動に失敗しました: ${err.message}`);
});
