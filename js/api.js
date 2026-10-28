// ============================================================
// js/api.js
// ------------------------------------------------------------
// 管理画面・テスト画面から Worker を呼ぶための関数。
// Worker の URL・管理用の合言葉・表示用の合言葉は、この端末のブラウザにだけ保存する。
// ============================================================
import { DEFAULT_WORKER_URL } from './config.js';

const KEY_URL = 'tm.workerUrl';
const KEY_ADMIN = 'tm.adminKey';
const keyDisplay = (env) => `tm.displayKey.${env === 'prod' ? 'prod' : 'test'}`;

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
    // 表示画面の URL に付ける合言葉(Worker の DISPLAY_KEY_PROD / DISPLAY_KEY_TEST)
    displayKeys: { prod: read(keyDisplay('prod')), test: read(keyDisplay('test')) },
  };
}

export function saveConnection({ workerUrl, adminKey, displayKeys = {} }) {
  write(KEY_URL, String(workerUrl || '').trim().replace(/\/+$/, ''));
  write(KEY_ADMIN, String(adminKey || '').trim());
  for (const env of ['prod', 'test']) {
    if (displayKeys[env] !== undefined) write(keyDisplay(env), String(displayKeys[env] || '').trim());
  }
}

/**
 * PRISM LIVE に設定する表示画面の URL に付けるパラメーター。
 * 表示用の合言葉(dk)と、js/config.js と違う Worker を使う場合はその URL(w)。
 * 合言葉が未設定なら null。
 */
