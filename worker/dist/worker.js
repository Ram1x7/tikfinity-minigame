// このファイルは scripts/build-worker.mjs が自動生成しています。直接編集しないでください。
// Cloudflare ダッシュボードの Worker エディタに、このファイルの中身をすべて貼り付けて使います。

// ---- shared/core.js ----
// ============================================================
// shared/core.js
// ------------------------------------------------------------
// Worker と ブラウザ(管理画面・テスト画面) の両方で使う純粋な関数だけを置く。
// DOM・Firebase・fetch には一切依存しないので、node --test で単体テストできる。
// ============================================================

const ENVS = ['prod', 'test'];
const MODES = ['gacha', 'roulette'];
const COMBO_MODES = ['once', 'perCount', 'everyN'];
const RARITIES = ['N', 'R', 'SR', 'SSR'];

const LIMITS = {
  gifts: 200,
  tables: 50,
  itemsPerTable: 100,
  label: 80,
  title: 60,
  giftName: 80,
  sender: 40,
  maxRolls: 50,
  repeatCount: 9999,
};

const DEFAULT_SETTINGS = {
  staleMinutes: 10,      // これより古い未再生イベントは表示側で飛ばす
  dedupeWindowSec: 3,    // msgIdが無い時、同じ内容をこの秒数内は重複とみなす(0で無効)
};

function isEnv(v) {
  return ENVS.includes(v);
}

/**
 * ギフト名などを Firebase のキーとして使える形にする(可逆)。
 * Firebaseのキーに使えない . # $ [ ] / と制御文字を %XX に置き換える。
 */
