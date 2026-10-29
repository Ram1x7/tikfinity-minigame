import { todoSorted } from '../shared/gacha-todo.js';
import { advanceTimers } from '../shared/restraint-timers.js';
// ============================================================
// js/admin.js  管理画面
// ------------------------------------------------------------
// 設定は Firebase から読み、保存は Worker 経由で行う(ブラウザから直接は書き込まない)。
// 編集中の内容は「保存」を押すまでこの画面の中だけに保持する。
// ============================================================
import { getEnv, envLabel, SELECTABLE_ENVS, IS_PREVIEW_SITE, urlWithEnv } from './env.js';
import { isConfigured, loadConfig, watchRecentLog, watchConnection, watchDisplayState, watchRestraints, watchGachaTodo } from './store.js';
import { getConnection, saveConnection, saveConfig, copyConfig, diagnose, releasePlayer, controlRestraints, controlGachaTodo } from './api.js';
import { h, toast, copyText, formatTime } from './dom.js';
import { SAMPLE_CONFIG } from './sample-config.js';
import { initLayoutEditor, loadSavedLayout, showStreamUrl, urlValue } from './layout-editor.js';
import {
  sanitizeConfig, probabilities, normalizeGift, DEFAULT_SETTINGS, RARITIES, LIMITS,
} from '../shared/core.js';

const env = getEnv();
const $ = (id) => document.getElementById(id);

let state = { gifts: [], tables: [], settings: { ...DEFAULT_SETTINGS } };
let dirty = false;

// ---------------- 共通 ----------------
function markDirty() {
  dirty = true;
  $('dirty').hidden = false;
}
function markClean() {
  dirty = false;
  $('dirty').hidden = true;
}
window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

const newTableId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function fromStored(cfg) {
  return {
    gifts: Object.values(cfg.gifts || {}).map((g) => ({ ...g })),
    tables: Object.entries(cfg.tables || {}).map(([id, t]) => ({
      id, title: t.title || '', items: (t.items || []).map((it) => ({ ...it, timer: it.timer ? { ...it.timer, enabled: true, minutes: it.timer.minutes ?? it.timer.durationMs / 60000 } : null })),
    })),
    settings: { ...DEFAULT_SETTINGS, ...(cfg.settings || {}) },
  };
}

function toPayload() {
  return {
    gifts: state.gifts,
    tables: Object.fromEntries(state.tables.map((t) => [t.id, { title: t.title, items: t.items }])),
    settings: state.settings,
  };
}

// ---------------- 環境の切り替え・URL案内 ----------------
function renderHeader() {
  const nav = $('env-switch');
  nav.replaceChildren(
    ...SELECTABLE_ENVS.map((e) => h('a', {
      href: urlWithEnv(e),
      class: `env-switch__item${e === env ? ' is-active' : ''} env-${e}`,
    }, envLabel(e)))
  );
  $('env-warning').hidden = env !== 'prod';
  $('copy-to-prod').hidden = env !== 'test';
  document.title = `管理画面(${envLabel(env)})`;
  // プレビューサイトでは、テスト専用の環境につながっていることを示す
  if (IS_PREVIEW_SITE) nav.append(h('span', { class: 'env-switch__item env-preview' }, 'プレビュー(テスト専用)'));
}

let currentLayout = loadSavedLayout();

function renderUrls() {
  const { workerUrl } = getConnection();
  showStreamUrl($('url-display'), env, currentLayout); // 画面では合言葉を伏せる
  $('url-webhook').textContent = workerUrl
    ? `${workerUrl}/webhook?env=${env}&k=合言葉`
    : '(先に「接続設定」で Worker の URL を入力してください)';
}

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => copyText(urlValue($(btn.dataset.copy))));
});

