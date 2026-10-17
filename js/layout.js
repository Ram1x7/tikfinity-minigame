// ============================================================
// js/layout.js  表示画面の大きさ・位置の設定(ガチャ・ルーレット別)
// ------------------------------------------------------------
// 設定は表示画面の URL に入れる(管理画面の「表示の調整」で作る)。
//   theme=wafu        画像テーマ(省略時は従来デザイン)
//   g=上端,大きさ      ガチャの台紙の上端(px)・大きさ(%)  例 g=110,100
//   r=上端,大きさ      ルーレットの台紙の上端(px)・大きさ(%)
//   safe=1400         この高さ(px)より下には台紙を出さない(TikTok のコメント欄を避ける)
// 位置・大きさはすべて 1080×1920 の画面を基準にした値。
// DOM に依存しない関数だけを置く(node --test で確認できるように)。
// ============================================================

export const LAYOUT_LIMITS = {
  top: [40, 1500],
  scale: [50, 130],
  safe: [900, 1920],
};

export const DEFAULT_LAYOUT = {
  theme: '',
  gacha: { top: 110, scale: 100 },
  roulette: { top: 110, scale: 100 },
  safeBottom: 1400,
};

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

/** URL のパラメーター(URLSearchParams)から設定を読む。古い top= も両方の上端として受け付ける */
export function parseLayout(params) {
  const p = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const legacyTop = p.has('top') ? clamp(p.get('top'), LAYOUT_LIMITS.top, DEFAULT_LAYOUT.gacha.top) : null;
  const base = legacyTop === null
    ? DEFAULT_LAYOUT
    : { ...DEFAULT_LAYOUT, gacha: { ...DEFAULT_LAYOUT.gacha, top: legacyTop }, roulette: { ...DEFAULT_LAYOUT.roulette, top: legacyTop } };
  const theme = p.get('theme') || '';
  return {
    theme: /^[a-z0-9-]{1,40}$/.test(theme) ? theme : '',
    gacha: parsePair(p.get('g'), base.gacha),
    roulette: parsePair(p.get('r'), base.roulette),
    safeBottom: clamp(p.get('safe'), LAYOUT_LIMITS.safe, DEFAULT_LAYOUT.safeBottom),
  };
}

/** 設定を URL のパラメーターにする(管理画面で表示画面の URL を作る時に使う) */
export function layoutToParams(layout) {
  const out = {};
  if (layout.theme) out.theme = layout.theme;
  out.g = `${layout.gacha.top},${layout.gacha.scale}`;
  out.r = `${layout.roulette.top},${layout.roulette.scale}`;
  out.safe = String(layout.safeBottom);
  return out;
}

/**
 * 台紙の倍率を決める。設定の大きさ(%)を基本に、台紙の下端が safeBottom を
 * 越える場合は越えない大きさまで自動で縮める。
 * naturalHeight は倍率1のときの台紙の高さ(結果2件分の場所も含めた最大の高さ)。
 */
export function fitPanel(mode, naturalHeight, safeBottom) {
  const want = mode.scale / 100;
  const room = safeBottom - mode.top;
  if (naturalHeight <= 0) return { zoom: want, shrunk: false, bottom: mode.top };
  const limit = room / naturalHeight;
  const zoom = Math.max(0.3, Math.min(want, limit));
  return { zoom, shrunk: zoom < want - 1e-6, bottom: Math.round(mode.top + naturalHeight * zoom) };
}
