// ============================================================
// js/display.js  表示画面(PRISM LIVE に重ねるページ)
// ------------------------------------------------------------
// Worker がキューに積んだ結果を、届いた順に1件ずつ最後まで再生する。
// 抽選はしない。再生が終わるたびに「どこまで再生したか」を Worker 経由で保存するので、
// ページを読み込み直しても続きから再生され、二重再生も取りこぼしも起きない。
// 同じ環境で再生するのは「再生担当」の表示画面1つだけ(js/player.js)。ほかの画面は待機する。
//
// URL パラメータ
//   ?env=prod      本番のキューを再生(省略時はテスト)
//   &dk=合言葉     表示用の合言葉(Worker の DISPLAY_KEY_PROD / DISPLAY_KEY_TEST)。再生担当・再生位置の保存に使う
//   &w=URL         Worker の URL(js/config.js の DEFAULT_WORKER_URL があれば省略可)
//   &theme=wafu    画像テーマ(images/themes/<名前>/)。省略時は従来のデザイン
//   &g=110,100     ガチャの台紙の上端(px)・大きさ(%)     ┐ 管理画面の「表示の調整」で作る
//   &r=110,100     ルーレットの台紙の上端(px)・大きさ(%) │ (js/layout.js)
//   &safe=1100     これより下に台紙を出さない(コメント欄よけ)┘
//   &skip=1        起動時に溜まっている未再生分を飛ばして最新から始める
//   &speed=2       演出の速さ(テスト用)
//   &preview=1     プレビュー用。開いた後に届いた分だけ再生し、再生位置を保存しない
//   &demo=1        見本を繰り返し再生する(Firebase に接続しない)。gacha / roulette で片方だけ
//   &rarity=SSR    見本の結果のレア度をそろえる(レア度別の演出の確認用。demo のときだけ)
//   &guide=1       コメント欄の目安と safe の線を表示する(調整用。配信には使わない)
//   &debug=1       画面の大きさ・倍率を左下に表示する
//   &soft=2        配信映像で文字がギザギザに崩れる時の対策(1〜5)。縮小前にごく軽くぼかして崩れを防ぐ
// ============================================================
import { getEnv } from './env.js';
import { playGacha } from './play-gacha.js';
import { playGachaImage } from './play-gacha-image.js';
import { playRoulette } from './play-roulette.js';
import { loadTheme, fitText, themeRarityColor } from './theme.js';
import { parseLayout, fitPanel, textBoost } from './layout.js';
import { rarityColor, sleep } from './visual.js';
import { createPlayer, playerParams } from './player.js';
import { advanceTimers } from '../shared/restraint-timers.js';