// ---------------- 接続設定 ----------------
function renderConnection() {
  const c = getConnection();
  $('conn-url').value = c.workerUrl;
  $('conn-key').value = c.adminKey;
  $('conn-dk-prod').value = c.displayKeys.prod;
  $('conn-dk-test').value = c.displayKeys.test;
  const missing = [];
  if (!isConfigured()) missing.push('js/config.js の Firebase 接続情報');
  if (!c.workerUrl) missing.push('Worker の URL');
  if (!c.adminKey) missing.push('管理用の合言葉');
  if (!c.displayKeys[env]) missing.push(`表示用の合言葉(${envLabel(env)})`);
  $('conn-status').textContent = missing.length ? `未設定: ${missing.join('、')}` : '設定済み';
  if (missing.length) $('conn-card').open = true;
}

$('conn-test').addEventListener('click', async () => {
  const btn = $('conn-test');
  const list = $('conn-checks');
  btn.disabled = true;
  list.replaceChildren(h('li', { class: 'hint' }, '確認中…'));
  try {
    const results = await diagnose($('conn-url').value, $('conn-key').value);
    if (!isConfigured()) results.unshift({ ok: false, label: 'js/config.js', detail: 'Firebase の接続情報が入っていません' });
    list.replaceChildren(...results.map((r) => h('li', { class: `check check--${r.ok === true ? 'ok' : r.ok === false ? 'ng' : 'unknown'}` },
      h('span', { class: 'check__mark' }, r.ok === true ? '✓' : r.ok === false ? '✗' : '?'),
      h('span', { class: 'check__label' }, r.label),
      r.detail ? h('span', { class: 'check__detail' }, r.detail) : null)));
  } finally {
    btn.disabled = false;
  }
});

$('conn-save').addEventListener('click', () => {
  saveConnection({
    workerUrl: $('conn-url').value,
    adminKey: $('conn-key').value,
    displayKeys: { prod: $('conn-dk-prod').value, test: $('conn-dk-test').value },
  });
  renderConnection();
  renderUrls();
  toast('接続設定を保存しました');
});

// ---------------- 表示画面の再生担当 ----------------
let playerState = {};
function renderPlayer() {
  const p = playerState.player;
  const now = Date.now();
  let text;
  if (!p) text = '担当なし(次に開いた表示画面が担当になります)';
  else if (p.expiresAt > now) text = `担当あり: 画面 ${String(p.id).slice(-6)}(${formatTime(p.since)} から。応答あり)`;
  else text = `担当の応答なし(期限切れ。次に要求した表示画面が引き継ぎます): 画面 ${String(p.id).slice(-6)}`;
  $('player-status').textContent = text;
  $('player-release').disabled = !p;
}

$('player-release').addEventListener('click', async () => {
  const message = [
    `${envLabel(env)}の再生担当を外します。`,
    '・いま再生している表示画面は待機に切り替わり、待機中の別の表示画面が10秒ほどで引き継ぎます。',
    '・待機中の表示画面が無い場合は、外した画面が30秒後に担当へ戻るまで、最大30秒ほど再生が止まります(その間に届いたギフトは、再開後に順番に再生されます)。',
    '',
    'よろしいですか?',
  ].join('\n');
  if (!confirm(message)) return;
  try {
    const r = await releasePlayer(env);
    toast(r.released ? '再生担当を外しました' : '担当はいませんでした');
  } catch (err) {
    toast(err.message, true);
  }
});


// ---------------- ギフトガチャのやることリスト ----------------
let todoSnapshot = {};
let todoBusy = false;
async function todoAction(body) {
  if (todoBusy) return;
  todoBusy = true;
  try { await controlGachaTodo(env, body); }
  catch (err) { toast(err.message, true); }
  finally { todoBusy = false; }
}
function renderGachaTodo() {
  const tasks = todoSorted(todoSnapshot);
  $('gacha-todo-count').textContent = `残り${tasks.length}件`;
  const list = $('gacha-todo-list');
  list.replaceChildren(...tasks.slice(0, 5).map((task, index) =>
    h('div', { class: 'item' },
      h('div', { class: 'item__row' },
        h('strong', {}, `${index + 1}. ${task.label}`),
        h('button', { class: 'btn btn--small btn--primary', onclick: () => todoAction({ type: 'finish', id: task.id }) }, '完了')),
      h('p', { class: 'hint' }, `${task.sender || '視聴者'}｜${task.giftName || 'ギフト'}`))
  ));
  if (tasks.length > 5) list.append(h('p', { class: 'hint' }, `さらに${tasks.length - 5}件が順番待ちです`));
  if (tasks.length === 0) list.append(h('p', { class: 'hint' }, '未完了のガチャはありません'));
}
$('gacha-todo-reset').addEventListener('click', () => {
  if (confirm('ギフトガチャの未完了リストをすべて削除します。元に戻せません。実行しますか？')) {
    todoAction({ type: 'reset-all' });
  }
});
watchGachaTodo(env, (value) => { todoSnapshot = value; renderGachaTodo(); });