function encodeKey(str) {
  return String(str).replace(/[%.#$[\]/\u0000-\u001f\u007f]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function decodeKey(key) {
  return String(key).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function pick(obj, names) {
  for (const n of names) {
    const v = obj[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function parseBool(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(s)) return true;
  if (['false', '0', 'no'].includes(s)) return false;
  return undefined;
}

function clampInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * TikFinity の Webhook で届いた値(form/JSON/クエリをまとめた平たいオブジェクト)を
 * 統一形式に変換する。TikFinity が実際にどの名前で送ってくるかは受信ログで確認し、
 * 必要ならここの候補名を足す。id・name・count のような汎用的な名前は、
 * ユーザーIDなど別の意味の値を拾う恐れがあるので候補に入れない。
 */
function normalizeGift(fields) {
  const f = fields || {};
  const giftName = pick(f, ['giftName', 'gift_name', 'giftname']).slice(0, LIMITS.giftName);
  return {
    giftName,
    giftId: pick(f, ['giftId', 'gift_id', 'giftid']),
    repeatCount: clampInt(pick(f, ['repeatCount', 'repeat_count', 'repeatcount']), 1, LIMITS.repeatCount, 1),
    sender: pick(f, ['nickname', 'nickName', 'displayName', 'username', 'userName', 'uniqueId', 'unique_id', 'userId'])
      .slice(0, LIMITS.sender) || '視聴者',
    userKey: pick(f, ['uniqueId', 'unique_id', 'userId', 'user_id', 'username', 'nickname']),
    msgId: pick(f, ['msgId', 'msg_id', 'messageId', 'eventId', 'event_id']),
    repeatEnd: parseBool(pick(f, ['repeatEnd', 'repeat_end', 'repeatend'])),
  };
}

/**
 * 連続ギフト(コンボ)の途中経過かどうか。
 * repeatEnd が明示的に false の時だけ「途中」とみなし、確定時の1回だけを処理する。
 * repeatEnd が届かない場合は毎回確定扱い(TikFinityが確定時のみ送る想定)。
 */
function isStreakInProgress(gift) {
  return gift.repeatEnd === false;
}

/** ギフト設定と個数から、抽選する回数を決める */
function rollCount(giftCfg, repeatCount) {
  const max = clampInt(giftCfg.maxRolls, 1, LIMITS.maxRolls, 10);
  const count = clampInt(repeatCount, 1, LIMITS.repeatCount, 1);
  switch (giftCfg.combo) {
    case 'perCount':
      return Math.min(count, max);
    case 'everyN': {
      const n = clampInt(giftCfg.comboN, 1, LIMITS.repeatCount, 1);
      return Math.min(Math.floor(count / n), max);
    }
    case 'once':
    default:
      return 1;
  }
}

/** 0以上1未満の一様乱数。暗号論的乱数を使う */
function secureRandom() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 4294967296;
}

/** 重みが正の候補だけを返す */
function activeItems(table) {
  const items = Array.isArray(table && table.items) ? table.items : [];
  return items.filter((it) => it && it.label && Number(it.weight) > 0);
}

/** 重み付き抽選。rand は 0以上1未満を返す関数(テストで差し替え可能) */
function weightedPick(items, rand = secureRandom) {
  const list = items.filter((it) => Number(it.weight) > 0);
  if (list.length === 0) return null;
  const total = list.reduce((s, it) => s + Number(it.weight), 0);
  let r = rand() * total;
  for (const it of list) {
    r -= Number(it.weight);
    if (r < 0) return it;
  }
  return list[list.length - 1];
}

/** 各候補の当選確率(%)。管理画面の表示用 */
function probabilities(items) {
  const list = Array.isArray(items) ? items : [];
  const total = list.reduce((s, it) => s + Math.max(0, Number(it.weight) || 0), 0);
  return list.map((it) => (total > 0 ? (Math.max(0, Number(it.weight) || 0) / total) * 100 : 0));
}

function str(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

function sanitizeItem(it) {
  const color = str(it.color, 9);
  return {
    label: str(it.label, LIMITS.label),
    weight: Math.max(0, Math.min(1e6, Number(it.weight) || 0)),
    rarity: RARITIES.includes(it.rarity) ? it.rarity : 'N',
    color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '',
  };
}

/**
 * 管理画面から届いた設定を検証・整形する。
 * 不正な値は捨てるか既定値に直し、{ config, errors } を返す。
 * gifts は { [encodeKey(giftName)]: {...} }、tables は { [tableId]: {...} } の形で保存する。
 */
function sanitizeConfig(input) {
  const errors = [];
  const src = input && typeof input === 'object' ? input : {};

  const tables = {};
  const srcTables = src.tables && typeof src.tables === 'object' ? src.tables : {};
  for (const [id, t] of Object.entries(srcTables).slice(0, LIMITS.tables)) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) { errors.push(`テーブルID「${id}」は英数字・_・-のみ使えます`); continue; }
    const items = (Array.isArray(t && t.items) ? t.items : [])
      .slice(0, LIMITS.itemsPerTable)
      .map(sanitizeItem)
      .filter((it) => it.label);
    if (activeItems({ items }).length === 0) errors.push(`テーブル「${id}」に当選確率が0より大きい候補がありません`);
    tables[id] = { title: str(t && t.title, LIMITS.title) || id, items };
  }

  const gifts = {};
  const srcGifts = src.gifts && typeof src.gifts === 'object' ? src.gifts : {};
  for (const g of Object.values(srcGifts).slice(0, LIMITS.gifts)) {
    const giftName = str(g && g.giftName, LIMITS.giftName);
    if (!giftName) continue;
    const tableId = str(g.tableId, 40);
    if (!tables[tableId]) errors.push(`ギフト「${giftName}」の抽選テーブル「${tableId}」が存在しません`);
    gifts[encodeKey(giftName)] = {
      giftName,
      enabled: g.enabled !== false,
      mode: MODES.includes(g.mode) ? g.mode : 'gacha',
      tableId,
      title: str(g.title, LIMITS.title),
      combo: COMBO_MODES.includes(g.combo) ? g.combo : 'once',
      comboN: clampInt(g.comboN, 1, LIMITS.repeatCount, 1),
      maxRolls: clampInt(g.maxRolls, 1, LIMITS.maxRolls, 10),
    };
  }

  const s = src.settings && typeof src.settings === 'object' ? src.settings : {};
  const settings = {
    staleMinutes: clampInt(s.staleMinutes, 0, 1440, DEFAULT_SETTINGS.staleMinutes),
    dedupeWindowSec: clampInt(s.dedupeWindowSec, 0, 60, DEFAULT_SETTINGS.dedupeWindowSec),
  };

  return { config: { gifts, tables, settings }, errors };
}

/**
 * 受信したギフトから、表示側が再生するキュー項目を作る。
 * 抽選はここで1回だけ確定させ、表示側は rolls をそのまま再生する。
 * 処理不要な場合は { skip: '理由' } を返す。
 */
function buildQueueItem(gift, config, rand = secureRandom) {
  if (!gift.giftName) return { skip: 'giftName がありません' };
  if (isStreakInProgress(gift)) return { skip: '連続ギフトの途中経過のため無視' };

  const giftCfg = config && config.gifts && config.gifts[encodeKey(gift.giftName)];
  if (!giftCfg) return { skip: `未設定のギフト: ${gift.giftName}` };
  if (giftCfg.enabled === false) return { skip: `無効化されたギフト: ${gift.giftName}` };

  const table = config.tables && config.tables[giftCfg.tableId];
  const items = activeItems(table);
  if (items.length === 0) return { skip: `抽選候補がありません: ${giftCfg.tableId}` };

  const count = rollCount(giftCfg, gift.repeatCount);
  if (count <= 0) return { skip: `個数が足りません(${gift.repeatCount}個)` };

  const rolls = [];
  for (let i = 0; i < count; i++) {
    const it = weightedPick(items, rand);
    rolls.push({ label: it.label, rarity: it.rarity || 'N', color: it.color || '' });
  }

  return {
    item: {
      giftName: gift.giftName,
      sender: gift.sender,
      repeatCount: gift.repeatCount,
      mode: giftCfg.mode,
      title: giftCfg.title || table.title || '',
      rolls,
      pool: items.map((it) => ({ label: it.label, weight: Number(it.weight), rarity: it.rarity || 'N', color: it.color || '' })),
    },
  };
}

/**
 * 重複判定のルール。
 * - msgId があれば、同じ msgId は(保存期間内なら)何秒離れていても重複。
 * - 無ければ「ギフト名・送信者・個数」が同じものを windowSec 秒以内なら重複。
 * - windowSec が 0 で msgId も無い場合は null(重複判定しない)。
 * 返り値の windowMs が null の場合は「時間に関係なく重複」を意味する。
 */
async function dedupeRule(gift, windowSec) {
  let basis;
  let windowMs;
  if (gift.msgId) {
    basis = `id:${gift.msgId}`;
    windowMs = null;
  } else if (windowSec > 0) {
    basis = `h:${gift.giftName}|${gift.userKey || gift.sender}|${gift.repeatCount}`;
    windowMs = windowSec * 1000;
  } else {
    return null;
  }
  const data = new TextEncoder().encode(basis);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  const key = Array.from(new Uint8Array(digest)).slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  return { key, windowMs };
}

/** 既存の記録(受信時刻)から見て、今回が重複かどうか */
function isDuplicate(existingTs, nowMs, windowMs) {
  if (typeof existingTs !== 'number') return false;
  if (windowMs === null) return true;
  return nowMs - existingTs < windowMs;
}

// ---- worker/src/firebase.js ----
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

function pemToDer(pem) {
  const body = String(pem)
    .replace(/\\n/g, '\n')
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
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

async function getAccessToken(env, fetchImpl = fetch) {
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
  if (!res.ok) throw new Error(`アクセストークン取得失敗 (${res.status})`);
  const json = await res.json();
  cachedToken = { token: json.access_token, exp: nowSec + (json.expires_in || 3600), email: env.SA_CLIENT_EMAIL };
  return cachedToken.token;
}

function resetTokenCache() {
  cachedToken = null;
}

/**
 * パス単位で読み書きする最小限のクライアント。
 * path は先頭スラッシュなし(例: "envs/test/queue")。
 */
function createDb(env, fetchImpl = fetch) {
  const base = String(env.FIREBASE_DB_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('FIREBASE_DB_URL が設定されていません');

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

  async function json(method, path, opts) {
    const res = await call(method, path, opts);
    if (!res.ok) throw new Error(`Firebase ${method} ${path} 失敗 (${res.status})`);
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
      if (!res.ok) throw new Error(`Firebase GET ${path} 失敗 (${res.status})`);
      return { value: await res.json(), etag: res.headers.get('ETag') };
    },

    /** ETagが一致した時だけ書き込む。他で先に書き換えられていたら false */
    async putIfMatch(path, body, etag) {
      const res = await call('PUT', path, { body, headers: { 'if-match': etag } });
      if (res.status === 412) return false;
      if (!res.ok) throw new Error(`Firebase PUT ${path} 失敗 (${res.status})`);
      return true;
    },
  };
}

// ---- worker/src/index.js ----
// ============================================================
// worker/src/index.js  (Cloudflare Worker)
// ------------------------------------------------------------
// TikFinity → (Webhook) → この Worker → Firebase → 表示画面
//
// 【エンドポイント】
//   GET  /                         動作確認用
//   POST /webhook?env=prod&k=鍵     TikFinity からのギフト受信
//   POST /admin/config?env=        設定(ギフト・抽選テーブル・全体設定)を保存
//   POST /admin/test-gift?env=     テスト用の疑似ギフト(Webhookと同じ処理を通す)
//   POST /admin/clear?env=         キュー・重複記録・受信ログ・再生位置を消去
//   POST /admin/copy-config?from=test&to=prod   設定のコピー
//   (/admin/* は X-Admin-Key ヘッダーが必要)
//
// 【Worker の環境変数(シークレット)】
//   FIREBASE_DB_URL   例: https://xxxx-default-rtdb.firebaseio.com
//   SA_CLIENT_EMAIL   サービスアカウントの client_email
//   SA_PRIVATE_KEY    サービスアカウントの private_key (PEM)
//   WEBHOOK_KEY       TikFinity の Webhook URL に付ける合言葉
//   ADMIN_KEY         管理画面・テスト画面で使う合言葉
//   ALLOWED_ORIGIN    (任意) 管理画面の公開元。例: https://ram1x7.github.io
// ============================================================



const QUEUE_KEEP = 300;   // キューに残す件数
const LOG_KEEP = 100;     // 受信ログに残す件数
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function reply(env, status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
  });
}

/** 長さに依存しない比較(合言葉の総当たり対策) */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0 && x.length > 0;
}

/** クエリ・form・JSON のどれで届いても平たいオブジェクトにまとめる */
async function readFields(request, url) {
  const fields = {};
  for (const [k, v] of url.searchParams) {
    if (k !== 'k' && k !== 'env') fields[k] = v;
  }
  const type = request.headers.get('Content-Type') || '';
  try {
    if (type.includes('application/json')) {
      const body = await request.json();
      if (body && typeof body === 'object') flatten(body, fields);
    } else if (type.includes('form')) {
      const form = await request.formData();
      for (const [k, v] of form) fields[k] = typeof v === 'string' ? v : '';
    } else {
      const text = await request.text();
      if (text.trim().startsWith('{')) flatten(JSON.parse(text), fields);
      else for (const [k, v] of new URLSearchParams(text)) fields[k] = v;
    }
  } catch {
    // 本文が読めなくてもクエリだけで処理を続ける
  }
  return fields;
}

/** {data:{giftName:..}} のような入れ子も、末端のキー名で拾えるようにする */
function flatten(obj, out, depth = 0) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) flatten(v, out, depth + 1);
    else if (out[k] === undefined) out[k] = v === null ? '' : String(v);
  }
}

function trimFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields).slice(0, 40)) {
    const key = k.replace(/[.#$[\]/]/g, '_').slice(0, 40) || '_';
    out[key] = String(v).slice(0, 200);
  }
  return out;
}

async function loadConfig(db, envName) {
  const config = (await db.get(`envs/${envName}/config`)) || {};
  return {
    gifts: config.gifts || {},
    tables: normalizeTables(config.tables || {}),
    settings: { ...DEFAULT_SETTINGS, ...(config.settings || {}) },
  };
}

/** Firebase は配列を {0:..,1:..} で返すことがあるので配列に戻す */
function normalizeTables(tables) {
  const out = {};
  for (const [id, t] of Object.entries(tables)) {
    const items = Array.isArray(t.items) ? t.items : Object.values(t.items || {});
    out[id] = { ...t, items: items.filter(Boolean) };
  }
  return out;
}

/**
 * 重複なら { duplicate: true }。初めてなら受信時刻を記録し、
 * 後続の処理が失敗した時に記録を取り消すための undo を返す。
 */
async function checkAndMarkDuplicate(db, envName, gift, settings, nowMs) {
  const rule = await dedupeRule(gift, Number(settings.dedupeWindowSec) || 0);
  if (!rule) return { duplicate: false, undo: async () => {} };
  const path = `envs/${envName}/dedupe/${rule.key}`;
  const { value, etag } = await db.getWithEtag(path);
  if (isDuplicate(value, nowMs, rule.windowMs)) return { duplicate: true };
  // ほぼ同時に同じ内容が届いた場合、先に書いた方だけが成功する
  const ok = await db.putIfMatch(path, nowMs, etag);
  if (!ok) return { duplicate: true };
  return {
    duplicate: false,
    // 元の値に戻す(初回なら削除)。TikFinity が再送した時に重複扱いされないように
    undo: () => (value === null ? db.remove(path) : db.put(path, value)),
  };
}

/** ギフト1件を処理してキューに積む(Webhook とテストで共通) */
async function processGift(db, envName, fields, source, nowMs = Date.now()) {
  const gift = normalizeGift(fields);
  const config = await loadConfig(db, envName);

  let result;
  const mark = await checkAndMarkDuplicate(db, envName, gift, config.settings, nowMs);
  if (mark.duplicate) {
    result = { status: 'duplicate' };
  } else {
    const built = buildQueueItem(gift, config);
    if (built.skip) {
      result = { status: 'skipped', reason: built.skip };
    } else {
      const item = { ...built.item, source, receivedAt: { '.sv': 'timestamp' } };
      try {
        const { name } = await db.post(`envs/${envName}/queue`, item);
        result = { status: 'queued', key: name, rolls: built.item.rolls.map((r) => r.label) };
      } catch (err) {
        await mark.undo().catch(() => {});
        throw err;
      }
    }
  }

  await db.post(`envs/${envName}/log`, {
    at: { '.sv': 'timestamp' },
    source,
    fields: trimFields(fields),
    result: { status: result.status, reason: result.reason || '', key: result.key || '' },
  });
  return result;
}

/** 古いデータを消して容量を一定に保つ */
async function cleanup(db, envName, nowMs) {
  const trim = async (path, keep) => {
    const keys = Object.keys((await db.get(path, { shallow: 'true' })) || {}).sort();
    if (keys.length <= keep) return;
    const patch = {};
    for (const k of keys.slice(0, keys.length - keep)) patch[k] = null;
    await db.patch(path, patch);
  };
  await trim(`envs/${envName}/queue`, QUEUE_KEEP);
  await trim(`envs/${envName}/log`, LOG_KEEP);

  const old = await db.get(`envs/${envName}/dedupe`, {
    orderBy: '"$value"',
    endAt: String(nowMs - DEDUPE_TTL_MS),
    limitToFirst: '200',
  });
  const keys = Object.keys(old || {});
  if (keys.length > 0) {
    const patch = {};
    for (const k of keys) patch[k] = null;
    await db.patch(`envs/${envName}/dedupe`, patch);
  }
}

async function handleAdmin(request, env, db, url, ctx) {
  if (!safeEqual(request.headers.get('X-Admin-Key'), env.ADMIN_KEY)) {
    return reply(env, 401, { error: '管理用の合言葉が違います' });
  }
  const path = url.pathname;

  if (path === '/admin/copy-config') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!isEnv(from) || !isEnv(to) || from === to) return reply(env, 400, { error: 'from/to が不正です' });
    const config = await db.get(`envs/${from}/config`);
    await db.put(`envs/${to}/config`, config || {});
    return reply(env, 200, { ok: true });
  }

  const envName = url.searchParams.get('env');
  if (!isEnv(envName)) return reply(env, 400, { error: 'env は prod か test を指定してください' });

  if (path === '/admin/config') {
    const body = await request.json().catch(() => null);
    const { config, errors } = sanitizeConfig(body);
    await db.put(`envs/${envName}/config`, config);
    return reply(env, 200, { ok: true, warnings: errors });
  }

  if (path === '/admin/test-gift') {
    const body = await request.json().catch(() => ({}));
    const result = await processGift(db, envName, body || {}, 'test');
    ctx.waitUntil(cleanup(db, envName, Date.now()).catch(() => {}));
    return reply(env, 200, result);
  }

  if (path === '/admin/clear') {
    await db.patch(`envs/${envName}`, { queue: null, dedupe: null, log: null, state: null });
    return reply(env, 200, { ok: true });
  }

  return reply(env, 404, { error: 'not found' });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return reply(env, 200, { ok: true, service: 'tikfinity-minigame' });
    }
    if (request.method !== 'POST') return reply(env, 405, { error: 'POST のみ受け付けます' });

    try {
      const db = createDb(env);

      if (url.pathname === '/webhook') {
        if (!safeEqual(url.searchParams.get('k'), env.WEBHOOK_KEY)) {
          return reply(env, 401, { error: 'Webhook の合言葉が違います' });
        }
        const envName = url.searchParams.get('env') || 'prod';
        if (!isEnv(envName)) return reply(env, 400, { error: 'env は prod か test を指定してください' });
        const fields = await readFields(request, url);
        const result = await processGift(db, envName, fields, 'webhook');
        ctx.waitUntil(cleanup(db, envName, Date.now()).catch(() => {}));
        // TikFinity に再送させないよう、処理しなかった場合も 200 を返す
        return reply(env, 200, result);
      }

      if (url.pathname.startsWith('/admin/')) {
        return await handleAdmin(request, env, db, url, ctx);
      }

      return reply(env, 404, { error: 'not found' });
    } catch (err) {
      return reply(env, 500, { error: String(err && err.message ? err.message : err) });
    }
  },
};
