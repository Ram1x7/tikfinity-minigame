// 画像テーマのガチャ演出:
// 閉じた玉が落ちて揺れる → 光って開く → 札(cardFrame)が現れ、窓の中にレア度と結果を表示する
// 画像は theme.json で指定されたもの(js/theme.js)を使う
import { sleep } from './visual.js';
import { img, rarityBadge, iconFor, fitText, textBoostOf, themeRarityColor } from './theme.js';
import { playRarityEffect } from './effects.js';
import { setPhrased } from './text.js';

export async function playGachaImage(mount, roll, { speed = 1, theme } = {}) {
  const t = (ms) => ms / speed;
  const color = themeRarityColor(theme, roll.rarity, roll.color);

  const wrap = document.createElement('div');
  wrap.className = 'img-gacha';
  wrap.style.setProperty('--rarity', color);

  const glow = document.createElement('div');
  glow.className = 'img-gacha__glow';
  const closed = img(theme.images.capsuleClosed, 'img-gacha__capsule');
  const open = img(theme.images.capsuleOpen || theme.images.capsuleClosed, 'img-gacha__capsule');
  open.style.opacity = '0';
  // 画像が全て揃った場合だけ分割宝珠を使う。未配置・読込失敗なら従来演出。
  const parts = theme.orbParts;
  const layered = Boolean(parts);
  let orb = null;
  if (layered) {
    orb = document.createElement('div');
    orb.className = 'wafu-orb';
    orb.style.setProperty('--orb-color', color);
    for (const key of ['closed', 'base', 'lid', 'core', 'energy', 'petals', 'sparkles']) {
      orb.append(img(parts[key], `wafu-orb__${key}`));
    }
  }

  // 札: 画像の枠 + 窓の位置に和紙の下地と文字を重ねる
  const card = document.createElement('div');
  card.className = 'img-card';
  card.dataset.rarity = String(roll.rarity || 'N').toUpperCase();
  const windowEl = document.createElement('div');
  windowEl.className = 'img-card__window';
  const label = document.createElement('div');
  label.className = 'img-card__label';
  setPhrased(label, roll.label); // 文節に近いまとまりで折り返す(iPad の WebKit でも)
  windowEl.append(rarityBadge(theme, roll.rarity, 'img-card__rarity'), label);
  const icon = iconFor(theme, roll.label);
  if (icon) windowEl.append(img(icon, 'img-card__icon'));
  card.append(windowEl, img(theme.images.cardFrame, 'img-card__frame'));

  wrap.append(glow, ...(orb ? [orb] : [closed, open]), card);
  mount.replaceChildren(wrap);

  // 落下
  await (orb || closed).animate(
    [{ transform: 'translateY(-760px) rotate(-25deg)' }, { transform: 'translateY(0) rotate(0)' }],
    { duration: t(650), easing: 'cubic-bezier(.3,1.35,.6,1)', fill: 'forwards' }
  ).finished;

  // 揺れ(レア度が高いほど長く揺れる)
  const shakes = { N: 2, R: 3, SR: 4, SSR: 5 }[roll.rarity] || 2;
  for (let i = 0; i < shakes; i++) {
    await (orb || closed).animate(
      [{ transform: 'rotate(0)' }, { transform: 'rotate(-10deg)' }, { transform: 'rotate(10deg)' }, { transform: 'rotate(0)' }],
      { duration: t(260), easing: 'ease-in-out' }
    ).finished;
    await sleep(t(70));
  }

  // 光って開く
  glow.animate(
    [{ opacity: 0, transform: 'scale(.4)' }, { opacity: 0.95, transform: 'scale(1.2)' }, { opacity: 0, transform: 'scale(1.6)' }],
    { duration: t(900), easing: 'ease-out', fill: 'forwards' }
  );
  if (layered) {
    const get = (key) => orb.querySelector(`.wafu-orb__${key}`);
    // 上蓋・下半球の画像には最初から開いた形が描かれているため、閉じた玉から短くクロスフェードする。
    const closedPart = get('closed');
    closedPart.animate([{ opacity: 1 }, { opacity: 0 }], { duration: t(230), fill: 'forwards' });
    const reveal = (key, delay = 0) => get(key).animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: t(300), delay: t(delay), fill: 'forwards' }
    );
    reveal('base');
    const lid = get('lid');
    lid.animate(
      [{ opacity: 0, transform: 'translateY(0) rotate(0deg)' },
       { opacity: 1, transform: 'translateY(-22%) rotate(-7deg)' },
       { opacity: 1, transform: 'translateY(-28%) rotate(-9deg)' }],
      { duration: t(640), easing: 'ease-out', fill: 'forwards' }
    );
    reveal('core', 130);
    reveal('energy', 170);
    reveal('petals', 210);
    reveal('sparkles', 210);
    if (String(roll.rarity).toUpperCase() === 'SSR') {
      // 紫の予兆から金色へ。描画のみ変更し、抽選結果には触れない。
      orb.classList.add('wafu-orb--ssr');
      await sleep(t(280));
      orb.classList.add('wafu-orb--promoted');
    }
    await sleep(t(720));
    orb.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(1.14)' }],
      { duration: t(350), fill: 'forwards' });
  } else {
    closed.animate([{ opacity: 1 }, { opacity: 0 }], { duration: t(180), fill: 'forwards' });
    await open.animate(
      [{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'scale(1.08)' }, { opacity: 1, transform: 'scale(1)' }],
      { duration: t(420), easing: 'ease-out', fill: 'forwards' }
    ).finished;
    await sleep(t(250));
    open.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(1.3)' }], { duration: t(350), fill: 'forwards' });
  }

  // 札が現れる。表示してから文字の大きさを窓に合わせる
  card.style.visibility = 'hidden';
  card.style.opacity = '1';
  // 台紙を縮めているときは、そのぶん大きめから合わせる(入りきらなければ従来どおり小さくする)
  fitText(label, Math.round(62 * textBoostOf(label)), 28);
  card.style.visibility = '';
  card.style.opacity = '';
  card.classList.add('sheen'); // 現れたときに枠の金に光が1回走る(theme.css)
  // レア度別の演出(再生の枠の中だけ。終わると自動で消える)
  playRarityEffect(wrap, theme, roll.rarity, {
    color, speed,
    focus: { x: card.offsetLeft, y: card.offsetTop, w: card.offsetWidth, h: card.offsetHeight },
  });
  await card.animate(
    [{ opacity: 0, transform: 'translateY(40px) scale(.7) rotateY(80deg)' }, { opacity: 1, transform: 'translateY(0) scale(1.04) rotateY(0)' }, { opacity: 1, transform: 'scale(1)' }],
    { duration: t(520), easing: 'ease-out', fill: 'forwards' }
  ).finished;
}
