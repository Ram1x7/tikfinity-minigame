// ============================================================
// js/effects.js  当選時のレア度別の演出(画像テーマ用)
// ------------------------------------------------------------
// 札・結果枠が出る瞬間に、レア度ごとの光・光の筋・桜・金の粒を重ねる。
// 設定は theme.json の "effects"(レア度ごと)。書かなかった項目は下の既定値になる。
//
//   "effects": {
//     "SSR": { "glow": 0.7, "color": "#ffd27a", "rays": 0.35, "sakura": 14, "gold": 10, "duration": 1800 }
//   }
//     glow     中央の光の強さ(0〜1。0 で無し)
//     aura     札・結果枠のふちの光の強さ(0〜1。0 で無し)
//     color    光の色(省略時はレア度の色)
//     rays     後ろで回る光の筋の濃さ(0〜1。0 で無し)
//     sakura   舞う花びらの数
//     gold     金の粒(きらめき)の数
//     duration 演出の長さ(ミリ秒。最大 2500)
//
// ゲーム画面とコメントを邪魔しないよう、
//   - 演出は再生の枠(台紙の中の演出の場所)の中だけに描き、画面全体を光らせない
//   - 花びら・金の粒は札や結果枠の文字に掛からないよう、左右の端と札の縁に寄せる
//   - 決まった時間で消え、要素も取り除く(通常の表示に戻る)
// ようにしている。
// ============================================================

const MAX_DURATION = 2500;

// 既定値: N は演出なし、レア度が上がるほど少しずつ足す
export const DEFAULT_EFFECTS = {
  N: { glow: 0, aura: 0, rays: 0, sakura: 0, gold: 0, duration: 0 },
  R: { glow: 0.3, aura: 0.6, rays: 0, sakura: 0, gold: 4, duration: 1200 },
  SR: { glow: 0.45, aura: 0.75, rays: 0, sakura: 8, gold: 6, duration: 1600 },
  SSR: { glow: 0.6, aura: 0.9, rays: 0.3, sakura: 14, gold: 10, duration: 2000 },
};

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
const count = (v, max) => Math.min(max, Math.max(0, Math.round(Number(v) || 0)));

/** テーマの設定と既定値を合わせた、レア度の演出の設定 */
export function effectFor(theme, rarity) {
  const key = String(rarity || 'N').toUpperCase();
  const base = DEFAULT_EFFECTS[key] || DEFAULT_EFFECTS.N;
  const custom = (theme && theme.effects && theme.effects[key]) || {};
  const e = { ...base, ...custom };
  return {
    glow: clamp01(e.glow),
    aura: clamp01(e.aura),
    color: typeof e.color === 'string' ? e.color : '',
    rays: clamp01(e.rays),
    sakura: count(e.sakura, 30),
    gold: count(e.gold, 24),
    duration: Math.min(MAX_DURATION, Math.max(0, Number(e.duration) || 0)),
  };
}

/** 演出が何もない設定か */
export const isQuiet = (e) => !e.duration || (!e.glow && !e.aura && !e.rays && !e.sakura && !e.gold);

const rand = (a, b) => a + Math.random() * (b - a);

/**
 * host(再生の枠)の中に演出を重ね、終わったら取り除く。
 * focus は札・結果枠の位置({ x, y, w, h }、host の中の px)。金の粒はこの縁に置く。
 */
