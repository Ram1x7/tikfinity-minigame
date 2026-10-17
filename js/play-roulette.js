// ルーレット演出: 当選確率に比例した扇形の円盤を回し、確定済みの結果で止める。
// 結果は Worker が決めたものを受け取るだけで、ここでは抽選しない。
import { rarityColor, SLICE_COLORS, sleep } from './visual.js';
import { WAFU, img, resultFrame, fitText } from './wafu.js';

const SIZE = 1000; // 描画に使う座標の大きさ(実際の画素数は画面の倍率に合わせて決める)

// 見た目の違い(盤面は候補・確率に合わせて毎回描くので、色や線だけを切り替える)
const SKINS = {
  pop: {
    cssSize: 780, // 1080×1920 基準での表示サイズ(css/display.css と合わせる)
    colors: SLICE_COLORS,
    line: '#2a1a16',
    highlight: '#2a1a16',
    hub: '#fffaf0',
    radius: SIZE / 2 - 20,
  },
  wafu: {
    cssSize: 496, // リング画像(760px)の穴に合わせた大きさ(css/theme-wafu.css と合わせる)
    // 藍・和紙・朱・金・桜・抹茶。隣同士がはっきり分かれる順に並べる
    colors: ['#f4ead2', '#24386b', '#d9a83a', '#b8402e', '#f2b9c8', '#3d6b55', '#e8d7b0', '#5a3f7a'],
    line: '#c9a14a',
    highlight: '#ffffff',
    hub: '#1b2547',
    radius: SIZE / 2 - 4, // 外周はリング画像の内側に隠れる
  },
};

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

function slicesOf(pool, colors) {
  const total = pool.reduce((s, it) => s + Math.max(0, Number(it.weight) || 0), 0) || 1;
  let start = 0;
  return pool.map((it, i) => {
    const sweep = (Math.max(0, Number(it.weight) || 0) / total) * Math.PI * 2;
    const slice = { ...it, start, sweep, fill: it.color || colors[i % colors.length] };
    start += sweep;
    return slice;
  });
}

function drawWheel(ctx, slices, rotation, highlight = -1, skin = SKINS.pop) {
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

    // 細すぎる扇形には文字を書かない
    if (s.sweep < 0.12) return;
    ctx.save();
    ctx.rotate(s.start + s.sweep / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const fontSize = Math.max(32, Math.min(64, s.sweep * 190));
    ctx.font = `900 ${fontSize}px 'Zen Maru Gothic', sans-serif`;
    let text = s.label;
    const maxWidth = r - 120;
    while (text.length > 1 && ctx.measureText(text).width > maxWidth) text = text.slice(0, -1);
    if (text !== s.label) text = text.slice(0, -1) + '…';
    // 縁取り → 文字 の順に描いて、色の上でも読めるようにする(背景の明るさで白黒を切り替える)
    const tc = textColorsFor(s.fill);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 10;
    ctx.strokeStyle = tc.stroke;
    ctx.strokeText(text, r - 36, 0);
    ctx.fillStyle = tc.fill;
    ctx.fillText(text, r - 36, 0);
    ctx.restore();
  });

  // 中心
  ctx.beginPath();
  ctx.arc(0, 0, 70, 0, Math.PI * 2);
  ctx.fillStyle = skin.hub;
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = skin.line;
  ctx.stroke();
  ctx.restore();
}

const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);

export async function playRoulette(mount, roll, pool, { speed = 1, skin: skinName = 'pop' } = {}) {
  const t = (ms) => ms / speed;
  const skin = SKINS[skinName] || SKINS.pop;
  const list = Array.isArray(pool) && pool.length > 0 ? pool : [roll];
  const slices = slicesOf(list, skin.colors);
  let target = slices.findIndex((s) => s.label === roll.label);
  if (target < 0) target = 0;

  const wrap = document.createElement('div');
  wrap.className = `roulette roulette--${skinName}`;
  wrap.style.setProperty('--rarity', rarityColor(roll.rarity, roll.color));
  const canvas = document.createElement('canvas');
  let result;
  if (skinName === 'wafu') {
    // 盤面(canvas)の上にリングと針の画像を重ねる。結果は結果枠の画像に表示する
    const wheel = document.createElement('div');
    wheel.className = 'wafu-wheel';
    wheel.append(canvas, img(WAFU.ring, 'wafu-wheel__ring'), img(WAFU.pointer, 'wafu-wheel__pointer'));
    result = resultFrame(roll);
    result.classList.add('roulette__result');
    wrap.append(wheel, result);
  } else {
    const pointer = document.createElement('div');
    pointer.className = 'roulette__pointer';
    result = document.createElement('div');
    result.className = 'roulette__result';
    result.textContent = roll.label;
    wrap.append(canvas, pointer, result);
  }
  mount.replaceChildren(wrap);

  const ctx = setupCanvas(canvas, skin.cssSize);
  // 針は真上(-90度)。当選した扇形の内側のどこかが真上に来る角度で止める。
  const s = slices[target];
  const inner = s.start + s.sweep * (0.2 + Math.random() * 0.6);
  const startRot = Math.random() * Math.PI * 2;
  const baseStop = -Math.PI / 2 - inner;
  const turns = 5 + Math.floor(Math.random() * 2);
  let endRot = baseStop + turns * Math.PI * 2;
  while (endRot - startRot < turns * Math.PI * 2) endRot += Math.PI * 2;

  drawWheel(ctx, slices, startRot, -1, skin);
  await sleep(t(250));

  const duration = t(3600);
  await new Promise((resolve) => {
    const began = performance.now();
    const frame = (now) => {
      const p = Math.min(1, (now - began) / duration);
      drawWheel(ctx, slices, startRot + (endRot - startRot) * easeOutCubic(p), -1, skin);
      if (p < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });

  drawWheel(ctx, slices, endRot, target, skin);
  const text = result.querySelector('.wafu-result__text');
  if (text) fitText(text, 60, 30);
  await result.animate(
    [{ opacity: 0, transform: 'translateX(-50%) scale(.7)' }, { opacity: 1, transform: 'translateX(-50%) scale(1.06)' }, { opacity: 1, transform: 'translateX(-50%) scale(1)' }],
    { duration: t(400), easing: 'ease-out', fill: 'forwards' }
  ).finished;
}
