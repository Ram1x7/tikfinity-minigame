// ============================================================
// worker/src/http.js  Worker の応答・合言葉の比較などの小物
// ============================================================

export function reply(cors, status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}

/**
 * この Worker で使ってよい環境の一覧(ALLOWED_ENVS。例 "test")。
 * 未設定なら null(prod・test の両方を使える。本番の Worker はこれまでどおり)。
 * 設定されているのに prod・test が1つも書かれていなければ、空の一覧(どの環境も使えない)にする。
 */
export function allowedEnvs(workerEnv) {
  const raw = String((workerEnv && workerEnv.ALLOWED_ENVS) || '').trim();
  if (!raw) return null;
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s === 'prod' || s === 'test');
}

/** env をこの Worker で使ってよいか(prod / test 以外は常に不可) */
export function envAllowed(workerEnv, envName) {
  if (envName !== 'prod' && envName !== 'test') return false;
  const list = allowedEnvs(workerEnv);
  return list === null || list.includes(envName);
}

export const ENV_DENIED = 'この Worker ではこの環境は使えません(ALLOWED_ENVS)';

/** 長さに依存しない比較(合言葉の総当たり対策) */
export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0 && x.length > 0;
}
