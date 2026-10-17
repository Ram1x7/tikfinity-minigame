// ルーレット演出: 当選確率に比例した扇形の円盤を回し、確定済みの結果で止める。
// 結果は Worker が決めたものを受け取るだけで、ここでは抽選しない。
//
// 候補が多い・確率が小さい候補があると扇形が細くなり文字が読めなくなるため、
//   - 文字が小さくなりすぎる扇形には番号を表示する
//   - 番号・省略(…)の扇形があるときは、針の下にある候補の名前を大きく表示する(回転中も更新)
// ようにしている。扇形の大きさは確率どおりのまま変えない。
import { rarityColor, SLICE_COLORS, sleep } from './visual.js';
import { img, resultFrame, fitText } from './theme.js';

const SIZE = 1000; // 描画に使う座標の大きさ(実際の画素数は画面の倍率に合わせて決める)
const MIN_TEXT_CSS_PX = 24; // 扇形の文字がこれより小さくなる場合は番号にする(1080×1920 基準)
const MIN_VISIBLE_CHARS = 3; // 省略してもこれだけの文字が見えなければ番号にする
const TWO_PI = Math.PI * 2;

// 従来デザイン
const POP_SKIN = {
  colors: SLICE_COLORS,
  line: '#2a1a16',
  highlight: '#2a1a16',
  hub: '#fffaf0',
  radius: SIZE / 2 - 20,
};

function skinFor(theme) {
  if (!theme) return POP_SKIN;
  const r = theme.roulette || {};
  return {
    colors: r.colors && r.colors.length ? r.colors : SLICE_COLORS,
    line: r.line || '#c9a14a',
    highlight: r.highlight || '#ffffff',
    hub: r.hub || '#1b2547',
    radius: SIZE / 2 - 4, // 外周はリング画像の内側に隠れる
  };
}

/** 背景色の明るさから、読みやすい文字色(濃い/白)を選ぶ */
function textColorsFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return { fill: '#2a1a16', stroke: '#ffffff' };
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const light = 0.299 * r + 0.587 * g + 0.114 * b > 150;
  return light ? { fill: '#1b2547', stroke: '#ffffff' } : { fill: '#ffffff', stroke: '#14193a' };
}

/** 画面の倍率と端末の画素密度に合わせて、ぼやけない画素数にする */
function setupCanvas(canvas, cssSize) {
  const scale = window.__stageScale || 1;
  const dpr = window.devicePixelRatio || 1;
  const px = Math.max(300, Math.min(2400, Math.round(cssSize * scale * dpr)));
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(px / SIZE, 0, 0, px / SIZE, 0, 0);
  return ctx;
}

export function slicesOf(pool, colors) {
  const total = pool.reduce((s, it) => s + Math.max(0, Number(it.weight) || 0), 0) || 1;
  let start = 0;
  return pool.map((it, i) => {
    const sweep = (Math.max(0, Number(it.weight) || 0) / total) * TWO_PI;
    const slice = { ...it, index: i, start, sweep, fill: it.color || colors[i % colors.length] };
    start += sweep;
    return slice;
  });
}

/** 円盤が rotation だけ回っているとき、真上の針の下にある扇形 */
export function sliceAt(slices, rotation) {
  let a = (-Math.PI / 2 - rotation) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return slices.find((s) => a >= s.start && a < s.start + s.sweep) || slices[slices.length - 1];
}

/**
 * 各扇形に「文字」「番号」のどちらを描くかを決める(回転中に毎回測らないよう最初に1回だけ)。
 * cssSize は円盤の表示サイズ(1080×1920 基準の px)。
 */
function planLabels(ctx, slices, skin, cssSize) {
  const toCss = cssSize / SIZE;
  const r = skin.radius;
  return slices.map((s) => {
    const fontSize = Math.max(28, Math.min(64, s.sweep * 190));
    ctx.font = `900 ${fontSize}px 'Zen Maru Gothic', sans-serif`;
    let text = s.label;
    const maxWidth = r - 120;
    while (text.length > 1 && ctx.measureText(text).width > maxWidth) text = text.slice(0, -1);
    const truncated = text !== s.label;
    if (truncated) text = text.slice(0, -1) + '…';
    const visible = truncated ? text.length - 1 : text.length;
    const tooSmall = fontSize * toCss < MIN_TEXT_CSS_PX;
    const tooShort = truncated && visible < Math.min(MIN_VISIBLE_CHARS, s.label.length);
    if (tooSmall || tooShort) {
      // 番号は細い扇形でも読める大きさ(1080×1920 基準で 22px 以上)にする
      const numSize = Math.min(64, Math.max(22 / toCss, s.sweep * 260));
      return { mode: 'number', text: String(s.index + 1), fontSize: numSize, drawable: s.sweep >= 0.05 };
    }
    return { mode: 'text', text, fontSize, truncated };
  });
}

