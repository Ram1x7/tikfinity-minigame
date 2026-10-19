// ============================================================
// js/theme.js  画像テーマ(display.html?theme=名前)の読み込みと共通部品
// ------------------------------------------------------------
// テーマは images/themes/<名前>/ にまとめて置く:
//   theme.json … 使う画像のファイル名・文字を置く位置・ルーレットの色
//   theme.css  … 色・文字・配置
//   *.png      … 画像素材
// 同じファイル名で画像を差し替えるだけで見た目が更新される。札の窓・リングの穴の位置は
// 画像の透明部分から自動で測るので、画像の比率が変わっても theme.json の修正は原則不要。
//
// 画像は装飾だけに使い、送信者名・ギフト名・結果・レア度・件数などの文字は
// すべて HTML の文字として重ねる(画像に文字を焼き込まない)。
// ============================================================
import { rarityColor } from './visual.js';
import { setPhrased } from './text.js';
import { parseOrb, ORB_PARTS } from './orb.js';

const THEMES_BASE = new URL('../images/themes/', import.meta.url);

export function isThemeName(name) {
  return /^[a-z0-9-]{1,40}$/.test(String(name || ''));
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function loadStylesheet(href) {
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = link.onerror = () => resolve();
    document.head.append(link);
  });
}

/**
 * 画像の中央から上下左右に、透明な部分がどこまで続くかを測る(札の窓・リングの穴)。
 * 結果は画像の幅・高さに対する割合(0〜1)。中央が透明でなければ null。
 */
export function measureTransparentCenter(img, alphaLimit = 40) {
  if (!img) return null;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null; // 別サイトの画像などで読めない場合
  }
  const alpha = (x, y) => data[(y * w + x) * 4 + 3];
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  if (alpha(cx, cy) > alphaLimit) return null;
  let l = cx; while (l > 0 && alpha(l - 1, cy) <= alphaLimit) l--;
  let r = cx; while (r < w - 1 && alpha(r + 1, cy) <= alphaLimit) r++;
  let t = cy; while (t > 0 && alpha(cx, t - 1) <= alphaLimit) t--;
  let b = cy; while (b < h - 1 && alpha(cx, b + 1) <= alphaLimit) b++;
  return { left: l / w, right: (r + 1) / w, top: t / h, bottom: (b + 1) / h };
}

/**
 * 札の画像を横に広げる(theme.json の geometry.cardWiden)。
 * 飾りの無い縦の帯(stretch: 画像の幅に対する % の範囲)だけを引き伸ばし、
 * 角の飾り・中央の飾りは元の形のまま残す。帯が2本なら均等に広げるので中央の飾りは中央のまま。
 * 返すのは広げた画像を描いた canvas(広げられない場合は null)。
 */
