// ============================================================
// js/display.js  表示画面(PRISM LIVE に重ねるページ)
// ------------------------------------------------------------
// Worker がキューに積んだ結果を、届いた順に1件ずつ最後まで再生する。
// 抽選はしない。再生が終わるたびに「どこまで再生したか」を Firebase に保存するので、
// ページを読み込み直しても続きから再生され、二重再生も取りこぼしも起きない。
//
// URL パラメータ
//   ?env=prod      本番のキューを再生(省略時はテスト)
//   &theme=wafu    画像テーマ(images/themes/<名前>/)。省略時は従来のデザイン
//   &g=110,100     ガチャの台紙の上端(px)・大きさ(%)     ┐ 管理画面の「表示の調整」で作る
//   &r=110,100     ルーレットの台紙の上端(px)・大きさ(%) │ (js/layout.js)
//   &safe=1400     これより下に台紙を出さない(コメント欄よけ)┘
//   &skip=1        起動時に溜まっている未再生分を飛ばして最新から始める
//   &speed=2       演出の速さ(テスト用)
//   &preview=1     プレビュー用。開いた後に届いた分だけ再生し、再生位置を保存しない
//   &demo=1        見本を繰り返し再生する(Firebase に接続しない)。gacha / roulette で片方だけ
//   &guide=1       コメント欄の目安と safe の線を表示する(調整用。配信には使わない)
//   &debug=1       画面の大きさ・倍率を左下に表示する
//   &soft=2        配信映像で文字がギザギザに崩れる時の対策(1〜5)。縮小前にごく軽くぼかして崩れを防ぐ
// ============================================================
import { getEnv } from './env.js';
import { playGacha } from './play-gacha.js';
import { playGachaImage } from './play-gacha-image.js';
import { playRoulette } from './play-roulette.js';
import { loadTheme, fitText } from './theme.js';
import { parseLayout, fitPanel } from './layout.js';
import { rarityColor, sleep } from './visual.js';

// Firebase(js/store.js)は demo のときは読み込まない(接続できない環境でも見本を表示できるように)
let store = null;

const params = new URLSearchParams(location.search);
const env = getEnv();
const speed = Math.min(5, Math.max(0.2, Number(params.get('speed')) || 1));
const preview = params.get('preview') === '1';
const demoParam = params.get('demo');
const demo = ['1', 'gacha', 'roulette'].includes(demoParam) ? demoParam : null;
const guide = params.get('guide') === '1';
const debug = params.get('debug') === '1' || (demo && !guide);
// 配信用に大きく縮小される時、細い線が飛び飛びに拾われて文字が崩れるのを防ぐための、ごく軽いぼかし
const soft = Math.min(5, Math.max(0, Number(params.get('soft')) || 0));
const layout = parseLayout(params);

const ROLL_GAP_MS = 500 / speed;      // 連続抽選の間隔
const RESULT_HOLD_MS = 1600 / speed;  // 1回ごとの結果を見せる時間
const TAIL_MS = 2600 / speed;         // 全部終わった後に表示しておく時間

const stage = document.getElementById('stage');
const slotEl = document.getElementById('event-slot');
const eventEl = document.getElementById('event');
const senderEl = document.getElementById('ev-sender');
const giftEl = document.getElementById('ev-gift');
const titleEl = document.getElementById('ev-title');
const countEl = document.getElementById('ev-count');
const playEl = document.getElementById('ev-play');
const resultsEl = document.getElementById('ev-results');
const pendingEl = document.getElementById('pending');
const noticeEl = document.getElementById('notice');
const debugEl = document.getElementById('debug');

function notice(text) {
  noticeEl.hidden = !text;
  noticeEl.textContent = text || '';
}

// ---------------- テーマ ----------------
// 画像テーマの CSS・画像・フォントを読み込み終わってから再生を始める(崩れた見た目を出さない)
let theme = null;
const themeReady = layout.theme
  ? loadTheme(layout.theme)
    .then((t) => { theme = t; })
    .catch((err) => { console.error(err); notice(`テーマを読み込めません: ${err.message}`); })
  : Promise.resolve();

// ---------------- 画面全体の拡縮 ----------------
// zoom は文字を目的の大きさで描き直すので、縮小・拡大してもぼやけない。
// zoom が使えない古いブラウザだけ transform で代用する。
const useZoom = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('zoom', '0.5');
let lastFit = null; // 直近の台紙の倍率(debug 表示用)

