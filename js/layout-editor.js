// ============================================================
// js/layout-editor.js  管理画面の「表示の調整」
// ------------------------------------------------------------
// テーマ・ガチャ/ルーレットの位置と大きさ・コメント欄よけの線を、プレビューを見ながら決め、
// PRISM LIVE に設定する表示画面の URL を作る。
// 設定はこの端末のブラウザに保存する。Worker・Firebase には保存しないため、
// 変更したら PRISM の URL を貼り直す必要がある。
// ============================================================
import { h, copyText, toast } from './dom.js';
import { pageUrl } from './env.js';
import { DEFAULT_LAYOUT, LAYOUT_LIMITS, parseLayout, layoutToParams } from './layout.js';

const STORE_KEY = 'tm.layout';

// 選べるテーマ(images/themes/<value>/ がある名前)
export const THEMES = [
  { value: '', label: '従来(ポップ)' },
  { value: 'wafu', label: '和風(和紙・藍・金)' },
];

export function loadSavedLayout() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) return parseLayout(new URLSearchParams(saved));
  } catch { /* 保存できない環境 */ }
  return structuredClone(DEFAULT_LAYOUT);
}

function saveLayout(layout) {
  try { localStorage.setItem(STORE_KEY, new URLSearchParams(layoutToParams(layout)).toString()); } catch { /* 無視 */ }
}

/** 表示画面の URL(本番・テストで env だけ違う) */
export function displayUrl(env, layout, extra = {}) {
  return pageUrl('display.html', { env, ...layoutToParams(layout), ...extra });
}

function slider(label, unit, [min, max], step, value, onInput) {
  const out = h('output', {}, `${value}${unit}`);
  const range = h('input', {
    type: 'range', min, max, step, value,
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

  function refresh({ reloadPreview = true } = {}) {
    saveLayout(layout);
    urlProd.textContent = displayUrl('prod', layout);
    urlTest.textContent = displayUrl('test', layout);
    onChange?.(layout);
    if (!reloadPreview) return;
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

    container.replaceChildren(
      h('p', { class: 'hint' }, '位置・大きさは 1080×1920 の画面を基準にした値です。台紙が赤い線(コメント欄よけ)を越える場合は、自動で小さくして線の上に収めます。'),
      h('label', { class: 'field' }, 'デザイン',
        h('select', { onchange: (e) => { layout.theme = e.target.value; refresh(); } },
          THEMES.map((t) => h('option', { value: t.value, selected: t.value === layout.theme }, t.label)))),
      h('div', { class: 'layout-groups' },
        modeGroup('gacha', 'ガチャ'),
        modeGroup('roulette', 'ルーレット'),
        h('fieldset', { class: 'layout-group' },
          h('legend', {}, 'コメント欄よけ'),
          slider('この高さより下に出さない', 'px', LAYOUT_LIMITS.safe, 10, layout.safeBottom, (v) => { layout.safeBottom = v; refresh(); }))),
      h('div', { class: 'layout-previews' },
        h('figure', {}, previewFrames.gacha, h('figcaption', {}, 'ガチャ(見本)')),
        h('figure', {}, previewFrames.roulette, h('figcaption', {}, 'ルーレット(見本)'))),
      h('p', { class: 'hint' }, 'プレビューの赤い斜線はコメント欄の目安で、配信には表示されません。'),
      h('p', { class: 'hint' }, 'PRISM LIVE に設定する URL(変更したら PRISM の URL を貼り直してください)'),
      h('div', { class: 'copy-row' }, h('span', { class: 'tag' }, '本番'), urlProd, h('button', { class: 'btn btn--small', onclick: () => copyText(urlProd.textContent) }, 'コピー')),
      h('div', { class: 'copy-row' }, h('span', { class: 'tag' }, 'テスト'), urlTest, h('button', { class: 'btn btn--small', onclick: () => copyText(urlTest.textContent) }, 'コピー')),
      h('button', { class: 'btn btn--small', onclick: () => {
        layout = structuredClone(DEFAULT_LAYOUT);
        build();
        refresh();
        toast('初期値に戻しました');
      } }, '初期値に戻す'));
  }

  build();
  refresh();
  return { get layout() { return layout; } };
}
