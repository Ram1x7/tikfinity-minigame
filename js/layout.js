// ============================================================
// js/layout.js  表示画面の大きさ・位置の設定(テーマごと・ガチャ/ルーレット別)
// ------------------------------------------------------------
// 設定は表示画面の URL に入れる(管理画面の「表示の調整」で作る)。
//   theme=wafu        画像テーマ(省略時は従来デザイン)
//   g=上端,大きさ      ガチャの台紙の上端(px)・大きさ(%)  例 g=110,100
//   r=上端,大きさ      ルーレットの台紙の上端(px)・大きさ(%)
//   safe=1100         この高さ(px)より下には台紙を出さない(コメント欄よけ)。0 で使わない
//   panel=0           画像テーマで、半透明の台紙を出さない
// 省略した項目はテーマごとの初期値になる。従来デザインの初期値は以前と同じ表示
// (上端 300px・大きさ 100%・コメント欄よけ なし)にしている。
// 位置・大きさはすべて 1080×1920 の画面を基準にした値。
// DOM に依存しない関数だけを置く(node --test で確認できるように)。
// ============================================================

export const LAYOUT_LIMITS = {
  top: [40, 1500],
  scale: [50, 130],
  safe: [900, 1920],
};

// テーマごとの初期値('' は従来デザイン)
const THEME_DEFAULTS = {
  '': {
    gacha: { top: 300, scale: 100 },
    roulette: { top: 300, scale: 100 },
    safeBottom: 0,
    panel: true,
  },
  wafu: {
    gacha: { top: 240, scale: 70 },
    roulette: { top: 240, scale: 70 },
    // 実際のコメント欄(6件+入力欄)が上から約1130pxまで来るため、暫定で1100
    safeBottom: 0,
    panel: true,
  },
};

const isThemeName = (v) => /^[a-z0-9-]{1,40}$/.test(String(v || ''));

/** テーマの初期値(知らない画像テーマは和風と同じ初期値) */
export function defaultLayout(theme = '') {
  const t = isThemeName(theme) ? theme : '';
  const base = THEME_DEFAULTS[t] || THEME_DEFAULTS.wafu;
  return structuredClone({ theme: t, ...base });
}

// 従来の DEFAULT_LAYOUT(従来デザインの初期値)
export const DEFAULT_LAYOUT = defaultLayout('');

const clamp = (v, [min, max], fallback) => {
  if (v === null || v === undefined || String(v).trim() === '') return fallback;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function parsePair(value, fallback) {
  if (!value) return { ...fallback };
  const [top, scale] = String(value).split(',');
  return {
    top: clamp(top, LAYOUT_LIMITS.top, fallback.top),
    scale: clamp(scale, LAYOUT_LIMITS.scale, fallback.scale),
  };
}

function parseSafe(value, fallback) {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  if (String(value).trim() === '0') return 0;
  return clamp(value, LAYOUT_LIMITS.safe, fallback);
}

/** URL のパラメーター(URLSearchParams)から設定を読む。古い top= も両方の上端として受け付ける */
export function parseLayout(params) {
  const p = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const base = defaultLayout(p.get('theme') || '');
  if (p.has('top')) {
    const top = clamp(p.get('top'), LAYOUT_LIMITS.top, base.gacha.top);
    base.gacha.top = top;
    base.roulette.top = top;
  }
  return {
    theme: base.theme,
    gacha: parsePair(p.get('g'), base.gacha),
    roulette: parsePair(p.get('r'), base.roulette),
    safeBottom: parseSafe(p.get('safe'), base.safeBottom),
    panel: p.has('panel') ? p.get('panel') !== '0' : base.panel,
  };
}

/** 設定を URL のパラメーターにする(管理画面で表示画面の URL を作る時に使う) */
export function layoutToParams(layout) {
  const out = {};
  if (layout.theme) out.theme = layout.theme;
  out.g = `${layout.gacha.top},${layout.gacha.scale}`;
  out.r = `${layout.roulette.top},${layout.roulette.scale}`;
  out.safe = String(layout.safeBottom || 0);
  if (layout.theme && layout.panel === false) out.panel = '0';
  return out;
}

/**
 * 台紙の倍率を決める。設定の大きさ(%)を基本に、台紙の下端が safeBottom を
 * 越える場合は越えない大きさまで自動で縮める(safeBottom が 0 なら縮めない)。
 * naturalHeight は倍率1のときの台紙の高さ(結果の欄の最大の高さも含める)。
 */
export function fitPanel(mode, naturalHeight, safeBottom) {
  const want = mode.scale / 100;
  if (!safeBottom || naturalHeight <= 0) {
    return { zoom: want, shrunk: false, bottom: Math.round(mode.top + Math.max(0, naturalHeight) * want) };
  }
  const limit = (safeBottom - mode.top) / naturalHeight;
  const zoom = Math.max(0.3, Math.min(want, limit));
  return { zoom, shrunk: zoom < want - 1e-6, bottom: Math.round(mode.top + naturalHeight * zoom) };
}

// 自動で縮めたときに結果の文字だけを大きくする上限(1.3 = 30% まで)
export const TEXT_BOOST_MAX = 1.3;

/**
 * コメント欄よけで台紙を縮めたとき、結果の文字(結果の一覧・札・結果枠など)に掛ける倍率。
 * 縮めた分を打ち消して、見た目の文字の大きさを縮める前に近づける(上限 TEXT_BOOST_MAX)。
 * 縮めていない(zoom が設定の大きさのまま)なら 1。
 */
export function textBoost(fit, mode) {
  if (!fit || !fit.shrunk) return 1;
  const want = mode.scale / 100;
  return Math.min(TEXT_BOOST_MAX, Math.max(1, want / fit.zoom));
}