export function playRarityEffect(host, theme, rarity, { color = '', speed = 1, focus = null } = {}) {
  const e = effectFor(theme, rarity);
  if (isQuiet(e)) return Promise.resolve();
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const dur = e.duration / speed;
  const W = host.clientWidth;
  const H = host.clientHeight;
  const f = focus || { x: W * 0.2, y: H * 0.1, w: W * 0.6, h: H * 0.8 };
  const tint = e.color || color || '#ffd27a';

  const back = document.createElement('div'); // 札の後ろ(光・光の筋)
  back.className = 'fx fx__back';
  const front = document.createElement('div'); // 札の前(花びら・金の粒)
  front.className = 'fx fx__front';
  for (const el of [back, front]) el.style.setProperty('--fx-color', tint);
  host.prepend(back);
  host.append(front);
  const anims = [];

  if (e.glow) {
    const glow = document.createElement('div');
    glow.className = 'fx__glow';
    back.append(glow);
    anims.push(glow.animate(
      [{ opacity: 0, transform: 'scale(.6)' }, { opacity: e.glow, transform: 'scale(1)', offset: 0.25 }, { opacity: 0, transform: 'scale(1.15)' }],
      { duration: dur, easing: 'ease-out', fill: 'forwards' }
    ));
  }
  if (e.aura) {
    // 札・結果枠のふちを、レア度の色でふわっと光らせる
    const aura = document.createElement('div');
    aura.className = 'fx__aura';
    Object.assign(aura.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px` });
    back.append(aura);
    anims.push(aura.animate(
      [{ opacity: 0 }, { opacity: e.aura, offset: 0.2 }, { opacity: e.aura * 0.8, offset: 0.6 }, { opacity: 0 }],
      { duration: dur, easing: 'ease-out', fill: 'forwards' }
    ));
  }
  if (e.rays && !reduce) {
    const rays = document.createElement('div');
    rays.className = 'fx__rays';
    back.append(rays);
    anims.push(rays.animate(
      [{ opacity: 0, transform: 'rotate(0)' }, { opacity: e.rays, offset: 0.3 }, { opacity: 0, transform: 'rotate(40deg)' }],
      { duration: dur, easing: 'ease-out', fill: 'forwards' }
    ));
  }
  if (!reduce) {
    // 花びら: 左右の端(札の外)を上から下へ
    for (let i = 0; i < e.sakura; i++) {
      const p = document.createElement('div');
      p.className = 'fx__petal';
      const left = i % 2 === 0;
      const sideW = Math.max(40, Math.min(f.x, W - (f.x + f.w)));
      const x = left ? rand(0, sideW) : rand(W - sideW, W);
      p.style.left = `${Math.round(x)}px`;
      p.style.top = '0px';
      const size = rand(18, 30);
      p.style.width = `${size}px`;
      p.style.height = `${size * 0.8}px`;
      front.append(p);
      const fall = rand(H * 0.45, H * 0.85);
      const drift = rand(-40, 40);
      const spin = rand(-260, 260);
      anims.push(p.animate(
        [
          { opacity: 0, transform: `translate(0, -20px) rotate(0)` },
          { opacity: 0.9, offset: 0.15 },
          { opacity: 0.9, offset: 0.7 },
          { opacity: 0, transform: `translate(${drift}px, ${fall}px) rotate(${spin}deg)` },
        ],
        { duration: dur * rand(0.75, 1), delay: rand(0, dur * 0.25), easing: 'ease-in', fill: 'both' }
      ));
    }
    // 金の粒: 札・結果枠の縁できらめく
    for (let i = 0; i < e.gold; i++) {
      const s = document.createElement('div');
      s.className = 'fx__gold';
      const edge = i % 4;
      const t = Math.random();
      const x = edge === 0 ? f.x + f.w * t : edge === 1 ? f.x + f.w : edge === 2 ? f.x + f.w * t : f.x;
      const y = edge === 0 ? f.y : edge === 1 ? f.y + f.h * t : edge === 2 ? f.y + f.h : f.y + f.h * t;
      s.style.left = `${Math.round(x)}px`;
      s.style.top = `${Math.round(y)}px`;
      front.append(s);
      anims.push(s.animate(
        [{ opacity: 0, transform: 'translate(-50%, -50%) scale(0) rotate(45deg)' }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(45deg)', offset: 0.4 }, { opacity: 0, transform: 'translate(-50%, -50%) scale(.2) rotate(45deg)' }],
        { duration: dur * rand(0.35, 0.55), delay: rand(0, dur * 0.5), easing: 'ease-out', fill: 'both' }
      ));
    }
  }

  // 終わったら要素を取り除いて通常の表示に戻す
  const done = Promise.all(anims.map((a) => a.finished.catch(() => {})));
  const cleanup = () => { back.remove(); front.remove(); };
  return Promise.race([done, new Promise((r) => setTimeout(r, dur + 600))]).then(cleanup);
}
