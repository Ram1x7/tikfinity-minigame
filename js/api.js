// ============================================================
// js/api.js
// ------------------------------------------------------------
// 管理画面・テスト画面から Worker を呼ぶための関数。
// Worker の URL と管理用の合言葉は、この端末のブラウザにだけ保存する。
// ============================================================
import { DEFAULT_WORKER_URL } from './config.js';

const KEY_URL = 'tm.workerUrl';
const KEY_ADMIN = 'tm.adminKey';

function read(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* プライベートブラウズ等では保存できない */ }
}

export function getConnection() {
  return {
    workerUrl: (read(KEY_URL) || DEFAULT_WORKER_URL).replace(/\/+$/, ''),
    adminKey: read(KEY_ADMIN),
  };
}

export function saveConnection({ workerUrl, adminKey }) {
  write(KEY_URL, String(workerUrl || '').trim().replace(/\/+$/, ''));
  write(KEY_ADMIN, String(adminKey || '').trim());
}

async function call(path, body) {
  const { workerUrl, adminKey } = getConnection();
  if (!workerUrl) throw new Error('Worker の URL が未設定です(管理画面の「接続設定」)');
  if (!adminKey) throw new Error('管理用の合言葉が未設定です(管理画面の「接続設定」)');
  let res;
  try {
    res = await fetch(workerUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new Error('Worker に接続できません。URL を確認してください');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

export const saveConfig = (env, config) => call(`/admin/config?env=${env}`, config);
export const sendTestGift = (env, gift) => call(`/admin/test-gift?env=${env}`, gift);
export const clearEnv = (env) => call(`/admin/clear?env=${env}`);
export const copyConfig = (from, to) => call(`/admin/copy-config?from=${from}&to=${to}`);
