// 表示画面で共通に使う小物
export const RARITY_COLORS = { N: '#9aa5b1', R: '#4aa3ff', SR: '#b46cff', SSR: '#ffc23d' };

// ルーレットの扇形に使う、やさしい色の並び
export const SLICE_COLORS = ['#ffb3ba', '#ffdfba', '#fff3b0', '#baffc9', '#bae1ff', '#d7c4ff', '#ffc8e6', '#c9f2e7'];

export function rarityColor(rarity, custom) {
  return custom || RARITY_COLORS[rarity] || RARITY_COLORS.N;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
