// ギフトガチャ専用の未完了リスト。各抽選を独立したタスクとして記録する。
// 既存の抽選キュー、縛りタイマーとは完全に別の Firebase パスを使用。
export function todoEntries(queueKey, item) {
  if (item?.mode !== 'gacha' || !/^-[A-Za-z0-9_-]{8,40}$/.test(String(queueKey || ''))) return {};
  const rolls = Array.isArray(item.rolls) ? item.rolls : Object.values(item.rolls || {});
  const entries = {};
  rolls.forEach((roll, index) => {
    if (!roll || !String(roll.label || '').trim()) return;
    const key = `${queueKey}_${String(index).padStart(3, '0')}`;
    entries[key] = {
      label: String(roll.label).slice(0, 80),
      sender: String(item.sender || '視聴者').slice(0, 40),
      giftName: String(item.giftName || '').slice(0, 80),
      createdAt: { '.sv': 'timestamp' },
    };
  });
  return entries;
}

export function todoSorted(pending) {
  return Object.entries(pending || {})
    .filter(([key, value]) => /^-[A-Za-z0-9_-]{8,40}_[0-9]{3}$/.test(key) && value && typeof value === 'object')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([id, value]) => ({ id, ...value }));
}
