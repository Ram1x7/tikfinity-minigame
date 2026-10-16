// ============================================================
// worker/src/firebase.js
// ------------------------------------------------------------
// Firebase Realtime Database の REST API を、サービスアカウントの
// アクセストークン付きで呼ぶための小さなクライアント。
// サービスアカウントで書き込むとセキュリティルールの制約を受けないので、
// ルールではブラウザからの書き込みを原則禁止にできる。
// ============================================================

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

let cachedToken = null; // { token, exp, email }

function b64url(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * SA_PRIVATE_KEY の貼り付けミスをある程度吸収する。
 * - 前後の " を含めて貼った場合
 * - 改行が \n という文字になっている場合
 * - 秘密鍵の JSON ファイルを丸ごと貼った場合
 */
export function extractPrivateKey(value) {
  let v = String(value || '').trim();
  if (v.startsWith('{')) {
    try { v = String(JSON.parse(v).private_key || ''); } catch { /* そのまま扱う */ }
  }
  v = v.replace(/^"+|"+$/g, '').replace(/\\n/g, '\n');
  return v.trim();
}

function pemToDer(pem) {
  const text = extractPrivateKey(pem);
  if (!text.includes('BEGIN PRIVATE KEY')) {
    throw new Error('SA_PRIVATE_KEY の形式が正しくありません(-----BEGIN PRIVATE KEY----- から始まる値を入れてください)');
  }
  const body = text
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der.buffer;
}

async function signJwt(clientEmail, privateKeyPem, nowSec) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientEmail,
    scope: SCOPES,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  let key;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      pemToDer(privateKeyPem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
  } catch (err) {
    if (String(err.message).includes('SA_PRIVATE_KEY')) throw err;
    throw new Error('SA_PRIVATE_KEY を読み込めません。秘密鍵 JSON の private_key の値を、BEGIN から END まで全部貼り付けてください');
  }
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

export async function getAccessToken(env, fetchImpl = fetch) {
  if (!env.SA_CLIENT_EMAIL) throw new Error('SA_CLIENT_EMAIL が設定されていません');
  if (!env.SA_PRIVATE_KEY) throw new Error('SA_PRIVATE_KEY が設定されていません');
  const nowSec = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.email === env.SA_CLIENT_EMAIL && cachedToken.exp - 300 > nowSec) {
    return cachedToken.token;
  }
  const assertion = await signJwt(env.SA_CLIENT_EMAIL, env.SA_PRIVATE_KEY, nowSec);
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`サービスアカウントの認証に失敗 (${res.status}) ${detail.slice(0, 200)}`.trim());
  }
  const json = await res.json();
  cachedToken = { token: json.access_token, exp: nowSec + (json.expires_in || 3600), email: env.SA_CLIENT_EMAIL };
  return cachedToken.token;
}

export function resetTokenCache() {
  cachedToken = null;
}

/**
 * パス単位で読み書きする最小限のクライアント。
 * path は先頭スラッシュなし(例: "envs/test/queue")。
 */
export function createDb(env, fetchImpl = fetch) {
  const base = String(env.FIREBASE_DB_URL || '').trim().replace(/^"+|"+$/g, '').replace(/\/+$/, '');
  if (!base) throw new Error('FIREBASE_DB_URL が設定されていません');
  if (!/^https:\/\/[^/]+\.(firebaseio\.com|firebasedatabase\.app)$/.test(base)) {
    throw new Error('FIREBASE_DB_URL の形式が正しくありません(https://〜.firebaseio.com または https://〜.firebasedatabase.app の形で、後ろに何も付けない)');
  }

  async function url(path, query = {}) {
    const token = await getAccessToken(env, fetchImpl);
    const qs = new URLSearchParams({ ...query, access_token: token });
    return `${base}/${path}.json?${qs.toString()}`;
  }

  async function call(method, path, { body, query, headers } = {}) {
    const res = await fetchImpl(await url(path, query), {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res;
  }

  async function fail(method, path, res) {
    const detail = await res.text().catch(() => '');
    return new Error(`Firebase ${method} ${path} 失敗 (${res.status}) ${detail.slice(0, 200)}`.trim());
  }

  async function json(method, path, opts) {
    const res = await call(method, path, opts);
    if (!res.ok) throw await fail(method, path, res);
    return res.json();
  }

  return {
    get: (path, query) => json('GET', path, { query }),
    put: (path, body) => json('PUT', path, { body }),
    patch: (path, body) => json('PATCH', path, { body }),
    post: (path, body) => json('POST', path, { body }),
    remove: (path) => json('DELETE', path),

    /** 値とETagを取得する(条件付き書き込み用) */
    async getWithEtag(path) {
      const res = await call('GET', path, { headers: { 'X-Firebase-ETag': 'true' } });
      if (!res.ok) throw await fail('GET', path, res);
      return { value: await res.json(), etag: res.headers.get('ETag') };
    },

    /** ETagが一致した時だけ書き込む。他で先に書き換えられていたら false */
    async putIfMatch(path, body, etag) {
      const res = await call('PUT', path, { body, headers: { 'if-match': etag } });
      if (res.status === 412) return false;
      if (!res.ok) throw await fail('PUT', path, res);
      return true;
    },
  };
}
