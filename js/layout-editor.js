// ============================================================
// js/layout-editor.js  管理画面の「表示の調整」
// ------------------------------------------------------------
// テーマごとに、ガチャ/ルーレットの位置と大きさ・コメント欄よけ・台紙の有無を
// プレビューを見ながら決め、PRISM LIVE に設定する表示画面の URL を作る。
// 設定はテーマごとに別々に、この端末のブラウザに保存する(テーマを切り替えても
// もう一方の設定は変わらない)。Worker・Firebase には保存しないため、
// 変更したら PRISM の URL を貼り直す必要がある。
// ============================================================
import { h, copyText, toast } from './dom.js';
import { pageUrl } from './env.js';
import { LAYOUT_LIMITS, defaultLayout, parseLayout, layoutToParams } from './layout.js';
import { streamParams } from './api.js';

const KEY_THEME = 'tm.layout.theme';
const keyFor = (theme) => `tm.layout.${theme || 'classic'}`;

// 選べるテーマ(images/themes/<value>/ がある名前)
export const THEMES = [
  { value: '', label: '従来(ポップ)' },
  { value: 'wafu', label: '和風(和紙・藍・金)' },
];

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 保存できない環境 */ }
}

/** テーマの保存済み設定(無ければそのテーマの初期値) */
export function loadThemeLayout(theme) {
  const saved = read(keyFor(theme));
  const params = new URLSearchParams(saved || '');
  params.set('theme', theme || '');
  if (!theme) params.delete('theme');
  return parseLayout(params);
}

/** いま選ばれているテーマの設定 */
export function loadSavedLayout() {
  const theme = read(KEY_THEME) || '';
  return loadThemeLayout(THEMES.some((t) => t.value === theme) ? theme : '');
}

function saveLayout(layout) {
  write(KEY_THEME, layout.theme || '');
  write(keyFor(layout.theme), new URLSearchParams(layoutToParams(layout)).toString());
}

/** 表示画面の URL(本番・テストで env だけ違う) */
export function displayUrl(env, layout, extra = {}) {
  return pageUrl('display.html', { env, ...layoutToParams(layout), ...extra });
}

/** PRISM LIVE に設定する URL(表示用の合言葉付き)。合言葉が未設定なら案内の文 */
export function streamUrl(env, layout) {
  const p = streamParams(env);
  if (!p) return `(先に「接続設定」で表示用の合言葉(${env === 'prod' ? '本番' : 'テスト'})を入力してください)`;
  return displayUrl(env, layout, p);
}

function slider(label, unit, [min, max], step, value, onInput, { disabled = false } = {}) {
  const out = h('output', {}, `${value}${unit}`);
  const range = h('input', {
    type: 'range', min, max, step, value, disabled,
    oninput: (e) => { out.textContent = `${e.target.value}${unit}`; onInput(Number(e.target.value)); },
  });
  return h('label', { class: 'slider' }, h('span', { class: 'slider__label' }, label), range, out);
}

/**
 * 管理画面に「表示の調整」を組み立てる。
 * onChange(layout) は設定が変わるたびに呼ばれる(URL の案内の更新用)。
 */
export function initLayoutEditor(container, env, onChange) {
  let layout = loadSavedLayout();
  let timer = null;

  const previewFrames = {
    gacha: h('iframe', { title: 'ガチャのプレビュー', loading: 'lazy' }),
    roulette: h('iframe', { title: 'ルーレットのプレビュー', loading: 'lazy' }),
  };
  const urlProd = h('code');
  const urlTest = h('code');

  function refresh() {
    saveLayout(layout);
    urlProd.textContent = streamUrl('prod', layout);
    urlTest.textContent = streamUrl('test', layout);
    onChange?.(layout);
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const mode of ['gacha', 'roulette']) {
        previewFrames[mode].src = displayUrl(env, layout, { demo: mode, guide: '1', speed: '1.5' });
      }
    }, 500);
  }

  function build() {
    const modeGroup = (mode, title) => h('fieldset', { class: 'layout-group' },
      h('legend', {}, title),
      slider('上端の位置', 'px', LAYOUT_LIMITS.top, 10, layout[mode].top, (v) => { layout[mode].top = v; refresh(); }),
      slider('大きさ', '%', LAYOUT_LIMITS.scale, 1, layout[mode].scale, (v) => { layout[mode].scale = v; refresh(); }));

    // 線の初期値はデザインの初期値(従来デザインは初期値がオフなので 1100)
    const safeDefault = () => defaultLayout(layout.theme).safeBottom || 1100;
    const safeOn = layout.safeBottom > 0;
    const safeGroup = h('fieldset', { class: 'layout-group' },
      h('legend', {}, 'コメント欄よけ'),
      h('label', { class: 'toggle' },
        h('input', { type: 'checkbox', checked: safeOn, onchange: (e) => {
          layout.safeBottom = e.target.checked ? safeDefault() : 0;
          build();
          refresh();
        } }),
        '台紙がこの線より下に出ないよう自動で縮める'),
      slider('線の高さ', 'px', LAYOUT_LIMITS.safe, 10, layout.safeBottom || safeDefault(), (v) => { layout.safeBottom = v; refresh(); }, { disabled: !safeOn }));

    const imageTheme = Boolean(layout.theme);
    container.replaceChildren(
      h('p', { class: 'hint' }, '設定はデザインごとに別々に保存されます。位置・大きさは 1080×1920 の画面を基準にした値です。'),
      h('label', { class: 'field' }, 'デザイン',
        h('select', { onchange: (e) => {
          saveLayout(layout);
          layout = loadThemeLayout(e.target.value);
          build();
          refresh();
        } }, THEMES.map((t) => h('option', { value: t.value, selected: t.value === layout.theme }, t.label)))),
      imageTheme ? h('label', { class: 'toggle layout-panel-toggle' },
        h('input', { type: 'checkbox', checked: layout.panel, onchange: (e) => { layout.panel = e.target.checked; refresh(); } }),
        '半透明の台紙を表示する') : null,
      h('div', { class: 'layout-groups' },
        modeGroup('gacha', 'ガチャ'),
        modeGroup('roulette', 'ルーレット'),
        safeGroup),
      h('div', { class: 'layout-previews' },
        h('figure', {}, previewFrames.gacha, h('figcaption', {}, 'ガチャ(見本)')),
        h('figure', {}, previewFrames.roulette, h('figcaption', {}, 'ルーレット(見本)'))),
      h('p', { class: 'hint' }, 'プレビューの赤い斜線はコメント欄の目安で、配信には表示されません。'),
      h('p', { class: 'hint' }, 'PRISM LIVE に設定する URL(変更したら PRISM の URL を貼り直してください)'),
      h('div', { class: 'copy-row' }, h('span', { class: 'tag' }, '本番'), urlProd, h('button', { class: 'btn btn--small', onclick: () => copyText(urlProd.textContent) }, 'コピー')),
      h('div', { class: 'copy-row' }, h('span', { class: 'tag' }, 'テスト'), urlTest, h('button', { class: 'btn btn--small', onclick: () => copyText(urlTest.textContent) }, 'コピー')),
      h('button', { class: 'btn btn--small', onclick: () => {
        layout = defaultLayout(layout.theme);
        build();
        refresh();
        toast('このデザインの設定を初期値に戻しました');
      } }, 'このデザインを初期値に戻す'));
  }

  build();
  refresh();
  return { get layout() { return layout; } };
}