function renderDebug() {
  if (!debug) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const scale = window.__stageScale;
  const dpr = window.devicePixelRatio || 1;
  const lines = [
    `表示領域 ${w}×${h}  倍率 ${scale.toFixed(2)}  DPR ${dpr}`,
    `実際の描画 ${Math.round(1080 * scale * dpr)}×${Math.round(1920 * scale * dpr)}px  soft ${soft}`,
  ];
  if (lastFit) {
    lines.push(`台紙 ${Math.round(lastFit.zoom * 100)}%  下端 ${lastFit.bottom}px${lastFit.shrunk ? '(コメント欄よけで縮小)' : ''}`);
  }
  if (w > h) lines.push('⚠ 横長です。Web ソースを縦長(例 1080×1920)にしてください');
  else if (scale * dpr < 0.9) lines.push('⚠ 小さく描画されています。Web ソースの幅・高さを大きくしてください');
  debugEl.hidden = false;
  debugEl.textContent = lines.join('\n');
}

function fit() {
  const scale = Math.min(window.innerWidth / 1080, window.innerHeight / 1920);
  window.__stageScale = scale;
  if (useZoom) stage.style.zoom = String(scale);
  else stage.style.transform = `scale(${scale})`;
  // soft 1 段階 ≒ 実際の画素で約1px 分のぼかし(倍率・画素密度に関係なく同じ効き方にする)
  const dpr = window.devicePixelRatio || 1;
  stage.style.filter = soft > 0 ? `blur(${(soft / (scale * dpr)).toFixed(3)}px)` : '';
  renderDebug();
}
window.addEventListener('resize', fit);
fit();

if (env === 'test' || demo) {
  const badge = document.getElementById('env-badge');
  badge.hidden = false;
  if (demo) badge.textContent = 'DEMO';
}

// 調整用: コメント欄の目安と、台紙を出してよい下端(safe)の線
if (guide) {
  const g = document.getElementById('guide');
  g.hidden = false;
  g.style.setProperty('--safe', `${layout.safeBottom}px`);
}

// ---------------- 台紙の大きさ・位置 ----------------
// 結果の欄は最大件数ぶんの高さを先に確保しておき、台紙の高さが再生中に変わらないようにする。
// その最大の高さで safe の線を越えないよう、台紙の倍率を決める。
const maxChips = () => 2;

function applyPanelLayout(mode) {
  const m = layout[mode] || layout.gacha;
  // 結果の欄に最大件数ぶんの見本を入れて高さを測る
  resultsEl.style.minHeight = '';
  const samples = Array.from({ length: maxChips() }, () => {
    const li = document.createElement('li');
    li.className = 'chip';
    li.textContent = 'R 見本の結果';
    return li;
  });
  resultsEl.replaceChildren(...samples);
  eventEl.style.zoom = '';
  eventEl.style.transform = '';
  const reserved = resultsEl.offsetHeight;
  const natural = eventEl.offsetHeight;
  resultsEl.replaceChildren();
  resultsEl.style.minHeight = `${reserved}px`;

  lastFit = fitPanel(m, natural, layout.safeBottom);
  slotEl.style.top = `${m.top}px`;
  if (useZoom) eventEl.style.zoom = String(lastFit.zoom);
  else eventEl.style.setProperty('--panel-scale', String(lastFit.zoom));
  renderDebug();
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

// 結果は1件1行で新しいものを最大2件まで並べる。それより前は件数だけ表示する
let hiddenChips = 0;
let countBase = '';

function renderCount() {
  countEl.textContent = hiddenChips > 0 ? `${countBase}  (前の結果 ほか${hiddenChips}件)` : countBase;
}

function addChip(roll) {
  const li = document.createElement('li');
  li.className = 'chip';
  li.style.setProperty('--rarity', rarityColor(roll.rarity, roll.color));
  const r = document.createElement('span');
  r.className = 'chip__rarity';
  r.textContent = roll.rarity || 'N';
  li.append(r, document.createTextNode(roll.label));
  const chips = resultsEl.querySelectorAll('.chip');
  if (chips.length >= maxChips()) {
    chips[0].remove();
    hiddenChips++;
  }
  resultsEl.append(li);
  renderCount();
}

async function playItem(item) {
  const rolls = Array.isArray(item.rolls) ? item.rolls : Object.values(item.rolls || {});
  const pool = Array.isArray(item.pool) ? item.pool : Object.values(item.pool || {});
  if (rolls.length === 0) return;
  const mode = item.mode === 'roulette' ? 'roulette' : 'gacha';

  eventEl.dataset.mode = mode;
  senderEl.textContent = `${item.sender || '視聴者'} さん`;
  giftEl.textContent = item.repeatCount > 1 ? `${item.giftName} ×${item.repeatCount}` : item.giftName;
  titleEl.textContent = item.title || '';
  hiddenChips = 0;
  countBase = rolls.length > 1 ? `1 / ${rolls.length} 回目` : '';
  renderCount();
  playEl.replaceChildren();
  if (theme) {
    // タイトル帯・名前は1行に収まるまで文字を小さくする(収まらなければ末尾を … にする)
    fitText(titleEl, 50, 28, { oneLine: true });
    fitText(senderEl, 64, 38, { oneLine: true });
  }
  applyPanelLayout(mode);
  eventEl.classList.add('show');
  await sleep(350);

  for (let i = 0; i < rolls.length; i++) {
    countBase = rolls.length > 1 ? `${i + 1} / ${rolls.length} 回目` : '';
    renderCount();
    if (mode === 'roulette') await playRoulette(playEl, rolls[i], pool, { speed, theme });
    else if (theme) await playGachaImage(playEl, rolls[i], { speed, theme });
    else await playGacha(playEl, rolls[i], { speed });
    addChip(rolls[i]);
    await sleep(RESULT_HOLD_MS);
    if (i < rolls.length - 1) await sleep(ROLL_GAP_MS);
  }

  countBase = rolls.length > 1 ? `結果 ${rolls.length} 件` : '';
  renderCount();
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
    if (!preview && !demo) {
      try { await store.setCursor(env, key); } catch (err) { console.error('再生位置の保存に失敗', err); }
    }
  }
  eventEl.classList.remove('show');
  playing = false;
}

