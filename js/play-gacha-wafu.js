// 和風テーマのガチャ演出:
// 閉じた玉が落ちて揺れる → 光って開く → 札(card-frame)が現れ、窓の中にレア度と結果を表示する
import { rarityColor, sleep } from './visual.js';
import { WAFU, img, rarityBadge, iconFor, fitText } from './wafu.js';

export async function playGachaWafu(mount, roll, { speed = 1 } = {}) {
  const t = (ms) => ms / speed;
  const color = rarityColor(roll.rarity, roll.color);

  const wrap = document.createElement('div');
  wrap.className = 'wafu-gacha';
  wrap.style.setProperty('--rarity', color);

  const glow = document.createElement('div');
  glow.className = 'wafu-gacha__glow';
  const closed = img(WAFU.capsuleClosed, 'wafu-gacha__capsule');
  const open = img(WAFU.capsuleOpen, 'wafu-gacha__capsule');
  open.style.opacity = '0';

  // 札: 画像の枠 + 窓の位置に和紙の下地と文字を重ねる
  const card = document.createElement('div');
  card.className = 'wafu-card';
  const windowEl = document.createElement('div');
  windowEl.className = 'wafu-card__window';
  const label = document.createElement('div');
  label.className = 'wafu-card__label';
  label.textContent = roll.label;
  windowEl.append(rarityBadge(roll.rarity, 'wafu-card__rarity'), label);
  const icon = iconFor(roll.label);
  if (icon) windowEl.append(img(icon, 'wafu-card__icon'));
  card.append(windowEl, img(WAFU.cardFrame, 'wafu-card__frame'));

  wrap.append(glow, closed, open, card);
  mount.replaceChildren(wrap);

  // 落下
  await closed.animate(
    [{ transform: 'translateY(-760px) rotate(-25deg)' }, { transform: 'translateY(0) rotate(0)' }],
    { duration: t(650), easing: 'cubic-bezier(.3,1.35,.6,1)', fill: 'forwards' }
  ).finished;

  // 揺れ(レア度が高いほど長く揺れる)
  const shakes = { N: 2, R: 3, SR: 4, SSR: 5 }[roll.rarity] || 2;
  for (let i = 0; i < shakes; i++) {
    await closed.animate(
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
  closed.animate([{ opacity: 1 }, { opacity: 0 }], { duration: t(180), fill: 'forwards' });
  await open.animate(
    [{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'scale(1.08)' }, { opacity: 1, transform: 'scale(1)' }],
    { duration: t(420), easing: 'ease-out', fill: 'forwards' }
  ).finished;
  await sleep(t(250));
  open.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(1.3)' }], { duration: t(350), fill: 'forwards' });

  // 札が現れる。表示してから文字の大きさを窓に合わせる
  card.style.visibility = 'hidden';
  card.style.opacity = '1';
  fitText(label, 54, 28);
  card.style.visibility = '';
  card.style.opacity = '';
  await card.animate(
    [{ opacity: 0, transform: 'translateY(40px) scale(.7) rotateY(80deg)' }, { opacity: 1, transform: 'translateY(0) scale(1.04) rotateY(0)' }, { opacity: 1, transform: 'scale(1)' }],
    { duration: t(520), easing: 'ease-out', fill: 'forwards' }
  ).finished;
}