export function widenImage(img, aspect, stretch) {
  if (!img || !img.naturalWidth || !Array.isArray(stretch) || stretch.length === 0) return null;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const targetW = Math.round(h * aspect);
  const bands = stretch
    .map(([a, b]) => [Math.round((a / 100) * w), Math.round((b / 100) * w)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const extra = targetW - w;
  if (extra <= 0 || bands.length === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  let sx = 0;
  let dx = 0;
  bands.forEach(([a, b], i) => {
    // 帯の手前はそのまま写す
    ctx.drawImage(img, sx, 0, a - sx, h, dx, 0, a - sx, h);
    dx += a - sx;
    // 帯は広げる(余りは最後の帯に足す)
    const add = i === bands.length - 1 ? extra - Math.floor(extra / bands.length) * (bands.length - 1) : Math.floor(extra / bands.length);
    ctx.drawImage(img, a, 0, b - a, h, dx, 0, b - a + add, h);
    dx += b - a + add;
    sx = b;
  });
  ctx.drawImage(img, sx, 0, w - sx, h, dx, 0, w - sx, h);
  return canvas;
}

const pct = (v) => `${(v * 100).toFixed(2)}%`;

/** テーマを読み込み、画像・CSS・フォントの準備が終わったらテーマ情報を返す */
export async function loadTheme(name) {
  if (!isThemeName(name)) throw new Error(`テーマ名が不正です: ${name}`);
  const base = new URL(`${name}/`, THEMES_BASE);
  const res = await fetch(new URL('theme.json', base), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`テーマが見つかりません: images/themes/${name}/theme.json`);
  const manifest = await res.json();
  const url = (file) => (file ? new URL(file, base).href : null);

  const theme = {
    name,
    title: manifest.name || name,
    images: Object.fromEntries(Object.entries(manifest.images || {})
      .filter(([k]) => k !== 'rarity')
      .map(([k, v]) => [k, url(v)])),
    orbParts: null, // 宝珠の部品の URL。全画像が揃うまでは null(従来の開封画像に戻す)
    orbFixes: {},   // 素材の切れ端を隠す暫定の補正(js/orb.js)
    orbRarity: {},  // レア度ごとに開いたときに出す光の部品
    rarity: Object.fromEntries(Object.entries((manifest.images || {}).rarity || {}).map(([k, v]) => [k.toUpperCase(), url(v)])),
    icons: (manifest.icons || []).map((i) => ({ src: url(i.file), words: i.words || [] })),
    geometry: manifest.geometry || {},
    roulette: manifest.roulette || {},
    effects: manifest.effects || {}, // 当選時のレア度別の演出(js/effects.js)
    rarityColors: manifest.rarityColors || {}, // レア度の色(結果一覧・バッジ・札の飾り・演出の光でそろえる)
    // "text" ならレア度のバッジを画像ではなく HTML(レア度の色)で描く
    badgeStyle: manifest.badgeStyle === 'text' ? 'text' : 'image',
  };

  const styles = [manifest.css ? url(manifest.css) : null, ...(manifest.fonts || [])].filter(Boolean);
  const orb = parseOrb(manifest);
  const orbUrls = Object.fromEntries(Object.entries(orb.files).map(([key, file]) => [key, url(file)]));
  const allImages = [...Object.values(theme.images), ...Object.values(theme.rarity), ...theme.icons.map((i) => i.src), ...Object.values(orbUrls)];
  const [, loaded] = await Promise.all([
    Promise.all(styles.map(loadStylesheet)),
    Promise.all(allImages.map(async (src) => [src, await loadImage(src)])),
  ]);
  const imgs = new Map(loaded);
  // 透過パーツが揃わない状態で半端な開封をしない。全7枚が読み込めた場合のみ有効。
  if (ORB_PARTS.every((key) => orbUrls[key] && imgs.get(orbUrls[key]))) {
    theme.orbParts = orbUrls;
    theme.orbFixes = orb.fixes;
    theme.orbRarity = orb.rarity;
  }

  // 札の窓・リングの穴の位置(theme.json で "auto" なら画像から測る)
  const g = theme.geometry;
  const bleed = 0.006; // 下地を枠の内側に少し潜り込ませ、隙間が出ないようにする
  // 札を横に広げる設定があれば、広げた画像に差し替えてから窓を測る
  let cardImage = imgs.get(theme.images.cardFrame);
  const sourceCardWidth = cardImage?.naturalWidth || 0;
  const widen = g.cardWiden;
  if (widen && cardImage) {
    const wide = widenImage(cardImage, Number(widen.aspect), widen.stretch);
    if (wide) {
      cardImage = wide;
      try { theme.images.cardFrame = wide.toDataURL('image/png'); } catch { cardImage = imgs.get(theme.images.cardFrame); }
    }
  }
  let win = g.cardWindow;
  if (!win || win === 'auto') win = measureTransparentCenter(cardImage);
  else win = { left: win.left / 100, top: win.top / 100, right: 1 - win.right / 100, bottom: 1 - win.bottom / 100 };
  win = win || { left: 0.14, top: 0.23, right: 0.86, bottom: 0.84 };
  let hole = g.ringHole;
  if (!hole || hole === 'auto') {
    const m = measureTransparentCenter(imgs.get(theme.images.ring));
    hole = m ? { cx: (m.left + m.right) / 2, cy: (m.top + m.bottom) / 2, d: Math.min(m.right - m.left, m.bottom - m.top) } : null;
  } else {
    hole = { cx: hole.cx / 100, cy: hole.cy / 100, d: hole.d / 100 };
  }
  theme.ringHole = hole || { cx: 0.5, cy: 0.5, d: 0.62 };

  const css = document.documentElement.style;
  css.setProperty('--card-win-left', pct(win.left - bleed));
  css.setProperty('--card-win-right', pct(1 - win.right - bleed));
  css.setProperty('--card-win-top', pct(win.top - bleed));
  css.setProperty('--card-win-bottom', pct(1 - win.bottom - bleed));
  css.setProperty('--ring-hole-cx', String(theme.ringHole.cx));
  css.setProperty('--ring-hole-cy', String(theme.ringHole.cy));
  css.setProperty('--ring-hole-d', String(theme.ringHole.d + 0.01));
  const rt = g.resultText || {};
  css.setProperty('--result-text-left', `${rt.left ?? 9}%`);
  css.setProperty('--result-text-right', `${rt.right ?? 13}%`);
  css.setProperty('--result-text-top', `${rt.top ?? 22}%`);
  css.setProperty('--result-text-bottom', `${rt.bottom ?? 25}%`);
  css.setProperty('--result-text-left-icon', `${(g.resultTextWithIcon || {}).left ?? 23}%`);
  css.setProperty('--result-icon-left', `${(g.resultIcon || {}).left ?? 7}%`);
  css.setProperty('--result-icon-size', `${(g.resultIcon || {}).size ?? 14}%`);
  // タイトル帯の余白は帯の幅・高さに対する割合(CSS の % は親の幅基準になるため、割合の数値で渡す)
  const tt = g.titleText || {};
  css.setProperty('--title-pad-left', String((tt.left ?? 18) / 100));
  css.setProperty('--title-pad-right', String((tt.right ?? 18) / 100));
  css.setProperty('--title-pad-bottom', String((tt.bottom ?? 7) / 100));
  const pt = g.pointer || {};
  css.setProperty('--pointer-width', `${pt.width ?? 12.6}%`);
  css.setProperty('--pointer-top', `${pt.top ?? 0.5}%`);
  if (theme.images.titleBanner) css.setProperty('--img-title-banner', `url("${theme.images.titleBanner}")`);
  // 札の枠の形(光沢を枠の形の中だけに走らせるため。横に広げた画像なら data URL)
  if (theme.images.cardFrame) css.setProperty('--img-card-frame', `url("${theme.images.cardFrame}")`);
  // 札・結果枠は画像の縦横比のまま表示する(比率の違う画像に差し替えても歪まないように)
  const ratio = (src, fallback) => {
    const im = imgs.get(src);
    return im && im.naturalHeight ? `${im.naturalWidth} / ${im.naturalHeight}` : fallback;
  };
  const cardW = cardImage?.naturalWidth || cardImage?.width;
  const cardH = cardImage?.naturalHeight || cardImage?.height;
  css.setProperty('--card-aspect', cardW && cardH ? `${cardW} / ${cardH}` : '2 / 3');
  css.setProperty('--card-aspect-num', cardW && cardH ? String(cardW / cardH) : String(2 / 3));
  // 札の文字が左右の飾りに掛からないよう、窓の端から空ける幅(札の幅に対する割合)。
  // cardTextSide は元の画像の幅に対する % で、画像の左右の端から測る
  const side = Number(g.cardTextSide);
  const inset = side > 0 && cardW && sourceCardWidth ? Math.max(0, (side / 100) * sourceCardWidth / cardW - win.left) : 0;
  css.setProperty('--card-text-inset', String(inset));
  // タイトル帯は幅÷高さの数値(高さの計算に使う)
  const banner = imgs.get(theme.images.titleBanner);
  css.setProperty('--title-aspect', banner && banner.naturalHeight ? String(banner.naturalWidth / banner.naturalHeight) : '3.39');
  css.setProperty('--result-aspect', ratio(theme.images.resultFrame, '940 / 440'));

  document.body.classList.add('theme-image', `theme-${name}`);
  if (document.fonts) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))]);
  return theme;
}