// ---------------- 見本の繰り返し再生(demo) ----------------
const DEMO_POOL = ['釣り', '虫とり', '料理', 'ガーデニング', '鳥の観察', '貝がら集め', '家具づくり', '視聴者におまかせ']
  .map((label) => ({ label, weight: 1, rarity: 'N', color: '' }));
const DEMO_POOL_MANY = [
  ['釣り', 3], ['虫とり', 3], ['料理', 2], ['ガーデニング', 2], ['鳥の観察', 2], ['貝がら集め', 1],
  ['家具づくり', 1], ['住民にあいさつ', 1], ['料理を1品作って住民にプレゼント', 1], ['走るの禁止', 1], ['お昼寝', 0.5], ['おまかせ', 0.5],
].map(([label, weight]) => ({ label, weight, rarity: 'N', color: '' }));
const DEMO_ITEMS = [
  {
    giftName: 'Rose', sender: 'みほん', repeatCount: 1, mode: 'roulette', title: '次にやること',
    rolls: [{ label: 'ガーデニング', rarity: 'N' }], pool: DEMO_POOL,
  },
  {
    giftName: 'Finger Heart', sender: 'ためしユーザー', repeatCount: 2, mode: 'gacha', title: '縛りガチャ',
    rolls: [{ label: '魚を3匹釣るまで他の行動禁止', rarity: 'R' }, { label: '視聴者のリクエストを1つ実行', rarity: 'SSR' }],
    pool: [],
  },
  {
    // 長い文言・長い名前で文字が枠からはみ出さないかの確認用
    giftName: 'Galaxy', sender: 'とても長いお名前のテストユーザーさま', repeatCount: 1, mode: 'gacha', title: 'ハートピア縛りガチャ',
    rolls: [{ label: '次の15分はコメントで指示された場所へ移動し、到着したら住民全員にあいさつする', rarity: 'SR' }],
    pool: [],
  },
  {
    // 候補が多く確率もばらばらなルーレット
    giftName: 'Doughnut', sender: 'たくさん候補', repeatCount: 1, mode: 'roulette', title: '行動ルーレット',
    rolls: [{ label: '料理を1品作って住民にプレゼント', rarity: 'R' }], pool: DEMO_POOL_MANY,
  },
];

async function startDemo() {
  const items = demo === '1' ? DEMO_ITEMS : DEMO_ITEMS.filter((it) => it.mode === demo);
  for (let i = 0; ; i++) {
    queue.push({ key: `demo${i}`, item: items[i % items.length] });
    await drain();
    await sleep(1500);
  }
}

// ---------------- 起動 ----------------
async function start() {
  await themeReady;
  if (demo) return startDemo();
  store = await import('./store.js');
  const {
    isConfigured, watchConfig, watchConnection, getCursor, setCursor,
    latestQueueKey, watchQueueAfter,
  } = store;

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
