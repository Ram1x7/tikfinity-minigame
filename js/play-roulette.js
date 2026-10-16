// ルーレット演出: 当選確率に比例した扇形の円盤を回し、確定済みの結果で止める。
// 結果は Worker が決めたものを受け取るだけで、ここでは抽選しない。
import { rarityColor, SLICE_COLORS, sleep } from './visual.js';

const SIZE = 1000; // canvas の内部解像度

function slicesOf(pool) {
  const total = pool.reduce((s, it) => s + Math.max(0, Number(it.weight) || 0), 0) || 1;
  let start = 0;
  return pool.map((it, i) => {
    const sweep = (Math.max(0, Number(it.weight) || 0) / total) * Math.PI * 2;
    const slice = { ...it, start, sweep, fill: it.color || SLICE_COLORS[i % SLICE_COLORS.length] };
    start += sweep;
    return slice;
  });
}

function drawWheel(ctx, slices, rotation, highlight = -1) {
  const c = SIZE / 2;
  const r = c - 20;
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
    ctx.lineWidth = i === highlight ? 14 : 6;
    ctx.strokeStyle = i === highlight ? '#3b2a2a' : '#ffffff';
    ctx.stroke();

    // 細すぎる扇形には文字を書かない
    if (s.sweep < 0.12) return;
    ctx.save();
    ctx.rotate(s.start + s.sweep / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#3b2a2a';
    const fontSize = Math.max(22, Math.min(46, s.sweep * 150));
    ctx.font = `900 ${fontSize}px 'Zen Maru Gothic', sans-serif`;
    let text = s.label;
    const maxWidth = r - 110;
    while (text.length > 1 && ctx.measureText(text).width > maxWidth) text = text.slice(0, -1);
    if (text !== s.label) text = text.slice(0, -1) + '…';
    ctx.fillText(text, r - 36, 0);
    ctx.restore();
  });

  // 中心
  ctx.beginPath();
  ctx.arc(0, 0, 70, 0, Math.PI * 2);
  ctx.fillStyle = '#fffaf2';
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.restore();
}

const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);

export async function playRoulette(mount, roll, pool, { speed = 1 } = {}) {
  const t = (ms) => ms / speed;
  const list = Array.isArray(pool) && pool.length > 0 ? pool : [roll];
  const slices = slicesOf(list);
  let target = slices.findIndex((s) => s.label === roll.label);
  if (target < 0) target = 0;

  const wrap = document.createElement('div');
  wrap.className = 'roulette';
  wrap.style.setProperty('--rarity', rarityColor(roll.rarity, roll.color));
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const pointer = document.createElement('div');
  pointer.className = 'roulette__pointer';
  const result = document.createElement('div');
  result.className = 'roulette__result';
  result.textContent = roll.label;
  wrap.append(canvas, pointer, result);
  mount.replaceChildren(wrap);

  const ctx = canvas.getContext('2d');
  // 針は真上(-90度)。当選した扇形の内側のどこかが真上に来る角度で止める。
  const s = slices[target];
  const inner = s.start + s.sweep * (0.2 + Math.random() * 0.6);
  const startRot = Math.random() * Math.PI * 2;
  const baseStop = -Math.PI / 2 - inner;
  const turns = 5 + Math.floor(Math.random() * 2);
  let endRot = baseStop + turns * Math.PI * 2;
  while (endRot - startRot < turns * Math.PI * 2) endRot += Math.PI * 2;

  drawWheel(ctx, slices, startRot);
  await sleep(t(250));

  const duration = t(3600);
  await new Promise((resolve) => {
    const began = performance.now();
    const frame = (now) => {
      const p = Math.min(1, (now - began) / duration);
      drawWheel(ctx, slices, startRot + (endRot - startRot) * easeOutCubic(p));
      if (p < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });

  drawWheel(ctx, slices, endRot, target);
  await result.animate(
    [{ opacity: 0, transform: 'translateX(-50%) scale(.7)' }, { opacity: 1, transform: 'translateX(-50%) scale(1.06)' }, { opacity: 1, transform: 'translateX(-50%) scale(1)' }],
    { duration: t(400), easing: 'ease-out', fill: 'forwards' }
  ).finished;
}
