// ============================================================
// js/result-card.js  レア度ごとの結果カード(ガチャの札)の設定を theme.json から読む(DOM に依存しない)
// ------------------------------------------------------------
//   "resultCard": {
//     "frames": { "N": "card-n.png", "R": "card-r.png", "SR": "card-sr.png", "SSR": "card-ssr.png" },
//     "body":  { "left": 9.6, "right": 9.7, "top": 7.7, "bottom": 9.6 },
//     "label": { "left": 22, "right": 22, "top": 23.5, "bottom": 42.5 },
//     "sub":   { "left": 21, "right": 21, "top": 74.5, "bottom": 19.5 },
//     "height": 880
//   }
//     frames  レア度ごとの枠の画像。レア度の印(バッジ)は画像に描かれている
//     body    画像の中で札の本体がある場所(外側の透明な余白・はみ出した花を除く)。
//             当選時の光(js/effects.js)を本体のふちに合わせるのに使う
//     label   結果(景品名)を置く場所。画像の幅・高さに対する %(四隅の渦巻き・桜を避けた範囲)
//     sub     下の小さな枠(送信者名)を置く場所。省略すると下の枠は使わない
//     height  札の高さ(px、1080×1920 の画面で)。画像の上下の透明な余白は再生の枠(和風は 760px)から
//             はみ出してよいが、本体(body)は枠に収まる大きさにする
// 4枚すべて読み込めたときだけ使い、1枚でも欠ければ従来の札(images.cardFrame)に戻す。
// 文字はすべて HTML で重ねる(画像に焼き込まない)。
// ============================================================

export const RESULT_CARD_RARITIES = ['N', 'R', 'SR', 'SSR'];

const num = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

/** 文字の場所(%)。1つでも範囲外の値があれば、その枠は丸ごと既定値にする(片側だけ既定値に混ざらないように) */
function box(v, fallback) {
  if (!v || typeof v !== 'object') return fallback;
  const b = {
    left: num(v.left, 0, 49, null),
    right: num(v.right, 0, 49, null),
    top: num(v.top, 0, 99, null),
    bottom: num(v.bottom, 0, 99, null),
  };
  if (Object.values(b).some((x) => x == null) || b.top + b.bottom >= 100) return fallback;
  return b;
}

const DEFAULT_LABEL = { left: 22, right: 22, top: 23.5, bottom: 42.5 };
const NO_INSET = { left: 0, right: 0, top: 0, bottom: 0 };

/** theme.json の resultCard を読む。使えない設定なら null(従来の札) */
export function parseResultCard(manifest) {
  const rc = manifest && manifest.resultCard;
  if (!rc || typeof rc !== 'object' || !rc.frames || typeof rc.frames !== 'object') return null;
  const frames = {};
  for (const key of RESULT_CARD_RARITIES) {
    const f = rc.frames[key] ?? rc.frames[key.toLowerCase()];
    if (typeof f !== 'string' || !f) return null;
    frames[key] = f;
  }
  return {
    frames,
    body: box(rc.body, NO_INSET),
    label: box(rc.label, DEFAULT_LABEL),
    sub: box(rc.sub, null),
    height: num(rc.height, 300, 1000, 880),
  };
}
