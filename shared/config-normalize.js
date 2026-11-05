// Firebase Realtime Database から返る配列・オブジェクト形式を統一する。
// 管理画面と表示画面の両方で使うため、ブラウザSDKに依存させない。
export function normalizeConfig(raw) {
  const config = raw || {};
  const tables = {};
  for (const [id, t] of Object.entries(config.tables || {})) {
    const items = Array.isArray(t.items) ? t.items : Object.values(t.items || {});
    tables[id] = { ...t, items: items.filter(Boolean) };
  }
  const triggers = Array.isArray(config.triggers)
    ? config.triggers
    : Object.values(config.triggers || {});
  return {
    gifts: config.gifts || {},
    tables,
    triggers: triggers.filter(Boolean),
    settings: config.settings || {},
  };
}