// Firebase(js/store.js)は demo のときは読み込まない(接続できない環境でも見本を表示できるように)
let store = null;
let player = null; // 再生担当(preview・demo では使わない)

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
const restraintEl = document.getElementById('restraint-overlay');
let restraintState = null;
function renderRestraintOverlay() {
  if (!restraintEl) return;
  if (!restraintState || demo || preview) { restraintEl.hidden = true; return; }
  const current = advanceTimers(restraintState, Date.now());
  const entries = (current.entries || []).filter((x) => x.status === 'active' || x.status === 'waiting');
  restraintEl.hidden = entries.length === 0;
  const cards = entries.slice(0, 4).map((x) => {
    const remaining = Math.max(0, Number(x.remainingMs || 0));
    const secs = Math.ceil(remaining / 1000);
    const row = document.createElement('div');
    row.className = 'restraint-row' +
      (x.status === 'waiting' ? ' waiting' : x.group === 'parallel' ? ' parallel' : '') +
      (current.paused ? ' paused' : '');
    const top = document.createElement('div'); top.className = 'restraint-top';
    const label = document.createElement('div');
    label.className = 'restraint-label'; label.textContent = x.label;
    const status = document.createElement('span'); status.className = 'restraint-state';
    status.textContent = current.paused ? '停止中' : x.status === 'waiting' ? '待機中' : x.group === 'parallel' ? '並行中' : '実行中';
    top.append(label, status);
    const bottom = document.createElement('div'); bottom.className = 'restraint-bottom';
    const bar = document.createElement('div'); bar.className = 'restraint-progress';
    const fill = document.createElement('span'); fill.className = 'restraint-progress-fill';
    const initial = Math.max(1, Number(x.totalMs || x.remainingMs || 1));
    fill.style.width = Math.max(0, Math.min(100, remaining / initial * 100)) + '%';
    bar.append(fill);
    const clock = document.createElement('span'); clock.className = 'restraint-clock';
    clock.textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
    bottom.append(bar, clock); row.append(top, bottom); return row;
  });
  if (entries.length > 4) {
    const more = document.createElement('div'); more.className = 'restraint-more';
    more.textContent = `ほか ${entries.length - 4} 件の縛り`;
    cards.push(more);
  }
  restraintEl.replaceChildren(...cards);
}
setInterval(renderRestraintOverlay, 1000);
async function awardRestraint(key, index) {
  if (!player || !player.active || !player.canPlay()) throw new Error('再生担当の接続が切れています');
  const p = playerParams(params);
  const url = new URL(p.workerUrl + '/display/restraints?env=' + env);
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dk: p.displayKey, type: 'award', key, index }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '縛りタイマーの登録に失敗しました');
}

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
let boost = 1; // 縮めたときに結果の文字に掛けている倍率(--text-boost)

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
    lines.push(`台紙 ${Math.round(lastFit.zoom * 100)}%  下端 ${lastFit.bottom}px${lastFit.shrunk ? '(コメント欄よけで縮小)' : ''}${boost > 1 ? `  結果の文字 ×${boost.toFixed(2)}` : ''}`);
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
  // コメント欄よけを使わない設定(safe=0)でも、コメント欄の目安(1400px より下)は表示する
  g.style.setProperty('--safe', `${layout.safeBottom || 1400}px`);
  g.querySelector('.guide__safe').hidden = !layout.safeBottom;
}

// 画像テーマで台紙を出さない設定(panel=0)
if (layout.theme && !layout.panel) document.body.classList.add('no-panel');

// ---------------- 台紙の大きさ・位置 ----------------
// コメント欄よけ(safe)を使う場合は、結果の欄に最大件数ぶんの高さを先に確保しておき、
// 台紙の高さが再生中に変わらないようにしたうえで、safe の線を越えない倍率を決める。
// 結果の並べ方: 従来デザインは以前と同じ(横に並べて最大3件+「ほか N 件」)。
//               画像テーマは1件1行で最大2件、それより前は件数だけ表示。
const legacyChips = !layout.theme;
const maxChips = () => (legacyChips ? 3 : 2);

