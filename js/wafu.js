// ============================================================
// js/wafu.js  和風テーマ(theme=wafu)の共通部品
// ------------------------------------------------------------
// 画像は装飾だけに使い、送信者名・ギフト名・結果・レア度・件数などの文字は
// すべて HTML の文字として重ねる(画像に文字を焼き込まない)。
// ============================================================
import { rarityColor } from './visual.js';

const BASE = new URL('../images/wafu/', import.meta.url).href;
export const WAFU = {
  cardFrame: `${BASE}card-frame.png`,
  titleBanner: `${BASE}title-banner.png`,
  capsuleClosed: `${BASE}capsule-closed.png`,
  capsuleOpen: `${BASE}capsule-open.png`,
  resultFrame: `${BASE}result-frame.png`,
  ring: `${BASE}roulette-ring.png`,
  pointer: `${BASE}roulette-pointer.png`,
  rarity: {
    N: `${BASE}rarity-n.png`,
    R: `${BASE}rarity-r.png`,
    SR: `${BASE}rarity-sr.png`,
    SSR: `${BASE}rarity-ssr.png`,
  },
};

// 結果の文言に含まれる言葉から、添えるアイコンを選ぶ(該当なしなら付けない)
const ICONS = [
  { file: 'icon-fishing.png', words: ['釣', '魚'] },
  { file: 'icon-bugs.png', words: ['虫'] },
  { file: 'icon-cooking.png', words: ['料理', '食', '作って'] },
  { file: 'icon-birds.png', words: ['鳥'] },
  { file: 'icon-gathering.png', words: ['花', '採集', 'ガーデニング', '植', '貝'] },
];

export function iconFor(label) {
  const text = String(label || '');
  const hit = ICONS.find((i) => i.words.some((w) => text.includes(w)));
  return hit ? `${BASE}${hit.file}` : null;
}

/** 演出の途中で画像の読み込み待ちが起きないよう、最初にまとめて読み込む */
export function preloadWafu() {
  const urls = [
    WAFU.cardFrame, WAFU.titleBanner, WAFU.capsuleClosed, WAFU.capsuleOpen, WAFU.resultFrame,
    WAFU.ring, WAFU.pointer, ...Object.values(WAFU.rarity), ...ICONS.map((i) => `${BASE}${i.file}`),
  ];
  return Promise.all(urls.map((src) => new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = () => resolve();
    img.src = src;
  })));
}

export function img(src, className) {
  const el = document.createElement('img');
  el.src = src;
  el.alt = '';
  el.className = className;
  el.draggable = false;
  return el;
}

/** レア度の札。N/R/SR/SSR は画像、それ以外は文字の札にする */
export function rarityBadge(rarity, className = 'wafu-rarity') {
  const key = String(rarity || 'N').toUpperCase();
  if (WAFU.rarity[key]) {
    const el = img(WAFU.rarity[key], className);
    el.alt = key;
    return el;
  }
  const el = document.createElement('div');
  el.className = `${className} ${className}--text`;
  el.textContent = key;
  return el;
}

/**
 * 文字が枠からはみ出さないよう、入りきる大きさまで文字を小さくする。
 * el は幅・高さが決まった箱の中にある前提(oneLine のときは幅だけ)。
 */
export function fitText(el, maxPx, minPx, { oneLine = false } = {}) {
  let size = maxPx;
  el.style.fontSize = `${size}px`;
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
  return size;
}

/** ルーレットの結果などに使う、結果枠(画像)+レア度+文言 */
export function resultFrame(roll) {
  const wrap = document.createElement('div');
  wrap.className = 'wafu-result';
  wrap.style.setProperty('--rarity', rarityColor(roll.rarity, roll.color));
  const text = document.createElement('div');
  text.className = 'wafu-result__text';
  text.textContent = roll.label;
  wrap.append(img(WAFU.resultFrame, 'wafu-result__frame'), rarityBadge(roll.rarity, 'wafu-result__rarity'), text);
  const icon = iconFor(roll.label);
  if (icon) wrap.append(img(icon, 'wafu-result__icon'));
  return wrap;
}
