// ============================================================
// js/orb.js  和風の宝珠(分割開封)の設定を theme.json から読む(DOM に依存しない)
// ------------------------------------------------------------
// theme.json の書き方:
//
//   "orbParts": {
//     "closed": "orb-closed.png",
//     "base": { "file": "orb-open-base.png", "clip": "inset(0 0 0 7%)" },
//     "petals": { "file": "orb-petals.png", "softEdge": true },
//     ...
//   },
//   "orbRarity": { "N": ["core", "sparkles"], "SSR": ["core", "energy", "petals", "sparkles", "dust"] }
//
//   orbParts  … 部品の画像。文字列ならファイル名だけ。
//               clip / softEdge は「その画像の」切れ端を隠す暫定の補正なので、
//               PNG を直したもの・別のものに差し替えたら、補正も一緒に消す。
//                 clip      画像の一部を切り取って隠す(CSS の clip-path の値。inset(...) だけ)
//                 softEdge  画像の端まで描かれた絵が直線で切れて見えないよう、周りをぼかす
//   orbRarity … 開いたときに出す光の部品(レア度ごと)。core / energy / petals / sparkles と
//               dust(sparkles をもう1枚重ねた金粉)。書かなかったレア度は下の既定値。
//               光の色・大きさはレア度ごとに theme.css で決める(.wafu-orb[data-rarity])
// ============================================================

/** 7枚すべて読み込めたときだけ分割開封にする(1枚でも欠ければ従来の玉の画像) */
export const ORB_PARTS = ['closed', 'lid', 'base', 'core', 'energy', 'petals', 'sparkles'];
export const ORB_EFFECT_LAYERS = ['core', 'energy', 'petals', 'sparkles', 'dust'];

export const DEFAULT_ORB_RARITY = {
  N: ['core', 'sparkles'],
  R: ['core', 'energy'],
  SR: ['core', 'energy', 'petals'],
  SSR: ['core', 'energy', 'petals', 'sparkles', 'dust'],
};

// clip-path は inset(...) だけを受け付ける(theme.json から任意の CSS を流し込まないため)
const CLIP_RE = /^inset\(\s*-?\d+(\.\d+)?%?(\s+-?\d+(\.\d+)?%?){0,3}\s*\)$/;

/**
 * theme.json の orbParts・orbRarity を読む。
 * 返り値: { files: { 部品: ファイル名 }, fixes: { 部品: { clip, softEdge } }, rarity: { N: [...], ... } }
 * 部品が欠けていても files には書かれた分だけ入れる(そろっているかは読み込み後に確かめる)。
 */
export function parseOrb(manifest) {
  const files = {};
  const fixes = {};
  for (const [key, v] of Object.entries((manifest && manifest.orbParts) || {})) {
    if (!ORB_PARTS.includes(key)) continue;
    const entry = typeof v === 'string' ? { file: v } : (v && typeof v === 'object' ? v : {});
    if (typeof entry.file !== 'string' || !entry.file) continue;
    files[key] = entry.file;
    const fix = {};
    if (typeof entry.clip === 'string' && CLIP_RE.test(entry.clip.trim())) fix.clip = entry.clip.trim();
    if (entry.softEdge === true) fix.softEdge = true;
    if (Object.keys(fix).length) fixes[key] = fix;
  }
  const rarity = {};
  const custom = (manifest && manifest.orbRarity) || {};
  for (const key of Object.keys(DEFAULT_ORB_RARITY)) {
    const list = Array.isArray(custom[key]) ? custom[key] : DEFAULT_ORB_RARITY[key];
    rarity[key] = ORB_EFFECT_LAYERS.filter((layer) => list.includes(layer));
  }
  return { files, fixes, rarity };
}

/** そのレア度で開いたときに出す光の部品 */
export function orbLayersFor(orb, rarity) {
  const key = String(rarity || 'N').toUpperCase();
  return (orb && orb.rarity && orb.rarity[key]) || DEFAULT_ORB_RARITY[key] || DEFAULT_ORB_RARITY.N;
}
