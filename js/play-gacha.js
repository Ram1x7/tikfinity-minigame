// ガチャ演出: カプセルが落ちてきて揺れ、開くと結果カードが出る
import { rarityColor, sleep } from './visual.js';

export async function playGacha(mount, roll, { speed = 1 } = {}) {
  const t = (ms) => ms / speed;
  const color = rarityColor(roll.rarity, roll.color);

  const wrap = document.createElement('div');
  wrap.className = 'gacha';
  wrap.style.setProperty('--rarity', color);

  const capsule = document.createElement('div');
  capsule.className = 'capsule';
  capsule.innerHTML = '<div class="capsule__glow"></div><div class="capsule__top"></div><div class="capsule__bottom"></div>';

  const reveal = document.createElement('div');
  reveal.className = 'reveal';
  const rarity = document.createElement('div');
  rarity.className = 'reveal__rarity';
  rarity.textContent = roll.rarity || 'N';
  const label = document.createElement('div');
  label.className = 'reveal__label';
  label.textContent = roll.label;
  reveal.append(rarity, label);

  wrap.append(capsule, reveal);
  mount.replaceChildren(wrap);

  const top = capsule.querySelector('.capsule__top');
  const glow = capsule.querySelector('.capsule__glow');

  // 落下
  await capsule.animate(
    [{ transform: 'translateY(-700px) rotate(-30deg)' }, { transform: 'translateY(0) rotate(0deg)' }],
    { duration: t(600), easing: 'cubic-bezier(.3,1.4,.6,1)', fill: 'forwards' }
  ).finished;

  // 揺れ(レア度が高いほど長く揺れる)
  const shakes = { N: 2, R: 3, SR: 4, SSR: 5 }[roll.rarity] || 2;
  for (let i = 0; i < shakes; i++) {
    await capsule.animate(
      [{ transform: 'rotate(0)' }, { transform: 'rotate(-12deg)' }, { transform: 'rotate(12deg)' }, { transform: 'rotate(0)' }],
      { duration: t(260), easing: 'ease-in-out' }
    ).finished;
    await sleep(t(80));
  }

  // 開く
  glow.animate([{ opacity: 0, transform: 'scale(.5)' }, { opacity: 1, transform: 'scale(1.3)' }, { opacity: 0, transform: 'scale(1.6)' }],
    { duration: t(700), easing: 'ease-out', fill: 'forwards' });
  top.animate([{ transform: 'translateY(0) rotate(0)' }, { transform: 'translateY(-260px) rotate(-25deg)', opacity: 0 }],
    { duration: t(450), easing: 'ease-out', fill: 'forwards' });
  await capsule.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(.8)' }],
    { duration: t(450), delay: t(150), easing: 'ease-in', fill: 'forwards' }).finished;

  // 結果
  await reveal.animate(
    [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1.05)' }, { opacity: 1, transform: 'scale(1)' }],
    { duration: t(450), easing: 'ease-out', fill: 'forwards' }
  ).finished;
}