function drawWheel(ctx, slices, plans, rotation, highlight, skin) {
  const c = SIZE / 2;
  const r = skin.radius;
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(rotation);

  slices.forEach((s, i) => {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, s.start, s.start + s.sweep);
    ctx.closePath();
    ctx.fillStyle = s.fill;
    ctx.fill();
    ctx.lineWidth = i === highlight ? 16 : 7;
    ctx.strokeStyle = i === highlight ? skin.highlight : skin.line;
    ctx.stroke();

    const plan = plans[i];
    if (plan.mode === 'number' && !plan.drawable) return;
    const tc = textColorsFor(s.fill);
    ctx.save();
    ctx.rotate(s.start + s.sweep / 2);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 10;
    ctx.strokeStyle = tc.stroke;
    ctx.fillStyle = tc.fill;
    ctx.font = `900 ${plan.fontSize}px 'Zen Maru Gothic', sans-serif`;
    ctx.textBaseline = 'middle';
    if (plan.mode === 'number') {
      // 番号は外周寄りに、読みやすいよう回転を戻して描く
      const x = r * 0.8;
      ctx.translate(x, 0);
      ctx.rotate(-(s.start + s.sweep / 2 + rotation));
      ctx.textAlign = 'center';
      ctx.strokeText(plan.text, 0, 0);
      ctx.fillText(plan.text, 0, 0);
    } else {
      // 縁取り → 文字 の順に描いて、色の上でも読めるようにする
      ctx.textAlign = 'right';
      ctx.strokeText(plan.text, r - 36, 0);
      ctx.fillText(plan.text, r - 36, 0);
    }
    ctx.restore();
  });

  // 中心
  ctx.beginPath();
  ctx.arc(0, 0, 70, 0, TWO_PI);
  ctx.fillStyle = skin.hub;
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = skin.line;
  ctx.stroke();
  ctx.restore();
}

const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);

/**
 * theme が null なら従来デザイン、画像テーマなら盤面の上にリング・針の画像を重ねる。
 * size は円盤(画像テーマではリング画像)の表示サイズ(1080×1920 基準の px)。
 */
export async function playRoulette(mount, roll, pool, { speed = 1, theme = null, size } = {}) {
  const t = (ms) => ms / speed;
  const skin = skinFor(theme);
  const list = Array.isArray(pool) && pool.length > 0 ? pool : [roll];
  const slices = slicesOf(list, skin.colors);
  let target = slices.findIndex((s) => s.label === roll.label);
  if (target < 0) target = 0;

  const wrap = document.createElement('div');
  wrap.className = theme ? 'roulette roulette--image' : 'roulette';
  wrap.style.setProperty('--rarity', rarityColor(roll.rarity, roll.color));
  const canvas = document.createElement('canvas');
  const ticker = document.createElement('div');
  ticker.className = 'roulette__ticker';
  ticker.hidden = true;

  let result;
  let cssSize;
  if (theme) {
    const ringSize = size || 760;
    cssSize = Math.round(ringSize * theme.ringHole.d);
    const wheel = document.createElement('div');
    wheel.className = 'img-wheel';
    wheel.style.setProperty('--ring-size', `${ringSize}px`);
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
    canvas.style.left = `${Math.round(ringSize * theme.ringHole.cx - cssSize / 2)}px`;
    canvas.style.top = `${Math.round(ringSize * theme.ringHole.cy - cssSize / 2)}px`;
    wheel.append(canvas, img(theme.images.ring, 'img-wheel__ring'), img(theme.images.pointer, 'img-wheel__pointer'));
    result = resultFrame(theme, roll);
    result.classList.add('roulette__result');
    wrap.append(wheel, ticker, result);
  } else {
    cssSize = size || 780;
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
    const pointer = document.createElement('div');
    pointer.className = 'roulette__pointer';
    result = document.createElement('div');
    result.className = 'roulette__result';
    result.textContent = roll.label;
    wrap.append(canvas, pointer, ticker, result);
  }
  mount.replaceChildren(wrap);

  const ctx = setupCanvas(canvas, cssSize);
  const plans = planLabels(ctx, slices, skin, cssSize);
  // 番号・省略のある盤面では、針の下の候補名を大きく出す
  const useTicker = plans.some((p) => p.mode === 'number' || p.truncated);

  // 針は真上(-90度)。当選した扇形の内側のどこかが真上に来る角度で止める。
  const s = slices[target];
  const inner = s.start + s.sweep * (0.2 + Math.random() * 0.6);
  const startRot = Math.random() * TWO_PI;
  const baseStop = -Math.PI / 2 - inner;
  const turns = 5 + Math.floor(Math.random() * 2);
  let endRot = baseStop + turns * TWO_PI;
  while (endRot - startRot < turns * TWO_PI) endRot += TWO_PI;

  let shown = -1;
  const updateTicker = (rot) => {
    if (!useTicker) return;
    const cur = sliceAt(slices, rot);
    if (cur.index === shown) return;
    shown = cur.index;
    ticker.textContent = plans[cur.index].mode === 'number' ? `${cur.index + 1}. ${cur.label}` : cur.label;
  };

  drawWheel(ctx, slices, plans, startRot, -1, skin);
  if (useTicker) { ticker.hidden = false; updateTicker(startRot); }
  await sleep(t(250));

  const duration = t(3600);
  await new Promise((resolve) => {
    const began = performance.now();
    const frame = (now) => {
      const p = Math.min(1, (now - began) / duration);
      const rot = startRot + (endRot - startRot) * easeOutCubic(p);
      drawWheel(ctx, slices, plans, rot, -1, skin);
      updateTicker(rot);
      if (p < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });

  drawWheel(ctx, slices, plans, endRot, target, skin);
  ticker.hidden = true;
  const text = result.querySelector('.img-result__text');
  if (text) fitText(text, 60, 30);
  await result.animate(
    [{ opacity: 0, transform: 'translateX(-50%) scale(.7)' }, { opacity: 1, transform: 'translateX(-50%) scale(1.06)' }, { opacity: 1, transform: 'translateX(-50%) scale(1)' }],
    { duration: t(400), easing: 'ease-out', fill: 'forwards' }
  ).finished;
}
