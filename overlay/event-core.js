// TikFinity等のイベントを画面表示向けに正規化する純粋関数。
// Webhookの生データを信頼しない。正式なフィールド仕様が判明したら入力マッピングを拡張する。
export const EVENT_TYPES = Object.freeze(['gift','like','follow','comment','attendance']);
export function normalizeOverlayEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = String(raw.type || '').toLowerCase();
  if (!EVENT_TYPES.includes(type)) return null;
  const sender = String(raw.sender || raw.nickname || '視聴者').slice(0,40);
  const name = String(raw.name || raw.giftName || '').slice(0,70);
  const count = Math.max(1,Math.min(9999,Math.floor(Number(raw.count ?? raw.repeatCount ?? 1) || 1)));
  const timestamp = Number(raw.timestamp ?? raw.receivedAt);
  return { type, sender, name, count, timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null };
}
export function applyOverlayEvent(state, event) {
  if (!event || !EVENT_TYPES.includes(event.type)) return state;
  const next = { ...state, likes: Number(state.likes)||0, follows:Number(state.follows)||0, attendance:Number(state.attendance)||0 };
  if (event.type === 'like') next.likes += event.count;
  if (event.type === 'follow') next.follows += 1;
  if (event.type === 'attendance') next.attendance += 1;
  return next;
}