// ---------------- 縛りタイマー管理 ----------------
let restraintSnapshot = null;
function timerTime(ms) {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
async function restraintAction(body) {
  try { await controlRestraints(env, body); }
  catch (err) { toast(err.message, true); }
}
$('restraint-pause').addEventListener('click', () => restraintAction({ type: 'pause-all' }));
$('restraint-resume').addEventListener('click', () => restraintAction({ type: 'resume-all' }));
$('restraint-reset').addEventListener('click', () => {
  if (confirm('実行中・待機中の縛りタイマーをすべて削除します。元には戻せません。リセットしますか？')) {
    restraintAction({ type: 'reset-all' });
  }
});
function renderRestraints() {
  const s = restraintSnapshot;
  $('restraint-status').textContent = !s ? 'タイマー未開始（初回は全再開してください）'
    : s.paused ? '全停止中' : 'カウント中';
  const list = $('restraint-list');
  const current = s ? advanceTimers(s, Date.now()) : null;
  list.replaceChildren(...(current?.entries || []).filter((x) => x.status !== 'done').map((x) => {
    const ms = Math.max(0, x.remainingMs || 0);
    return h('div', { class: 'item' },
      h('div', { class: 'item__row' },
        h('strong', {}, x.label),
        h('span', {}, x.status === 'waiting' ? '待機中' : x.group === 'parallel' ? '並行中' : '実行中'),
        h('strong', {}, timerTime(ms))),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn--small', onclick: () => restraintAction({ type: 'adjust', id: x.id, amountMs: 60000 }) }, '+1分'),
        h('button', { class: 'btn btn--small', onclick: () => restraintAction({ type: 'adjust', id: x.id, amountMs: -60000 }) }, '-1分'),
        h('button', { class: 'btn btn--small btn--danger', onclick: () => {
          if (confirm(`${x.label}を終了しますか？`)) restraintAction({ type: 'finish', id: x.id });
        } }, '終了')));
  }));
}
watchRestraints(env, (value) => { restraintSnapshot = value; renderRestraints(); });
setInterval(renderRestraints, 1000);