function applyPanelLayout(mode) {
  boost = 1;
  const m = layout[mode] || layout.gacha;
  resultsEl.replaceChildren(); // 前の結果を消す(コメント欄よけの有無に関係なく)
  resultsEl.style.minHeight = '';
  eventEl.style.zoom = '';
  eventEl.style.transform = '';
  eventEl.style.removeProperty('--text-boost');
  slotEl.style.top = `${m.top}px`;
  if (!layout.safeBottom) {
    lastFit = fitPanel(m, 0, 0);
    if (useZoom) eventEl.style.zoom = String(lastFit.zoom);
    else eventEl.style.setProperty('--panel-scale', String(lastFit.zoom));
    renderDebug();
    return;
  }
  // 結果の欄に最大件数ぶんの見本を入れて高さを測る
  const measure = () => {
    const samples = Array.from({ length: maxChips() }, () => {
      const li = document.createElement('li');
      li.className = 'chip';
      li.textContent = 'R 見本の結果';
      return li;
    });
    resultsEl.replaceChildren(...samples);
    const reserved = resultsEl.offsetHeight;
    const natural = eventEl.offsetHeight;
    resultsEl.replaceChildren();
    return { reserved, natural };
  };
  let { reserved, natural } = measure();
  lastFit = fitPanel(m, natural, layout.safeBottom);
  // 画像テーマ: 縮めた分だけ結果の文字を大きくし(上限あり)、大きくした文字で測り直す
  boost = layout.theme ? textBoost(lastFit, m) : 1;
  if (boost > 1) {
    eventEl.style.setProperty('--text-boost', boost.toFixed(3));
    ({ reserved, natural } = measure());
    lastFit = fitPanel(m, natural, layout.safeBottom);
  }
  resultsEl.style.minHeight = `${reserved}px`;
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

let hiddenChips = 0;
let countBase = '';

function renderCount() {
  countEl.textContent = hiddenChips > 0 && !legacyChips ? `${countBase}  (前の結果 ほか${hiddenChips}件)` : countBase;
}

/**
 * 結果の一覧に1件足す。inCard のときは、その結果が結果カードに出ているあいだ一覧では隠す
 * (同じ景品名・レア度を2か所に出さない。次の抽選が始まったら showCardChips で一覧に出す)
 */
function addChip(roll, { inCard = false } = {}) {
  const li = document.createElement('li');
  li.className = 'chip';
  // 画像テーマはテーマのレア度の色(バッジ・札・演出と同じ色)
  li.style.setProperty('--rarity', theme ? themeRarityColor(theme, roll.rarity, roll.color) : rarityColor(roll.rarity, roll.color));
  if (theme) li.dataset.rarity = String(roll.rarity || 'N').toUpperCase();
  const r = document.createElement('span');
  r.className = 'chip__rarity';
  r.textContent = roll.rarity || 'N';
  if (legacyChips) {
    li.append(r, document.createTextNode(roll.label));
  } else {
    // 画像テーマ: 結果の文字は枠の中で流せるよう、入れ物に入れる(長いときに末尾が切れないように)
    const text = document.createElement('span');
    text.className = 'chip__text';
    const inner = document.createElement('span');
    inner.className = 'chip__scroll';
    inner.textContent = roll.label;
    text.append(inner);
    li.append(r, text);
  }
  const chips = resultsEl.querySelectorAll('.chip:not(.chip--more)');
  if (chips.length >= maxChips()) {
    chips[0].remove();
    hiddenChips++;
  }
  if (legacyChips) {
    // 従来デザイン: 先頭に「ほか N 件」の札を置く(以前と同じ)
    resultsEl.querySelector('.chip--more')?.remove();
    if (hiddenChips > 0) {
      const more = document.createElement('li');
      more.className = 'chip chip--more';
      more.textContent = `ほか ${hiddenChips} 件`;
      resultsEl.prepend(more);
    }
  }
  if (inCard) li.classList.add('chip--in-card');
  resultsEl.append(li);
  if (!inCard) fitChip(li);
  renderCount();
}

// 画像テーマ: 縮めて文字を大きくしているとき、長い結果は1行に収まるところまで小さくする
// (縮める前の大きさより小さくはしない)。それでも入らなければ、ゆっくり横に流して全部見せる
function fitChip(li) {
  if (legacyChips) return;
  const text = li.querySelector('.chip__text');
  const base = parseFloat(getComputedStyle(text).fontSize);
  fitText(text, base, boost > 1 ? Math.round(base / boost) : base, { oneLine: true });
  marqueeIfLong(text);
}

/** 結果カードが消えたら(次の抽選・次の項目)、カードに出ていた結果を一覧に出す */
function showCardChips() {
  eventEl.classList.remove('event--card', 'event--keep-sender');
  for (const li of resultsEl.querySelectorAll('.chip--in-card')) {
    li.classList.remove('chip--in-card');
    fitChip(li);
  }
}

/** 1行に入りきらない文字を、左右にゆっくり流して全部読めるようにする(画像テーマの結果の一覧) */
function marqueeIfLong(box) {
  const inner = box.firstElementChild;
  const over = inner.offsetWidth - box.clientWidth;
  if (over <= 1) return;
  box.classList.add('is-marquee');
  inner.style.setProperty('--marquee-x', `${-Math.ceil(over + 8)}px`);
  // 流れる部分(1周の 44%)を秒速 160px ほどにする。最初と端で少し止まる
  inner.style.setProperty('--marquee-time', `${Math.max(5, over / 160 / 0.44).toFixed(1)}s`);
}

/** 送信者名。画像テーマでは、1行で入りきらない長い名前を2行に分けて末尾まで見せる */
function showSender(name) {
  if (!theme) {
    senderEl.textContent = `${name} さん`;
    return;
  }
  const n = document.createElement('span');
  n.className = 'event__name';
  n.textContent = name;
  const hon = document.createElement('span');
  hon.className = 'event__honorific';
  hon.textContent = ' さん';
  senderEl.classList.remove('is-2line');
  senderEl.replaceChildren(n, hon);
  fitText(senderEl, theme?.name === 'wafu' ? 52 : 64, theme?.name === 'wafu' ? 30 : 44, { oneLine: true });
  // 1px 未満のはみ出しでも末尾が「…」になるので、文字の実際の幅で判断する
  const textW = n.getBoundingClientRect().width + hon.getBoundingClientRect().width;
  if (textW > senderEl.getBoundingClientRect().width - 0.5) {
    // 2行に収まる大きさまで小さくする(明朝体は字面が行からわずかにはみ出すので、行数で判断する)
    senderEl.classList.add('is-2line');
    for (let size = 56; size >= 30; size -= 2) {
      senderEl.style.fontSize = `${size}px`;
      const lineH = parseFloat(getComputedStyle(senderEl).lineHeight) || size * 1.32;
      if (senderEl.scrollHeight <= lineH * 2.5 && senderEl.scrollWidth <= senderEl.clientWidth + 1) break;
    }
  }
}

async function playItem(item, key) {
  const rolls = Array.isArray(item.rolls) ? item.rolls : Object.values(item.rolls || {});
  const pool = Array.isArray(item.pool) ? item.pool : Object.values(item.pool || {});
  if (rolls.length === 0) return;
  const mode = item.mode === 'roulette' ? 'roulette' : 'gacha';

  eventEl.dataset.mode = mode;
  eventEl.classList.remove('event--card', 'event--keep-sender'); // 前の項目の結果カードの表示をやめ、見出しの送信者名を出す
  showSender(item.sender || '視聴者');
  giftEl.textContent = item.repeatCount > 1 ? `${item.giftName} ×${item.repeatCount}` : item.giftName;
  titleEl.textContent = item.title || '';
  hiddenChips = 0;
  countBase = rolls.length > 1 ? `1 / ${rolls.length} 回目` : '';
  renderCount();
  playEl.replaceChildren();
  if (theme) {
    // タイトル帯は1行に収まるまで文字を小さくする(収まらなければ末尾を … にする)
    fitText(titleEl, 50, 28, { oneLine: true });
    // 項目ごとに、タイトル帯に光が1回走る(theme.css の .sheen)
    titleEl.classList.remove('sheen');
    void titleEl.offsetWidth;
    titleEl.classList.add('sheen');
  }
  applyPanelLayout(mode);
  eventEl.classList.add('show');
  await sleep(350);

  for (let i = 0; i < rolls.length; i++) {
    countBase = rolls.length > 1 ? `${i + 1} / ${rolls.length} 回目` : '';
    renderCount();
    showCardChips();
    if (mode === 'roulette') {
      // 和風の横長の結果カード: カードが出たら景品名・レア度(と送信者名)はカードの中だけに出す。
      // 景品名が長くてカードに送信者名を入れられなかったときは、見出しの送信者名を残す
      await playRoulette(playEl, rolls[i], pool, {
        speed, theme, size: theme?.name === 'wafu' ? 680 : undefined, sender: item.sender || '視聴者',
        onCard: ({ sender } = {}) => {
          eventEl.classList.add('event--card');
          eventEl.classList.toggle('event--keep-sender', !sender);
        },
      });
    }
    else if (theme) {
      // 和風の結果カード: カードが出たら、送信者名・景品名・レア度はカードの中だけに出す(theme.css の .event--card)
      await playGachaImage(playEl, rolls[i], {
        speed, theme, sender: item.sender || '視聴者',
        onCard: () => { if (theme.resultCard) eventEl.classList.add('event--card'); },
      });
    } else await playGacha(playEl, rolls[i], { speed });
    if (mode === 'roulette' && rolls[i].timer && key && !preview && !demo) {
      // 失敗した場合は再生位置を進めない。再試行時もWorker側のイベントIDで二重加算を防ぐ。
      await awardRestraint(key, i);
    }
    addChip(rolls[i], { inCard: eventEl.classList.contains('event--card') });
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
    // 再生担当が Worker と通信できていないあいだは、新しい再生を始めない(二重再生を避ける)
    while (player && player.active && !player.canPlay()) await sleep(1000);
    if (player && !player.active) break;
    const { key, item } = queue.shift();
    updatePending();
    try {
      if (!isStale(item)) await playItem(item, key);
    } catch (err) {
      console.error('再生に失敗しました', err);
      // タイマー付き結果を取りこぼさないよう、失敗した抽選は再試行する。
      if (item?.mode === 'roulette' && (Array.isArray(item.rolls) ? item.rolls : Object.values(item.rolls || {})).some((r) => r.timer)) {
        queue.unshift({ key, item });
        updatePending();
        await sleep(5000);
        continue;
      }
    }
    // 失敗しても先に進む(同じ項目で止まり続けないように)。保存は裏でやり直し続ける
    if (player) player.saveCursor(key);
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

// &rarity=SSR … 見本の結果のレア度をそろえる(レア度別の演出の確認用)
const demoRarity = /^(N|R|SR|SSR)$/.test(params.get('rarity') || '') ? params.get('rarity') : '';

async function startDemo() {
  let items = demo === '1' ? DEMO_ITEMS : DEMO_ITEMS.filter((it) => it.mode === demo);
  if (demoRarity) items = items.map((it) => ({ ...it, rolls: it.rolls.map((r) => ({ ...r, rarity: demoRarity })) }));
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
  const { isConfigured, watchConfig, watchConnection, latestQueueKey, watchQueueAfter } = store;

  if (!isConfigured()) {
    notice('js/config.js に Firebase の接続情報を設定してください');
    return;
  }

  watchConnection((ok) => setStatus('firebase', ok ? '' : 'Firebase に接続できません'));
  watchConfig(env, (config) => { settings = { staleMinutes: 10, ...config.settings }; });
  if (!preview) store.watchRestraints(env, (value) => { restraintState = value; renderRestraintOverlay(); });

  const follow = (cursor) => {
    const seen = new Set();
    return watchQueueAfter(env, cursor, (key, item) => {
      if (seen.has(key) || !item) return;
      seen.add(key);
      queue.push({ key, item });
      updatePending();
      drain();
    });
  };

  // プレビュー(管理・テスト画面の確認用)は再生担当にならず、開いた後に届いた分だけ再生する
  if (preview) {
    follow(await latestQueueKey(env));
    return;
  }

  // 再生担当になってから再生する。担当でなくなったら止めて、また担当になれるまで待つ
  let skipOnce = params.get('skip') === '1';
  let lost = () => {};
  player = createPlayer({
    env,
    ...playerParams(params),
    onStatus: (s) => {
      document.body.dataset.player = s.kind; // 状態の確認用(画面には出ない)
      setStatus('player', playerMessage(s));
    },
    onLost: () => lost(),
  });
  window.addEventListener('pagehide', () => player.release());
  for (;;) {
    let saved;
    try {
      ({ cursor: saved } = await player.acquire());
    } catch {
      return; // URL の設定不足(画面に案内を出している)
    }
    let cursor = skipOnce ? null : saved;
    skipOnce = false;
    if (!cursor) {
      // 初回(または skip)は、今あるキューは再生済みとして扱い、これから届く分だけ再生する
      cursor = await latestQueueKey(env);
      if (cursor) player.saveCursor(cursor);
    }
    const stopLost = new Promise((resolve) => { lost = resolve; });
    const unwatch = follow(cursor);
    await stopLost;
    unwatch();
    queue.length = 0;
    updatePending();
  }
}

// ---------------- 状態の表示 ----------------
// 設定の誤り・接続の問題は画面に出す。待機中は配信に映さない(debug=1 のときだけ表示)
const statuses = { firebase: '', player: '' };
function setStatus(kind, text) {
  statuses[kind] = text || '';
  notice(statuses.firebase || statuses.player);
}
function playerMessage(s) {
  if (s.kind === 'error') return s.message;
  if (s.kind === 'offline') return debug ? s.message : '';
  if (s.kind === 'standby') return debug ? s.message : '';
  return '';
}

start().catch((err) => {
  console.error(err);
  notice(`起動に失敗しました: ${err.message}`);
});
