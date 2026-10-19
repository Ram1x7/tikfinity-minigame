// 画像テーマのガチャ演出:
// 閉じた玉が落ちて揺れる → 光って開く → 札(cardFrame)が現れ、窓の中にレア度と結果を表示する
// 画像は theme.json で指定されたもの(js/theme.js)を使う
import { sleep } from './visual.js';
import { img, rarityBadge, iconFor, fitText, textBoostOf, themeRarityColor } from './theme.js';
import { playRarityEffect } from './effects.js';
import { setPhrased } from './text.js';
import { orbLayersFor } from './orb.js';

export async function playGachaImage(mount, roll, { speed = 1, theme, sender = '', onCard = () => {} } = {}) {
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
  const rarity = String(roll.rarity || 'N').toUpperCase();
  let orb = null;
  let omen = null;     // 開く前の紫の予兆(SR・SSR)
  let openAura = null; // 開いたときの光(色はレア度ごとに theme.css)
  const layers = layered ? orbLayersFor({ rarity: theme.orbRarity }, rarity) : [];
  if (layered) {
    orb = document.createElement('div');
    orb.className = 'wafu-orb';
    orb.dataset.rarity = rarity;
    omen = document.createElement('div');
    omen.className = 'wafu-orb__aura wafu-orb__aura--omen';
    openAura = document.createElement('div');
    openAura.className = 'wafu-orb__aura wafu-orb__aura--open';
    orb.append(omen, openAura);
    // dust(金粉)は sparkles の画像をもう1枚重ねたもの
    for (const key of ['closed', 'base', 'lid', ...layers]) {
      const source = key === 'dust' ? 'sparkles' : key;
      const el = img(parts[source], `wafu-orb__${key}`);
      // 素材の切れ端を隠す暫定の補正(theme.json の orbParts。PNG を差し替えたら補正も消す)
      const fix = (theme.orbFixes || {})[source] || {};
      if (fix.clip) { el.style.clipPath = fix.clip; el.style.webkitClipPath = fix.clip; }
      if (fix.softEdge) el.classList.add('wafu-orb__soft');
      orb.append(el);
    }
  }

  // 札: 画像の枠 + 窓の位置に和紙の下地と文字を重ねる
  // テーマにレア度ごとの結果カード(theme.json の resultCard)があれば、その枠に文字を重ねる。
  // レア度の印は枠の画像に描かれているので、HTML のバッジは出さない
  const rc = theme.resultCard;
  const rarityKey = String(roll.rarity || 'N').toUpperCase();
  const card = document.createElement('div');
  card.className = rc ? 'img-card img-card--framed' : 'img-card';
  card.dataset.rarity = rarityKey;
  const windowEl = document.createElement('div');
  windowEl.className = 'img-card__window';
  const label = document.createElement('div');
  label.className = 'img-card__label';
  setPhrased(label, roll.label); // 文節に近いまとまりで折り返す(iPad の WebKit でも)
  const icon = iconFor(theme, roll.label);
  let subEl = null;
  if (rc) {
    const frameSrc = rc.frames[rarityKey] || rc.frames.N;
    card.style.setProperty('--img-card-frame', `url("${frameSrc}")`); // 光沢を枠の形の中だけに走らせる
    windowEl.append(label);
    if (icon) windowEl.append(img(icon, 'img-card__icon'));
    card.append(img(frameSrc, 'img-card__frame'), windowEl);
    if (rc.sub && sender) {
      // 下の枠: 誰の結果か(送信者名)
      subEl = document.createElement('div');
      subEl.className = 'img-card__sub';
      const name = document.createElement('span');
      name.className = 'img-card__sub-text';
      name.textContent = `${sender} さん`;
      subEl.append(name);
      card.append(subEl);
    }
  } else {
    windowEl.append(rarityBadge(theme, roll.rarity, 'img-card__rarity'), label);
    if (icon) windowEl.append(img(icon, 'img-card__icon'));
    card.append(windowEl, img(theme.images.cardFrame, 'img-card__frame'));
  }

  wrap.append(glow, ...(orb ? [orb] : [closed, open]), card);
  mount.replaceChildren(wrap);

  // 落下
  await (orb || closed).animate(
    [{ transform: 'translateY(-760px) rotate(-25deg)' }, { transform: 'translateY(0) rotate(0)' }],
    { duration: t(650), easing: 'cubic-bezier(.3,1.35,.6,1)', fill: 'forwards' }
  ).finished;

  // 揺れ(レア度が高いほど長く揺れる)
  const shakes = { N: 2, R: 3, SR: 4, SSR: 5 }[roll.rarity] || 2;
  if (layered && (rarity === 'SR' || rarity === 'SSR')) {
    // 紫の予兆。SR と SSR で同じにして、開くまで SSR かどうか分からないようにする
    omen.animate([{ opacity: 0 }, { opacity: 0.9 }], { duration: t(330 * shakes), easing: 'ease-in', fill: 'forwards' });
  }
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
    // 上蓋は下半球の右奥を支点に開いたように、右上へ持ち上げて少し小さくする
    // (同じ位置のままだと下半球の口と光球を覆ってしまう)
    get('lid').animate(
      [{ opacity: 0, transform: 'translate(0, -8%) scale(.95)' },
       { opacity: 1, transform: 'translate(3%, -18%) scale(.9)', offset: 0.3 },
       { opacity: 1, transform: 'translate(10%, -43%) scale(.8)' }],
      { duration: t(640), easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' }
    );
    if (layers.includes('core')) {
      get('core').animate(
        [{ opacity: 0, transform: 'translateY(12%) scale(.55)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }],
        { duration: t(420), delay: t(130), easing: 'ease-out', fill: 'forwards' }
      );
    }
    const delays = { energy: 170, petals: 210, sparkles: 210, dust: 320 };
    for (const key of layers) if (delays[key] !== undefined) reveal(key, delays[key]);
    // 開いたときの光。SSR は紫の予兆が消えて金に変わる(昇格)。描画のみ変更し、抽選結果には触れない
    if (rarity === 'SSR') omen.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: t(380), fill: 'forwards' });
    openAura.animate([{ opacity: 0, transform: 'scale(.8)' }, { opacity: 1, transform: 'scale(1.1)' }],
      { duration: t(380), easing: 'ease-out', fill: 'forwards' });
    await sleep(t(rarity === 'SSR' ? 1000 : 720)); // SSR は昇格を見せるぶん少し長い(従来の仮実装と同じ長さ)
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
  if (subEl) fitText(subEl.firstChild, 46, 28, { oneLine: true }); // 入らなければ末尾を … にする(名前の全文は上の見出し)
  card.style.visibility = '';
  card.style.opacity = '';
  onCard(); // 札が現れた(表示画面が、札と重複する見出しの文字を隠す)
  card.classList.add('sheen'); // 現れたときに枠の金に光が1回走る(theme.css)
  // レア度別の演出(再生の枠の中だけ。終わると自動で消える)
  playRarityEffect(wrap, theme, roll.rarity, {
    color, speed,
    focus: cardBody(card, rc && rc.body),
  });
  await card.animate(
    [{ opacity: 0, transform: 'translateY(40px) scale(.7) rotateY(80deg)' }, { opacity: 1, transform: 'translateY(0) scale(1.04) rotateY(0)' }, { opacity: 1, transform: 'scale(1)' }],
    { duration: t(520), easing: 'ease-out', fill: 'forwards' }
  ).finished;
}

/** 札の本体の位置(再生の枠の中の px)。枠の画像に透明な余白があれば、その分を除く */
function cardBody(card, inset) {
  const b = inset || { left: 0, right: 0, top: 0, bottom: 0 };
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  return {
    x: card.offsetLeft + w * b.left / 100,
    y: card.offsetTop + h * b.top / 100,
    w: w * (1 - (b.left + b.right) / 100),
    h: h * (1 - (b.top + b.bottom) / 100),
  };
}
