// 管理画面の「サンプルを読み込む」で入る初期設定。
// ギフト名は TikFinity から実際に届く名前と完全に一致させる必要があります。
// 管理画面の「受信ログ」で実際の名前を確認してから書き換えてください。
export const SAMPLE_CONFIG = {
  tables: {
    shibari: {
      title: 'ハートピア縛りガチャ',
      items: [
        { label: '次の10分は走るの禁止(歩きのみ)', weight: 3, rarity: 'N' },
        { label: '魚を3匹釣るまで他の行動禁止', weight: 3, rarity: 'N' },
        { label: '虫を5匹つかまえるまで家に帰れない', weight: 3, rarity: 'N' },
        { label: '花を10本植える', weight: 2, rarity: 'R' },
        { label: '料理を1品作って住民にプレゼント', weight: 2, rarity: 'R' },
        { label: '次の15分はコメントで指示された場所へ移動', weight: 2, rarity: 'R' },
        { label: '住民全員にあいさつしに行く', weight: 1, rarity: 'SR' },
        { label: '家具を1つ作って部屋に飾る', weight: 1, rarity: 'SR' },
        { label: '視聴者のリクエストを1つ実行', weight: 0.5, rarity: 'SSR' },
      ],
    },
    action: {
      title: '次にやること ルーレット',
      items: [
        { label: '釣り', weight: 1, rarity: 'N' },
        { label: '虫とり', weight: 1, rarity: 'N' },
        { label: '料理', weight: 1, rarity: 'N' },
        { label: 'ガーデニング', weight: 1, rarity: 'N' },
        { label: '鳥の観察', weight: 1, rarity: 'N' },
        { label: '貝がら集め', weight: 1, rarity: 'N' },
        { label: '家具づくり', weight: 1, rarity: 'N' },
        { label: '視聴者におまかせ', weight: 0.5, rarity: 'SR' },
      ],
    },
  },
  gifts: [
    { giftName: 'Rose', enabled: true, mode: 'roulette', tableId: 'action', title: '次にやること', combo: 'once', comboN: 1, maxRolls: 1 },
    { giftName: 'Finger Heart', enabled: true, mode: 'gacha', tableId: 'shibari', title: '縛りガチャ', combo: 'perCount', comboN: 1, maxRolls: 5 },
  ],
  settings: { staleMinutes: 10, dedupeWindowSec: 3 },
};