export function streamParams(env) {
  const c = getConnection();
  const dk = c.displayKeys[env === 'prod' ? 'prod' : 'test'];
  if (!dk) return null;
  const out = { dk };
  const defaultUrl = String(DEFAULT_WORKER_URL || '').trim().replace(/\/+$/, '');
  if (c.workerUrl && c.workerUrl !== defaultUrl) out.w = c.workerUrl;
  return out;
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
    throw new Error('Worker から応答を受け取れませんでした。管理画面の「接続設定」→「接続テスト」で原因を確認してください');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

export const controlGachaTodo = (env, body) => call(`/admin/gacha-todo?env=${env}`, body);
export const readRestraints = (env) => call(`/admin/restraints?env=${env}`, { type: 'read' });
export const controlRestraints = (env, body) => call(`/admin/restraints?env=${env}`, body);
export const saveConfig = (env, config) => call(`/admin/config?env=${env}`, config);
export const sendTestGift = (env, gift) => call(`/admin/test-gift?env=${env}`, gift);
export const clearEnv = (env) => call(`/admin/clear?env=${env}`);
export const copyConfig = (from, to) => call(`/admin/copy-config?from=${from}&to=${to}`);
/** 表示画面の再生担当を外す(待機中の別の表示画面が次の確認で担当になる) */
export const releasePlayer = (env) => call(`/admin/display/release?env=${env}`);

/**
 * 接続テスト。どこで止まっているかを順番に調べ、
 * [{ ok: true|false|null, label, detail }] の形で返す(null は「確認できず」)。
 */
export async function diagnose(workerUrlInput, adminKeyInput) {
  const results = [];
  const add = (ok, label, detail = '') => results.push({ ok, label, detail });
  const workerUrl = String(workerUrlInput || '').trim().replace(/\/+$/, '');
  const adminKey = String(adminKeyInput || '').trim();

  // 1. URL の形
  let url;
  try { url = new URL(workerUrl); } catch { /* 下で判定 */ }
  if (!url || url.protocol !== 'https:') {
    add(false, 'Worker の URL の形', 'https:// から始まる URL を入れてください');
    return results;
  }
  if (/cloudflare\.com$/.test(url.hostname)) {
    add(false, 'Worker の URL の形', 'Cloudflare の管理画面の URL になっています。Worker の「〜.workers.dev」の URL を入れてください');
    return results;
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    add(false, 'Worker の URL の形', `URL の後ろに「${url.pathname}」が付いています。「https://〜.workers.dev」までにしてください`);
    return results;
  }
  add(true, 'Worker の URL の形');

  // 2. Worker が応答するか(このミニゲームのコードが動いているか)
  let info = null;
  try {
    const res = await fetch(`${url.origin}/`, { method: 'GET' });
    info = await res.json().catch(() => null);
  } catch {
    // 応答が読めない。そもそも届かないのか、届いているが読めないのかを調べる
    let reachable = false;
    try {
      await fetch(`${url.origin}/`, { method: 'GET', mode: 'no-cors' });
      reachable = true;
    } catch { /* 届かない */ }
    add(false, 'Worker の応答', reachable
      ? 'Worker には届いていますが、応答を読めません。Worker に worker/dist/worker.js が貼り付けられて「デプロイ」されているか確認してください(Hello World のままだとこうなります)'
      : 'Worker に接続できません。URL が正しいか確認してください');
    return results;
  }
  if (!info || info.service !== 'tikfinity-minigame') {
    add(false, 'Worker の応答', 'このミニゲームの Worker ではありません。worker/dist/worker.js を貼り付けてデプロイしてください');
    return results;
  }
  add(true, 'Worker の応答', `バージョン ${info.version || '1.0.0(古い版)'}`);

  // 3. シークレット
  if (info.secrets) {
    const missing = Object.entries(info.secrets).filter(([, v]) => !v).map(([k]) => k);
    add(missing.length === 0, 'Worker のシークレット', missing.length ? `未設定: ${missing.join(', ')}` : 'すべて設定済み');
  } else {
    add(null, 'Worker のシークレット', 'Worker が古い版のため確認できません。最新の worker/dist/worker.js を貼り付けてください');
  }

  if (Array.isArray(info.allowedEnvs)) {
    add(true, 'この Worker で使える環境', info.allowedEnvs.length
      ? info.allowedEnvs.map((e) => (e === 'prod' ? '本番' : 'テスト')).join('・') + 'のみ(ALLOWED_ENVS)'
      : 'なし(ALLOWED_ENVS の値を確認してください)');
    if (!info.allowedEnvs.includes('prod')) {
      // 本番への要求を本当に拒否するか確かめる。合言葉を付けないので、拒否されなくても何も読み書きしない
      try {
        const res = await fetch(`${url.origin}/display/claim?env=prod`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
        add(res.status === 403, '本番への要求の拒否', res.status === 403 ? '本番(env=prod)への要求は拒否されます' : `拒否されませんでした(応答 ${res.status})。ALLOWED_ENVS を確認してください`);
      } catch {
        add(null, '本番への要求の拒否', '確認できませんでした');
      }
    }
  }

  if (info.allowedOrigins && info.allowedOrigins.length > 0 && !info.allowedOrigins.includes(location.origin)) {
    add(false, 'ALLOWED_ORIGIN', `このページ(${location.origin})が許可されていません。ALLOWED_ORIGIN を「${location.origin}」にするか、削除してください`);
    return results;
  }

  // 4. 管理用の合言葉と Firebase
  if (!adminKey) {
    add(false, '管理用の合言葉', '入力されていません');
    return results;
  }
  let ping;
  try {
    const res = await fetch(`${url.origin}/admin/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: '{}',
    });
    ping = { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    add(false, '管理用の合言葉', 'Worker から応答を受け取れませんでした。ALLOWED_ORIGIN を設定している場合は、いったん削除して試してください');
    return results;
  }
  if (ping.status === 401) {
    add(false, '管理用の合言葉', '合言葉が Worker の ADMIN_KEY と一致しません');
    return results;
  }
  if (ping.status === 404 || ping.status === 400) {
    add(null, '管理用の合言葉・Firebase', 'Worker が古い版のため確認できません。最新の worker/dist/worker.js を貼り付けてください');
    return results;
  }
  if (ping.status >= 500) {
    add(false, 'Worker の設定', ping.body.error || `エラー (${ping.status})`);
    return results;
  }
  add(true, '管理用の合言葉');
  if (ping.body.firebase === 'ok') add(true, 'Worker から Firebase への接続');
  else add(false, 'Worker から Firebase への接続', ping.body.firebase || ping.body.error || `エラー (${ping.status})`);
  return results;
}