// ---------------- 演出で使う部品 ----------------

export function img(src, className) {
  const el = document.createElement('img');
  el.src = src;
  el.alt = '';
  el.className = className;
  el.draggable = false;
  return el;
}

/** 結果の文言に含まれる言葉から、添えるアイコンを選ぶ(該当なしなら null) */
export function iconFor(theme, label) {
  const text = String(label || '');
  const hit = (theme.icons || []).find((i) => i.words.some((w) => text.includes(w)));
  return hit ? hit.src : null;
}

/**
 * テーマでのレア度の色。theme.json の rarityColors があればそれを使い、
 * 結果一覧・バッジ・札の飾り・演出の光で同じ色にそろえる(無ければ従来の色)。
 */
export function themeRarityColor(theme, rarity, custom) {
  const key = String(rarity || 'N').toUpperCase();
  return (theme && theme.rarityColors && theme.rarityColors[key]) || rarityColor(key, custom);
}

/** レア度の札。画像があれば画像、無ければ(または badgeStyle が text なら)文字の札にする */
export function rarityBadge(theme, rarity, className) {
  const key = String(rarity || 'N').toUpperCase();
  if (theme.rarity[key] && theme.badgeStyle !== 'text') {
    const el = img(theme.rarity[key], className);
    el.alt = key;
    return el;
  }
  const el = document.createElement('div');
  el.className = `${className} ${className}--text`;
  el.dataset.rarity = key;
  el.style.setProperty('--rarity', themeRarityColor(theme, key));
  el.textContent = key;
  return el;
}

