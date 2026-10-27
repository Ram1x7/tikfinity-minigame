// Worker側の縛りタイマー永続化。ETag CASで同時更新を直列化する。
import { advanceTimers, awardTimer, controlTimers } from '../../shared/restraint-timers.js';

const TRIES = 8;
const MAX_HISTORY = 120;
const pathFor = (envName) => `envs/${envName}/state/restraints`;

/** 重複イベントを複数回加算しない。eventIdは再生キューのFirebaseキーを使用。 */
export async function updateRestraints(db, envName, action, now = Date.now()) {
  const path = pathFor(envName);
  for (let i = 0; i < TRIES; i++) {
    const { value, etag } = await db.getWithEtag(path);
    const old = value && typeof value === 'object' ? value : { paused: true, updatedAt: now, entries: [], applied: {} };
    const applied = old.applied && typeof old.applied === 'object' ? old.applied : {};
    let next;
    if (action.type === 'award') {
      const key = String(action.eventId || '');
      if (!/^-[A-Za-z0-9_-]{8,40}:[0-9]{1,3}$/.test(key)) throw new Error('イベントIDが不正です');
      if (applied[key]) return { state: advanceTimers(old, now), duplicate: true };
      next = awardTimer(old, action.rule, now);
      const ids = Object.keys(applied);
      // 完了イベントの履歴はサイズを制限（古いイベントの再実行はcursorでも防止）。
      const history = { ...applied, [key]: now };
      for (const id of ids.slice(0, Math.max(0, ids.length + 1 - MAX_HISTORY))) delete history[id];
      next.applied = history;
    } else {
      next = controlTimers(old, action.type, now, action.id, action.amountMs);
      next.applied = applied;
    }
    // 終了した縛りは画面から除去。履歴は別途イベントIDで保持。
    next.entries = next.entries.filter((e) => e.status !== 'done');
    if (await db.putIfMatch(path, next, etag)) return { state: next, duplicate: false };
  }
  throw new Error('タイマーの更新が競合しました。再試行してください');
}
export async function readRestraints(db, envName, now = Date.now()) {
  const value = await db.get(pathFor(envName));
  return advanceTimers(value || { paused: true, updatedAt: now, entries: [] }, now);
}