// ---------------- ギフト設定 ----------------
function select(options, value, onChange) {
  return h('select', { onchange: (e) => onChange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

function renderGifts() {
  const list = $('gift-list');
  const tableOptions = state.tables.map((t) => [t.id, t.title || '(無題のテーブル)']);
  if (tableOptions.length === 0) tableOptions.push(['', '(先に抽選テーブルを作ってください)']);

  const names = state.gifts.map((g) => g.giftName);
  list.replaceChildren(...state.gifts.map((g, index) => {
    const dup = g.giftName && names.indexOf(g.giftName) !== index;
    const comboN = h('label', { class: 'field', hidden: g.combo !== 'everyN' }, '何個ごとに1回',
      h('input', { type: 'number', min: 1, value: g.comboN ?? 1, oninput: (e) => { g.comboN = Number(e.target.value); markDirty(); } }));

    return h('div', { class: `item${g.enabled === false ? ' is-disabled' : ''}` },
      h('div', { class: 'item__row' },
        h('input', {
          class: 'item__name', type: 'text', placeholder: 'ギフト名(例: Rose)', value: g.giftName || '', maxLength: LIMITS.giftName,
          oninput: (e) => { g.giftName = e.target.value; markDirty(); },
          onchange: () => renderGifts(),
        }),
        h('label', { class: 'toggle' },
          h('input', { type: 'checkbox', checked: g.enabled !== false, onchange: (e) => { g.enabled = e.target.checked; markDirty(); renderGifts(); } }),
          '有効'),
        h('button', { class: 'btn btn--small btn--danger', title: '削除', onclick: () => {
          if (!confirm(`ギフト「${g.giftName || '(無名)'}」の設定を削除しますか?`)) return;
          state.gifts.splice(index, 1); markDirty(); renderGifts();
        } }, '削除')),
      dup ? h('p', { class: 'warn' }, '同じギフト名が複数あります。保存すると後の方が優先されます。') : null,
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, '演出',
          select([['gacha', 'ガチャ'], ['roulette', 'ルーレット']], g.mode || 'gacha', (v) => { g.mode = v; markDirty(); })),
        h('label', { class: 'field' }, '抽選テーブル',
          select(tableOptions, g.tableId, (v) => { g.tableId = v; markDirty(); })),
        h('label', { class: 'field' }, '画面に出すタイトル(任意)',
          h('input', { type: 'text', value: g.title || '', maxLength: LIMITS.title, placeholder: '空ならテーブル名', oninput: (e) => { g.title = e.target.value; markDirty(); } })),
        h('label', { class: 'field' }, '連続ギフト(コンボ)のとき',
          select([['once', '何個でも1回だけ抽選'], ['perCount', '個数ぶん抽選'], ['everyN', 'N個ごとに1回抽選']], g.combo || 'once', (v) => {
            g.combo = v; markDirty(); renderGifts();
          })),
        comboN,
        h('label', { class: 'field', hidden: (g.combo || 'once') === 'once' }, '1回の上限(回)',
          h('input', { type: 'number', min: 1, max: LIMITS.maxRolls, value: g.maxRolls ?? 10, oninput: (e) => { g.maxRolls = Number(e.target.value); markDirty(); } }))));
  }));
  if (state.gifts.length === 0) list.append(h('p', { class: 'hint' }, 'まだギフトがありません。'));
}

function addGift(name = '') {
  state.gifts.push({
    giftName: name, enabled: true, mode: 'gacha', tableId: state.tables[0]?.id || '',
    title: '', combo: 'once', comboN: 1, maxRolls: 10,
  });
  markDirty();
  renderGifts();
}
$('add-gift').addEventListener('click', () => addGift());

// ---------------- 抽選テーブル ----------------
function updateProbabilities(table, cells) {
  probabilities(table.items).forEach((p, i) => {
    if (cells[i]) cells[i].textContent = `${p.toFixed(p < 1 && p > 0 ? 2 : 1)}%`;
  });
}

function renderTables() {
  const list = $('table-list');
  list.replaceChildren(...state.tables.map((table, tIndex) => {
    const probCells = [];
    const rows = table.items.map((it, i) => {
      const prob = h('span', { class: 'prob' });
      probCells.push(prob);
      const timer = it.timer || {};
      const timerEnabled = Boolean(timer.enabled);
      const timerControls = h('div', { class: 'grid2' },
        h('label', { class: 'field' }, '縛りID（同じIDなら時間加算）',
          h('input', { type: 'text', maxLength: 100, placeholder: '例: fishing', value: timer.id || '',
            oninput: (e) => { it.timer = { ...it.timer, id: e.target.value }; markDirty(); } })),
        h('label', { class: 'field' }, '制限時間（分）',
          h('input', { type: 'number', min: 1, max: 1440, step: 1, value: timer.minutes ?? 10,
            oninput: (e) => { it.timer = { ...it.timer, minutes: Number(e.target.value) }; markDirty(); } })),
        h('label', { class: 'field' }, '同時実行',
          select([['exclusive', '専用行動（釣り・虫捕りなど）'], ['parallel', '並行可能（ジャンプ禁止など）']],
            timer.group || 'exclusive', (v) => { it.timer = { ...it.timer, group: v }; markDirty(); })),
        h('label', { class: 'field' }, '実行中BGMのURL（MP3など／YouTube動画）',
          h('input', { type: 'url', value: timer.bgmUrl || '', placeholder: 'https://www.youtube.com/watch?v=... または https://example.com/music.mp3',
            oninput: (e) => { it.timer = { ...it.timer, bgmUrl: e.target.value }; markDirty(); } })),
        h('p', { class: 'hint' }, '先に再生中のBGMを優先。タイマー停止中は一時停止します。YouTubeは配信画面に公式動画プレーヤーを表示します。iPadでは自動再生できない場合があります。'));
      timerControls.hidden = !timerEnabled;
      return h('div', { class: 'cand' },
        h('input', { class: 'cand__label', type: 'text', value: it.label || '', placeholder: '内容(例: 魚を3匹釣るまで他の行動禁止)', maxLength: LIMITS.label,
          oninput: (e) => { it.label = e.target.value; markDirty(); } }),
        h('input', { class: 'cand__weight', type: 'number', min: 0, step: 'any', value: it.weight ?? 1, title: '重み',
          oninput: (e) => { it.weight = Number(e.target.value); markDirty(); updateProbabilities(table, probCells); } }),
        select(RARITIES.map((r) => [r, r]), it.rarity || 'N', (v) => { it.rarity = v; markDirty(); }),
        prob,
        h('button', { class: 'btn btn--small btn--danger', title: '削除', onclick: () => {
          table.items.splice(i, 1); markDirty(); renderTables();
        } }, '×'),
        h('label', { class: 'field' }, h('input', { type: 'checkbox', checked: timerEnabled,
          onchange: (e) => {
            it.timer = { ...it.timer, enabled: e.target.checked, id: it.timer?.id || ('rule_' + table.id + '_' + i),
              minutes: it.timer?.minutes ?? 10, group: it.timer?.group || 'exclusive' };
            timerControls.hidden = !e.target.checked; markDirty();
          } }), ' 縛りタイマーを使用'),
        timerControls);
    });
    updateProbabilities(table, probCells);

    const used = state.gifts.filter((g) => g.tableId === table.id).map((g) => g.giftName || '(無名)');
    return h('div', { class: 'item' },
      h('div', { class: 'item__row' },
        h('input', { class: 'item__name', type: 'text', value: table.title, placeholder: 'テーブル名(例: 縛りガチャ)', maxLength: LIMITS.title,
          oninput: (e) => { table.title = e.target.value; markDirty(); },
          onchange: () => renderGifts() }),
        h('button', { class: 'btn btn--small btn--danger', onclick: () => {
          const msg = used.length ? `このテーブルは ${used.join('、')} で使われています。削除しますか?` : 'このテーブルを削除しますか?';
          if (!confirm(msg)) return;
          state.tables.splice(tIndex, 1); markDirty(); renderTables(); renderGifts();
        } }, '削除')),
      h('p', { class: 'hint' }, used.length ? `使用中: ${used.join('、')}` : '未使用'),
      h('div', { class: 'cand cand--head' }, h('span', {}, '内容'), h('span', {}, '重み'), h('span', {}, 'レア度'), h('span', {}, '確率'), h('span')),
      ...rows,
      h('button', { class: 'btn btn--small', onclick: () => {
        table.items.push({ label: '', weight: 1, rarity: 'N' }); markDirty(); renderTables();
        const labels = list.children[tIndex]?.querySelectorAll('.cand__label');
        labels?.[labels.length - 1]?.focus();
      } }, '＋ 候補を追加'));
  }));
  if (state.tables.length === 0) list.append(h('p', { class: 'hint' }, 'まだ抽選テーブルがありません。'));
}

$('add-table').addEventListener('click', () => {
  state.tables.push({ id: newTableId(), title: '新しいテーブル', items: [{ label: '', weight: 1, rarity: 'N' }] });
  markDirty();
  renderTables();
  renderGifts();
});

// ---------------- 全体設定 ----------------
function renderSettings() {
  $('set-stale').value = state.settings.staleMinutes;
  $('set-dedupe').value = state.settings.dedupeWindowSec;
}
$('set-stale').addEventListener('input', (e) => { state.settings.staleMinutes = Number(e.target.value); markDirty(); });
$('set-dedupe').addEventListener('input', (e) => { state.settings.dedupeWindowSec = Number(e.target.value); markDirty(); });

function renderAll() {
  renderTables();
  renderGifts();
  renderSettings();
}

// ---------------- 保存・コピー・サンプル ----------------
$('save').addEventListener('click', async () => {
  const { errors } = sanitizeConfig(toPayload());
  if (errors.length && !confirm(`次の問題があります。このまま保存しますか?\n\n・${errors.join('\n・')}`)) return;
  if (env === 'prod' && !confirm('本番の設定を保存します。すぐ配信に反映されます。よろしいですか?')) return;
  const btn = $('save');
  btn.disabled = true;
  try {
    await saveConfig(env, toPayload());
    markClean();
    toast(`${envLabel(env)}の設定を保存しました`);
    state = fromStored(await loadConfig(env)); // 保存後の正規化された内容を表示し直す
    renderAll();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('copy-to-prod').addEventListener('click', async () => {
  if (dirty) { toast('先に「保存」してください', true); return; }
  if (!confirm('テストに保存されている設定で、本番の設定を上書きします。よろしいですか?')) return;
  try {
    await copyConfig('test', 'prod');
    toast('本番にコピーしました');
  } catch (err) {
    toast(err.message, true);
  }
});

$('load-sample').addEventListener('click', () => {
  if ((state.gifts.length || state.tables.length) && !confirm('今の編集内容をサンプルで置き換えます(保存するまで反映されません)。よろしいですか?')) return;
  state = fromStored({ ...SAMPLE_CONFIG, gifts: Object.fromEntries(SAMPLE_CONFIG.gifts.map((g, i) => [i, g])) });
  markDirty();
  renderAll();
});

// ---------------- 受信ログ ----------------
const STATUS_LABEL = { queued: '再生待ちに追加', duplicate: '重複のため無視', skipped: '処理せず' };

function renderLog(entries) {
  const list = $('log-list');
  if (entries.length === 0) {
    list.replaceChildren(h('p', { class: 'hint' }, 'まだ受信していません。'));
    return;
  }
  list.replaceChildren(...entries.map((e) => {
    const fields = e.fields || {};
    const gift = normalizeGift(fields);
    const result = e.result || {};
    const canAdd = result.status === 'skipped' && gift.giftName && !state.gifts.some((g) => g.giftName === gift.giftName);
    return h('div', { class: `log__item log--${result.status || 'unknown'}` },
      h('div', { class: 'log__head' },
        h('span', { class: 'log__time' }, formatTime(e.at)),
        h('span', { class: 'tag' }, e.source === 'test' ? 'テスト' : 'Webhook'),
        h('span', { class: 'log__status' }, STATUS_LABEL[result.status] || result.status || ''),
        result.reason ? h('span', { class: 'hint' }, result.reason) : null,
        canAdd ? h('button', { class: 'btn btn--small', onclick: () => { addGift(gift.giftName); toast(`「${gift.giftName}」を追加しました。設定して保存してください`); } }, 'このギフトを設定に追加') : null),
      h('dl', { class: 'log__fields' },
        ...Object.entries(fields).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
  }));
}

// ---------------- 起動 ----------------
async function start() {
  // 「表示の調整」は開いたときに組み立てる(プレビューの読み込みを必要な時だけにする)
  $('layout-card').addEventListener('toggle', () => {
    if ($('layout-card').open && !$('layout-editor').hasChildNodes()) {
      initLayoutEditor($('layout-editor'), env, (layout) => { currentLayout = layout; renderUrls(); });
    }
  });
  renderHeader();
  renderConnection();
  renderUrls();
  renderAll();

  if (!isConfigured()) {
    toast('js/config.js に Firebase の接続情報を設定してください', true);
    return;
  }
  try {
    state = fromStored(await loadConfig(env));
    renderAll();
  } catch (err) {
    toast(`設定の読み込みに失敗しました: ${err.message}`, true);
  }
  watchConnection((ok) => { $('log-conn').textContent = ok ? '' : 'Firebase に接続できません'; });
  watchRecentLog(env, 30, renderLog);
  watchDisplayState(env, (s) => { playerState = s; renderPlayer(); });
  setInterval(renderPlayer, 5000); // 期限切れの表示を更新する
}

start();