/**
 * 文字が枠からはみ出さないよう、入りきる大きさまで文字を小さくする。
 * el は幅・高さが決まった箱の中にある前提(oneLine のときは幅だけ)。
 */
/**
 * 台紙をコメント欄よけで縮めたときの、結果の文字の倍率(表示画面が --text-boost に入れる)。
 * 縮めていなければ 1。
 */
export function textBoostOf(el) {
  const v = parseFloat(getComputedStyle(el).getPropertyValue('--text-boost'));
  return Number.isFinite(v) && v > 1 ? v : 1;
}

export function fitText(el, maxPx, minPx, { oneLine = false } = {}) {
  let size = maxPx;
  el.style.fontSize = `${size}px`;
  el.style.overflowWrap = '';
  const box = el.parentElement;
  // 1行の文字(white-space: nowrap)は幅だけを見る。行の高さで縦にはみ出し扱いされないように
  const fits = oneLine
    ? () => el.scrollWidth <= el.clientWidth + 1
    : () => el.scrollWidth <= el.clientWidth + 1
      && el.scrollHeight <= el.clientHeight + 1
      && (!box || el.offsetHeight <= box.clientHeight + 1);
  while (size > minPx && !fits()) {
    size -= 2;
    el.style.fontSize = `${size}px`;
  }
  // 最小の大きさでも入らない長い語は、途中で折り返して見切れないようにする
  if (!oneLine && !fits()) el.style.overflowWrap = 'anywhere';
  return size;
}

/** 結果枠(画像)+レア度+文言(+アイコン)。ルーレットの結果表示に使う */
export function resultFrame(theme, roll) {
  const wrap = document.createElement('div');
  wrap.className = 'img-result';
  wrap.dataset.rarity = String(roll.rarity || 'N').toUpperCase();
  wrap.style.setProperty('--rarity', themeRarityColor(theme, roll.rarity, roll.color));
  const text = document.createElement('div');
  text.className = 'img-result__text';
  setPhrased(text, roll.label);
  wrap.append(img(theme.images.resultFrame, 'img-result__frame'), rarityBadge(theme, roll.rarity, 'img-result__rarity'), text);
  const icon = iconFor(theme, roll.label);
  if (icon) {
    wrap.classList.add('img-result--icon');
    wrap.append(img(icon, 'img-result__icon'));
  }
  return wrap;
}
