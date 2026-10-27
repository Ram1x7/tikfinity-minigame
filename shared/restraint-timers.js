// 縛りタイマーの純粋な状態遷移。Worker とテストで共通利用する。
// 永続化・認証・描画は呼び出し側が担当する。
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_REMAINING_MS = 7 * MAX_DURATION_MS;
const copy = (state) => ({
  paused: Boolean(state?.paused),
  updatedAt: Number(state?.updatedAt) || 0,
  entries: Array.isArray(state?.entries) ? state.entries.map((x) => ({ ...x })) : [],
});
const active = (x) => x.status === 'active';
const exclusive = (x) => x.group === 'exclusive';
const remaining = (x) => Math.max(0, Number(x.remainingMs) || 0);

function startNext(s) {
  if (s.entries.some((x) => active(x) && exclusive(x))) return;
  const next = s.entries.find((x) => x.status === 'waiting' && exclusive(x));
  if (next) next.status = 'active';
}

/** 時間経過を適用。途中で専用行動が終われば残りの経過時間を次の待機に引き継ぐ。 */
export function advanceTimers(state, now) {
  const s = copy(state);
  const timestamp = Math.max(0, Math.floor(Number(now) || 0));
  let delta = s.paused ? 0 : Math.max(0, timestamp - s.updatedAt);
  s.updatedAt = timestamp;
  if (!delta) return s;
  // 並行可能な制限は経過時間ぶんすべて進める。
  for (const x of s.entries) {
    if (!active(x) || exclusive(x)) continue;
    x.remainingMs = Math.max(0, remaining(x) - delta);
    if (!x.remainingMs) x.status = 'done';
  }
  // 専用行動は1件ずつ進め、余った時間を次へ渡す。
  while (delta > 0) {
    startNext(s);
    const x = s.entries.find((e) => active(e) && exclusive(e));
    if (!x) break;
    const step = Math.min(delta, remaining(x));
    x.remainingMs = Math.max(0, remaining(x) - step);
    delta -= step;
    if (!x.remainingMs) x.status = 'done';
    if (step === 0 && x.status !== 'done') break;
  }
  startNext(s);
  return s;
}

/** 同じ id の実行中・待機中は加算。終了済みなら新規開始。 */
export function awardTimer(state, rule, now) {
  const s = advanceTimers(state, now);
  const id = String(rule?.id || '').trim();
  const label = String(rule?.label || '').trim();
  const durationMs = Math.floor(Number(rule?.durationMs) || 0);
  const group = rule?.group === 'parallel' ? 'parallel' : 'exclusive';
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !label || label.length > 80 ||
      durationMs < 1000 || durationMs > MAX_DURATION_MS) {
    throw new Error('縛りタイマーの設定が不正です');
  }
  const existing = s.entries.find((x) => x.id === id && x.status !== 'done');
  if (existing) {
    const before = remaining(existing);
    existing.remainingMs = Math.min(MAX_REMAINING_MS, before + durationMs);
    existing.totalMs = Math.min(MAX_REMAINING_MS, (Number(existing.totalMs) || before) + durationMs);
    return s;
  }
  const hasExclusive = s.entries.some((x) => active(x) && exclusive(x));
  s.entries.push({
    id, label, group, remainingMs: durationMs, totalMs: durationMs,
    status: group === 'parallel' || !hasExclusive ? 'active' : 'waiting',
  });
  return s;
}

/** 個別操作と全体一時停止。再開時に過去の停止時間を減算しない。 */
export function controlTimers(state, action, now, id = '', amountMs = 0) {
  const s = advanceTimers(state, now);
  if (action === 'pause-all') s.paused = true;
  else if (action === 'resume-all') s.paused = false;
  else {
    const x = s.entries.find((e) => e.id === id && e.status !== 'done');
    if (!x) throw new Error('対象の縛りが見つかりません');
    if (action === 'finish') { x.status = 'done'; x.remainingMs = 0; }
    else if (action === 'adjust') {
      const n = Math.floor(Number(amountMs));
      if (!Number.isFinite(n) || Math.abs(n) > MAX_DURATION_MS) throw new Error('調整時間が不正です');
      x.remainingMs = Math.min(MAX_REMAINING_MS, Math.max(0, remaining(x) + n));
      x.totalMs = Math.max(x.remainingMs, Number(x.totalMs) || x.remainingMs);
      if (!x.remainingMs) x.status = 'done';
    } else throw new Error('操作が不正です');
    startNext(s);
  }
  return s;
}
