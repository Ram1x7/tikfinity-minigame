// 表示画面で共通に使う小物
export const RARITY_COLORS = { N: '#7d8a99', R: '#1f7fe0', SR: '#9b3fe8', SSR: '#f2a900' };

// ルーレットの扇形に使う色。配信の圧縮でも隣と区別できるよう、はっきりした色にしている
export const SLICE_COLORS = ['#ff8a9a', '#ffc04d', '#ffe866', '#7ee08a', '#6ec3ff', '#b79bff', '#ff9fd6', '#5fdcc4'];

export function rarityColor(rarity, custom) {
  return custom || RARITY_COLORS[rarity] || RARITY_COLORS.N;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
