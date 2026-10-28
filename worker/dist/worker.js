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
    // 空欄なら従来どおりタイマーなし。IDは重複当選の加算キー。
    timer: sanitizeTimer(it.timer),
  };
}

function sanitizeTimer(input) {
  if (!input || input.enabled === false || (input.enabled !== true && input.durationMs === undefined)) return null;
  const id = str(input.id, 100);
  const minutes = Number(input.minutes ?? (Number(input.durationMs) / 60000));
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) ||
      !Number.isFinite(minutes) || minutes < 1 / 60 || minutes > 1440) return null;
  return {
    id,
    durationMs: Math.round(minutes * 60000),
    group: input.group === 'parallel' ? 'parallel' : 'exclusive',
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
    (Array.isArray(t?.items) ? t.items : []).slice(0, LIMITS.itemsPerTable).forEach((raw, index) => {
      if (raw?.timer?.enabled === true && !sanitizeTimer(raw.timer)) {
        errors.push(`テーブル「${id}」の候補${index + 1}: タイマーIDは英数字・_・-、時間は1秒〜1440分にしてください`);
      }
    });
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
    rolls.push({ label: it.label, rarity: it.rarity || 'N', color: it.color || '', ...(it.timer ? { timer: { ...it.timer, label: it.label } } : {}) });
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

// ---- shared/restraint-timers.js ----
// 縛りタイマーの純粋な状態遷移。Worker とテストで共通利用する。
// 永続化・認証・描画は呼び出し側が担当する。
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_REMAINING_MS = 7 * MAX_DURATION_MS;
const copy = (state) => ({
  paused: Boolean(state?.paused),
  updatedAt: Number(state?.updatedAt) || 0,
  entries: Array.isArray(state?.entries) ? state.entries.map((x) => ({ ...x })) : [],
  applied: state?.applied && typeof state.applied === 'object' ? { ...state.applied } : {},
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
function advanceTimers(state, now) {
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
function awardTimer(state, rule, now) {
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
function controlTimers(state, action, now, id = '', amountMs = 0) {
  const s = advanceTimers(state, now);
  if (action === 'reset-all') { s.entries = []; s.paused = false; }
  else if (action === 'pause-all') s.paused = true;
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

// ---- shared/gacha-todo.js ----
// ギフトガチャ専用の未完了リスト。各抽選を独立したタスクとして記録する。
// 既存の抽選キュー、縛りタイマーとは完全に別の Firebase パスを使用。
function todoEntries(queueKey, item) {
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

function todoSorted(pending) {
  return Object.entries(pending || {})
    .filter(([key, value]) => /^-[A-Za-z0-9_-]{8,40}_[0-9]{3}$/.test(key) && value && typeof value === 'object')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([id, value]) => ({ id, ...value }));
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

/**
 * SA_PRIVATE_KEY の貼り付けミスをある程度吸収する。
 * - 前後の " を含めて貼った場合
 * - 改行が \n という文字になっている場合
 * - 秘密鍵の JSON ファイルを丸ごと貼った場合
 */
function extractPrivateKey(value) {
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

async function getAccessToken(env, fetchImpl = fetch) {
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

function resetTokenCache() {
  cachedToken = null;
}

/**
 * パス単位で読み書きする最小限のクライアント。
 * path は先頭スラッシュなし(例: "envs/test/queue")。
 */
function createDb(env, fetchImpl = fetch) {
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

// ---- worker/src/http.js ----
// ============================================================
// worker/src/http.js  Worker の応答・合言葉の比較などの小物
// ============================================================

function reply(cors, status, data) {
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
function allowedEnvs(workerEnv) {
  const raw = String((workerEnv && workerEnv.ALLOWED_ENVS) || '').trim();
  if (!raw) return null;
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s === 'prod' || s === 'test');
}

/** env をこの Worker で使ってよいか(prod / test 以外は常に不可) */
function envAllowed(workerEnv, envName) {
  if (envName !== 'prod' && envName !== 'test') return false;
  const list = allowedEnvs(workerEnv);
  return list === null || list.includes(envName);
}

const ENV_DENIED = 'この Worker ではこの環境は使えません(ALLOWED_ENVS)';

/** 長さに依存しない比較(合言葉の総当たり対策) */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0 && x.length > 0;
}

// ---- worker/src/display.js ----
// ============================================================
// worker/src/display.js  表示画面の「再生担当」と再生位置の保存
// ------------------------------------------------------------
// 再生位置(envs/{env}/state/display)はブラウザから直接書き込めないようにし、
// 表示用の合言葉(本番 DISPLAY_KEY_PROD / テスト DISPLAY_KEY_TEST)を持つ表示画面から、
// この Worker 経由でだけ更新する。
//
// 同時に再生できる表示画面は環境ごとに1つ(再生担当)。
//   POST /display/claim?env=      担当になる(空いていれば担当、使用中なら待機)
//   POST /display/heartbeat?env=  担当の更新(10秒ごと)。担当でなければ 409
//   POST /display/cursor?env=     再生位置の保存。担当からの要求だけ受け付ける
//   POST /display/release?env=    担当を降りる(ページを閉じる時)
//   POST /admin/display/release?env=  管理画面から担当を外す(次に要求した画面が担当になる)
// 本文は JSON(Content-Type: text/plain でも可)。{ dk: 表示用の合言葉, id: 画面のID, token, key }
//
// 担当の状態は state/display/player に { id, tokenHash, gen, since, expiresAt } で持つ。
//   - 担当が動いている(期限内)あいだは、別の画面に担当を渡さない
//   - 30秒更新が無ければ期限切れとなり、次に要求した画面が引き継ぐ
//   - 再読み込みした画面は、前回受け取った token を出せば待たずに担当へ戻れる。
//     画面ID だけでは戻れない(token は担当になった時にその画面にだけ渡し、Worker は SHA-256 だけを保存)。
//     戻るたびに token を新しくするので、古い token の写しは使えなくなる
// 担当の入れ替えと再生位置の保存が同時に起きても、ETag 付きの書き込みでどちらか一方だけが通る。
// 管理画面から外された画面は、30秒間は担当に戻れない(待機中の別の画面に確実に切り替えるため)。
// ============================================================


const PLAYER_TTL_MS = 30 * 1000;   // 更新が無ければ担当が切れるまでの時間
const HEARTBEAT_MS = 10 * 1000;    // 担当の更新間隔(表示画面に伝える)
const STANDBY_POLL_MAX_MS = 10 * 1000;    // 待機中の画面が担当を確認し直す間隔の上限
const CAS_TRIES = 5;

const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;
const QUEUE_KEY_RE = /^-[0-9A-Za-z_-]{8,40}$/;

/** 環境ごとの表示用の合言葉の名前(本番とテストで別々) */
function displayKeyName(envName) {
  return envName === 'prod' ? 'DISPLAY_KEY_PROD' : 'DISPLAY_KEY_TEST';
}

function tokenB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken() {
  return tokenB64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 担当になる要求への判断(DB に依存しない。テスト用に公開)。
 *   resume  … 同じ画面が正しい token で戻ってきた
 *   claim   … 担当がいない・期限切れなので新しく担当になる
 *   standby … 担当が動いているので待つ(retryAfterMs 後に確認し直す)
 */
function decideClaim(player, { id, tokenHash }, nowMs, released = null) {
  const standby = (until) => ({
    action: 'standby',
    retryAfterMs: Math.max(2000, Math.min(STANDBY_POLL_MAX_MS, Number(until) - nowMs + 500)),
  });
  if (player && tokenHash && player.id === id && safeEqual(player.tokenHash, tokenHash)) return { action: 'resume' };
  if (player && Number(player.expiresAt) > nowMs) return standby(player.expiresAt);
  // 管理画面から外された画面は、しばらくのあいだ担当に戻れない
  if (released && released.id === id && Number(released.until) > nowMs) return standby(released.until);
  return { action: 'claim' };
}

/** 要求してきた画面が今の担当か(期限切れでも、まだ誰にも引き継がれていなければ担当のまま) */
function isHolder(player, id, tokenHash) {
  return Boolean(player && tokenHash && player.id === id && safeEqual(player.tokenHash, tokenHash));
}

/**
 * 読んだ値をもとに書き込む。他で先に書き換えられていたら読み直してやり直す。
 * fn(value) は { write?, result } を返す(write が無ければ書き込まない)。
 */
async function updateDisplayState(db, path, fn) {
  for (let i = 0; i < CAS_TRIES; i++) {
    const { value, etag } = await db.getWithEtag(path);
    const out = fn(value && typeof value === 'object' ? value : {});
    if (out.write === undefined) return out.result;
    if (await db.putIfMatch(path, out.write, etag)) return out.result;
  }
  throw new Error('再生担当の更新が混み合っています。少し待ってからやり直してください');
}

async function readDisplayBody(request) {
  try {
    const v = JSON.parse(await request.text());
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

const notHolder = (cors) => reply(cors, 409, { lost: true, error: '再生担当ではありません(別の表示画面が担当しています)' });

async function handleDisplay(request, env, db, url, cors) {
  const envName = url.searchParams.get('env');
  if (!isEnv(envName)) return reply(cors, 400, { error: 'env は prod か test を指定してください' });
  if (!envAllowed(env, envName)) return reply(cors, 403, { error: ENV_DENIED });
  const body = await readDisplayBody(request);
  const keyName = displayKeyName(envName);
  if (!env[keyName] || !String(env[keyName]).trim()) {
    return reply(cors, 503, { error: `${keyName} が Worker に設定されていません` });
  }
  if (!safeEqual(body.dk, env[keyName])) return reply(cors, 401, { error: '表示用の合言葉が違います' });
  const id = String(body.id || '');
  if (!ID_RE.test(id)) return reply(cors, 400, { error: '画面の ID が不正です' });
  const tokenHash = TOKEN_RE.test(String(body.token || '')) ? await sha256Hex(body.token) : '';

  const path = `envs/${envName}/state/display`;
  const now = Date.now();

  if (url.pathname === '/display/claim') {
    const token = randomToken();
    const newHash = await sha256Hex(token);
    const result = await updateDisplayState(db, path, (st) => {
      const p = st.player || null;
      const d = decideClaim(p, { id, tokenHash }, now, st.released);
      if (d.action === 'standby') {
        return { result: { role: 'standby', retryAfterMs: d.retryAfterMs, holder: p ? { since: p.since, expiresAt: p.expiresAt } : null } };
      }
      const player = {
        id,
        tokenHash: newHash,
        gen: (Number(p && p.gen) || 0) + 1,
        since: d.action === 'resume' ? p.since : now,
        expiresAt: now + PLAYER_TTL_MS,
      };
      return {
        write: { ...st, player, released: null },
        result: {
          role: 'player', resumed: d.action === 'resume', token, gen: player.gen,
          cursor: st.lastPlayedKey || null, ttlMs: PLAYER_TTL_MS, heartbeatMs: HEARTBEAT_MS,
        },
      };
    });
    return reply(cors, 200, result);
  }

  if (url.pathname === '/display/heartbeat') {
    const result = await updateDisplayState(db, path, (st) => {
      if (!isHolder(st.player, id, tokenHash)) return { result: null };
      const player = { ...st.player, expiresAt: now + PLAYER_TTL_MS };
      return { write: { ...st, player }, result: { ok: true, expiresAt: player.expiresAt } };
    });
    return result ? reply(cors, 200, result) : notHolder(cors);
  }

  if (url.pathname === '/display/cursor') {
    const key = String(body.key || '');
    if (!QUEUE_KEY_RE.test(key)) return reply(cors, 400, { error: '再生位置の形式が不正です' });
    // 実在するキュー項目の位置だけを受け付ける
    const exists = await db.get(`envs/${envName}/queue/${key}`, { shallow: 'true' });
    if (exists === null || exists === undefined) return reply(cors, 400, { error: 'キューに無い再生位置です' });
    const result = await updateDisplayState(db, path, (st) => {
      if (!isHolder(st.player, id, tokenHash)) return { result: null };
      // 再生位置は戻さない(再送や順番の入れ替わりで古い位置が届いても無視する)
      if (st.lastPlayedKey && key <= st.lastPlayedKey) return { result: { ok: true, ignored: key < st.lastPlayedKey ? 'older' : 'same' } };
      const player = { ...st.player, expiresAt: now + PLAYER_TTL_MS };
      return { write: { ...st, lastPlayedKey: key, updatedAt: now, player }, result: { ok: true, saved: key } };
    });
    return result ? reply(cors, 200, result) : notHolder(cors);
  }

  if (url.pathname === '/display/release') {
    const result = await updateDisplayState(db, path, (st) => {
      if (!isHolder(st.player, id, tokenHash)) return { result: null };
      return { write: { ...st, player: null }, result: { ok: true } };
    });
    return result ? reply(cors, 200, result) : notHolder(cors);
  }

  return reply(cors, 404, { error: 'not found' });
}

/** 管理画面から担当を外す(再生位置はそのまま)。待機中の画面が次の確認で担当になる */
function releaseByAdmin(db, envName) {
  const now = Date.now();
  return updateDisplayState(db, `envs/${envName}/state/display`, (st) => (st.player
    ? {
      write: { ...st, player: null, released: { id: st.player.id, until: now + PLAYER_TTL_MS } },
      result: { ok: true, released: true, previous: { since: st.player.since, expiresAt: st.player.expiresAt } },
    }
    : { result: { ok: true, released: false } }));
}

// ---- worker/src/activity.js ----
// Private viewer activity. This subtree is never publicly readable through Firebase.
const field=(f,keys,max=80)=>{for(const key of keys){const value=f[key];if(value!==undefined&&value!==null&&String(value).trim())return String(value).replace(/[\x00-\x1f\x7f]/g,'').slice(0,max)}return ''};
const countOf=(raw)=>{const n=Number(raw);return Number.isFinite(n)&&n>0?Math.min(9999,Math.floor(n)):1};
const dateJst=(ms)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
async function viewerKey(value){const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(buf),x=>x.toString(16).padStart(2,'0')).join('')}
async function saveActivity(db,envName,fields,forcedType='',now=Date.now()){
 const type=forcedType||field(fields,['type'],24).toLowerCase();
 if(!['attendance','like','comment','gift','follow'].includes(type))return {status:'skipped'};
 const rawId=field(fields,['userId','userID','user_id','uniqueId','username'],128);
 const name=field(fields,['nickname','displayName','username','userName'],40)||'視聴者';
 const amount=countOf(field(fields,type==='gift'?['repeatCount','count']:['likeCount','count','likes'],20));
 const rawMessage=field(fields,['comment','commentText','message','text'],250);
 const rawGift=field(fields,['giftName','gift_name'],70);
 const msgId=field(fields,['msgId','eventId','messageId'],128);
 const base='envs/'+envName+'/overlay/private';
 if(msgId && /^[\w-]{1,128}$/.test(msgId)){
  const path=base+'/dedupe/'+type+'_'+msgId;
  const {value,etag}=await db.getWithEtag(path);
  if(value && now-Number(value)<86400000)return {status:'duplicate'};
  if(!await db.putIfMatch(path,now,etag))return {status:'duplicate'};
 }
 const uid=rawId?await viewerKey(rawId):'';
 const event={type,name,amount,at:now};
 if(type==='comment')event.message=rawMessage;
 if(type==='gift')event.gift=rawGift||'ギフト';
 await db.post(base+'/recent',event);
 // Keep a bounded activity feed; avoid storing comments indefinitely.
 const recentKeys=Object.keys(await db.get(base+'/recent',{shallow:'true'})||{}).sort();
 if(recentKeys.length>150)await db.patch(base+'/recent',Object.fromEntries(recentKeys.slice(0,recentKeys.length-150).map(key=>[key,null])));
 if(uid && (type==='attendance'||type==='like')){
  const path=base+'/users/'+uid;
  for(let attempt=0;attempt<6;attempt++){
   const {value,etag}=await db.getWithEtag(path);
   const prev=value&&typeof value==='object'?value:{};
   const days={...(prev.days||{})};
   if(type==='attendance')days[dateJst(now)]=true;
   const recentDays=Object.fromEntries(Object.entries(days).filter(([day])=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&day>=dateJst(now-366*86400000)).slice(-366));
   const updated={name:name==='視聴者'?(prev.name||name):name,likes:(Number(prev.likes)||0)+(type==='like'?amount:0),days:recentDays,updatedAt:now};
   if(await db.putIfMatch(path,updated,etag))break;
   if(attempt===5)throw new Error('Activity concurrent update failed');
  }
 }
 return {status:'saved',identified:Boolean(uid)};
}
async function getActivity(db,envName){
 const base='envs/'+envName+'/overlay/private';
 const [people,events]=await Promise.all([db.get(base+'/users'),db.get(base+'/recent',{orderBy:'"$key"',limitToLast:'70'})]);
 const users=Object.entries(people||{}).map(([id,x])=>({id,name:String(x.name||'視聴者').slice(0,40),likes:Number(x.likes)||0,days:Object.keys(x.days||{}).sort()})).sort((a,b)=>b.likes-a.likes).slice(0,100);
 const recent=Object.entries(events||{}).map(([id,x])=>({id,type:x.type,name:String(x.name||'視聴者').slice(0,40),amount:Number(x.amount)||1,at:Number(x.at)||0,message:String(x.message||'').slice(0,250),gift:String(x.gift||'').slice(0,70)})).sort((a,b)=>b.at-a.at);
 return {users,recent};
}

// ---- worker/src/restraint.js ----
// Worker側の縛りタイマー永続化。ETag CASで同時更新を直列化する。

const TRIES = 8;
const MAX_HISTORY = 120;
const pathFor = (envName) => `envs/${envName}/state/restraints`;

/** 重複イベントを複数回加算しない。eventIdは再生キューのFirebaseキーを使用。 */
async function updateRestraints(db, envName, action, now = Date.now()) {
  const path = pathFor(envName);
  for (let i = 0; i < TRIES; i++) {
    const { value, etag } = await db.getWithEtag(path);
    const old = value && typeof value === 'object' ? value : { paused: false, updatedAt: now, entries: [], applied: {} };
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
async function readRestraints(db, envName, now = Date.now()) {
  const value = await db.get(pathFor(envName));
  return advanceTimers(value || { paused: false, updatedAt: now, entries: [] }, now);
}

// ---- worker/src/index.js ----
// ============================================================
// worker/src/index.js  (Cloudflare Worker)
// ------------------------------------------------------------
// TikFinity → (Webhook) → この Worker → Firebase → 表示画面
//
// 【エンドポイント】
//   GET  /                         動作確認用
//   POST /webhook?env=prod&k=鍵     TikFinity からのギフト受信(env=prod / env=test の指定は必須)
//   POST /admin/config?env=        設定(ギフト・抽選テーブル・全体設定)を保存
//   POST /admin/test-gift?env=     テスト用の疑似ギフト(Webhookと同じ処理を通す)
//   POST /admin/clear?env=         キュー・重複記録・受信ログ・再生位置を消去
//   POST /admin/copy-config?from=test&to=prod   設定のコピー
//   POST /admin/display/release?env=   表示画面の再生担当を外す(別の画面に切り替える)
//   (/admin/* は X-Admin-Key ヘッダーが必要)
//   POST /display/claim|heartbeat|cursor|release?env=   表示画面の再生担当・再生位置(worker/src/display.js)
//   (/display/* は表示用の合言葉 DISPLAY_KEY_PROD / DISPLAY_KEY_TEST が必要)
//
// 【Worker の環境変数(シークレット)】
//   FIREBASE_DB_URL   例: https://xxxx-default-rtdb.firebaseio.com
//   SA_CLIENT_EMAIL   サービスアカウントの client_email
//   SA_PRIVATE_KEY    サービスアカウントの private_key (PEM)
//   WEBHOOK_KEY       TikFinity の Webhook URL に付ける合言葉
//   ADMIN_KEY         管理画面・テスト画面で使う合言葉
//   DISPLAY_KEY_PROD  本番の表示画面(PRISM に設定する URL)に付ける合言葉
//   DISPLAY_KEY_TEST  テストの表示画面に付ける合言葉(本番と別の値にする)
//   ALLOWED_ORIGIN    (任意) 管理画面の公開元。例: https://ram1x7.github.io
//   ALLOWED_ENVS      (任意) この Worker で使える環境。テスト専用の Worker では "test" にする。
//                     一覧に無い環境(env=prod など)への要求は、Webhook・管理・表示のすべてで 403 にする
// ============================================================








const QUEUE_KEEP = 300;   // キューに残す件数
const LOG_KEEP = 100;     // 受信ログに残す件数
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

const WORKER_VERSION = '1.4.0';

const SECRET_NAMES = ['FIREBASE_DB_URL', 'SA_CLIENT_EMAIL', 'SA_PRIVATE_KEY', 'WEBHOOK_KEY', 'ADMIN_KEY', 'DISPLAY_KEY_PROD', 'DISPLAY_KEY_TEST'];

/**
 * ALLOWED_ORIGIN をオリジン(https://ホスト名)の一覧に直す。
 * 「https://xxx.github.io/tikfinity-minigame/」のようにパスや末尾の / が付いていても受け付ける。
 * カンマ区切りで複数指定できる。
 */
function allowedOrigins(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => { try { return new URL(s).origin; } catch { return null; } })
    .filter(Boolean);
}

function corsHeaders(env, request) {
  const allowed = allowedOrigins(env.ALLOWED_ORIGIN);
  const origin = request.headers.get('Origin') || '';
  let allow = '*';
  if (allowed.length > 0) allow = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** どのシークレットが設定されているか(値そのものは返さない) */
function secretStatus(env) {
  return Object.fromEntries(SECRET_NAMES.map((n) => [n, Boolean(env[n] && String(env[n]).trim())]));
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
        // 同じ抽選結果が何度出ても、抽選1回につき別のIDを持つ。
        // キューのpush key + 抽選順indexなので時系列も維持できる。
        const todos = todoEntries(name, built.item);
        if (Object.keys(todos).length) {
          try {
            await db.patch(`envs/${envName}/state/gachaTodo/pending`, todos);
          } catch (error) {
            // タスクの記録失敗時に抽選だけ成功扱いにしない。
            // キューを取り消して、Webhookの再送時にやり直せるようにする。
            await db.remove(`envs/${envName}/queue/${name}`).catch(() => {});
            throw error;
          }
        }
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

async function handleAdmin(request, env, db, url, ctx, cors) {
  if (!safeEqual(request.headers.get('X-Admin-Key'), env.ADMIN_KEY)) {
    return reply(cors, 401, { error: '管理用の合言葉が違います' });
  }
  const path = url.pathname;

  if (path === '/admin/ping') {
    // 接続テスト用: サービスアカウントで Firebase を読めるかまで確認する
    try {
      // 使える環境のうち1つを読む(テスト専用の Worker なら test)
      const pingEnv = (allowedEnvs(env) || ['test'])[0] || 'test';
      await db.get(`envs/${pingEnv}/config`, { shallow: 'true' });
      return reply(cors, 200, { ok: true, version: WORKER_VERSION, firebase: 'ok' });
    } catch (err) {
      return reply(cors, 200, { ok: false, version: WORKER_VERSION, firebase: String(err.message || err) });
    }
  }

  if (path === '/admin/copy-config') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!isEnv(from) || !isEnv(to) || from === to) return reply(cors, 400, { error: 'from/to が不正です' });
    if (!envAllowed(env, from) || !envAllowed(env, to)) return reply(cors, 403, { error: ENV_DENIED });
    const config = await db.get(`envs/${from}/config`);
    await db.put(`envs/${to}/config`, config || {});
    return reply(cors, 200, { ok: true });
  }

  const envName = url.searchParams.get('env');
  if (!isEnv(envName)) return reply(cors, 400, { error: 'env は prod か test を指定してください' });
  if (!envAllowed(env, envName)) return reply(cors, 403, { error: ENV_DENIED });

  if (path === '/admin/gacha-todo') {
    const body = await request.json().catch(() => ({}));
    const pendingPath = `envs/${envName}/state/gachaTodo/pending`;
    if (body.type === 'read') return reply(cors, 200, { ok: true, pending: (await db.get(pendingPath)) || {} });
    if (body.type === 'finish') {
      const id = String(body.id || '');
      if (!/^-[A-Za-z0-9_-]{8,40}_[0-9]{3}$/.test(id)) return reply(cors, 400, { error: 'タスクIDが不正です' });
      await db.remove(`${pendingPath}/${id}`);
      return reply(cors, 200, { ok: true });
    }
    if (body.type === 'reset-all') {
      await db.remove(pendingPath);
      return reply(cors, 200, { ok: true });
    }
    return reply(cors, 400, { error: 'タスク操作が不正です' });
  }

  if (path === '/admin/restraints') {
    const body = await request.json().catch(() => ({}));
    if (body.type === 'read') return reply(cors, 200, { ok: true, state: await readRestraints(db, envName) });
    if (!['pause-all', 'resume-all', 'reset-all', 'finish', 'adjust'].includes(body.type)) {
      return reply(cors, 400, { error: 'タイマー操作が不正です' });
    }
    const result = await updateRestraints(db, envName, body);
    return reply(cors, 200, { ok: true, ...result });
  }

  if (path === '/admin/config') {
    const body = await request.json().catch(() => null);
    const { config, errors } = sanitizeConfig(body);
    await db.put(`envs/${envName}/config`, config);
    return reply(cors, 200, { ok: true, warnings: errors });
  }

  if (path === '/admin/test-gift') {
    const body = await request.json().catch(() => ({}));
    const result = await processGift(db, envName, body || {}, 'test');
    ctx.waitUntil(cleanup(db, envName, Date.now()).catch(() => {}));
    return reply(cors, 200, result);
  }

  if (path === '/admin/display/release') {
    return reply(cors, 200, await releaseByAdmin(db, envName));
  }

  if (path === '/admin/clear') {
    await db.patch(`envs/${envName}`, { queue: null, dedupe: null, log: null, state: null });
    return reply(cors, 200, { ok: true });
  }

  return reply(cors, 404, { error: 'not found' });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return reply(cors, 200, {
        ok: true,
        service: 'tikfinity-minigame',
        version: WORKER_VERSION,
        secrets: secretStatus(env),
        allowedOrigins: allowedOrigins(env.ALLOWED_ORIGIN),
        // この Worker で使える環境(null なら制限なし)
        allowedEnvs: allowedEnvs(env),
      });
    }
    if (request.method !== 'POST') return reply(cors, 405, { error: 'POST のみ受け付けます' });

    try {
      const db = createDb(env);

      if (url.pathname === '/overlay/activity') {
        const envName=url.searchParams.get('env');
        if(!isEnv(envName))return reply(cors,400,{error:'env required'});
        if(!envAllowed(env,envName))return reply(cors,403,{error:ENV_DENIED});
        const body=await request.json().catch(()=>({}));
        const displayKey=envName==='prod'?env.DISPLAY_KEY_PROD:env.DISPLAY_KEY_TEST;
        if(!displayKey||!safeEqual(String(body.dk||''),String(displayKey)))return reply(cors,401,{error:'display key invalid'});
        return reply(cors,200,await getActivity(db,envName));
      }
      if (url.pathname === '/overlay/webhook') {
        if(!safeEqual(url.searchParams.get('k'),env.WEBHOOK_KEY))return reply(cors,401,{error:'webhook key invalid'});
        const envName=url.searchParams.get('env');
        if(!isEnv(envName))return reply(cors,400,{error:'env required'});
        if(!envAllowed(env,envName))return reply(cors,403,{error:ENV_DENIED});
        const fields=await readFields(request,url);
        // URL-defined event category takes precedence over untrusted payload category.
        const type=String(url.searchParams.get('type')||'').toLowerCase();
        const result=await saveActivity(db,envName,fields,type);
        return reply(cors,200,result);
      }
      if (url.pathname === '/webhook') {
        if (!safeEqual(url.searchParams.get('k'), env.WEBHOOK_KEY)) {
          return reply(cors, 401, { error: 'Webhook の合言葉が違います' });
        }
        // env を省略したときに本番へ書き込まないよう、prod / test の明示を必須にする
        const envName = url.searchParams.get('env');
        if (!isEnv(envName)) {
          return reply(cors, 400, { error: 'Webhook の URL に env=prod か env=test を付けてください(省略はできません)' });
        }
        if (!envAllowed(env, envName)) return reply(cors, 403, { error: ENV_DENIED });
        const fields = await readFields(request, url);
        const result = await processGift(db, envName, fields, 'webhook');
        if(result.status!=='duplicate') ctx.waitUntil(saveActivity(db,envName,fields,'gift').catch(()=>{}));
        ctx.waitUntil(cleanup(db, envName, Date.now()).catch(() => {}));
        // TikFinity に再送させないよう、処理しなかった場合も 200 を返す
        return reply(cors, 200, result);
      }

      if (url.pathname === '/display/restraints') {
        const envName = url.searchParams.get('env');
        if (!isEnv(envName)) return reply(cors, 400, { error: 'env が不正です' });
        if (!envAllowed(env, envName)) return reply(cors, 403, { error: ENV_DENIED });
        const body = await request.json().catch(() => ({}));
        const keyName = envName === 'prod' ? 'DISPLAY_KEY_PROD' : 'DISPLAY_KEY_TEST';
        if (!env[keyName] || !safeEqual(body.dk, env[keyName])) return reply(cors, 401, { error: '表示用の合言葉が違います' });
        if (body.type === 'read') return reply(cors, 200, { ok: true, state: await readRestraints(db, envName) });
        if (body.type !== 'award') return reply(cors, 400, { error: '操作が不正です' });
        // 結果の偽装を防ぐため、必ず保存済みキューから照合する。
        const key = String(body.key || '');
        const index = Number(body.index);
        if (!/^-[A-Za-z0-9_-]{8,40}$/.test(key) || !Number.isInteger(index) || index < 0 || index > 99) {
          return reply(cors, 400, { error: '抽選結果の指定が不正です' });
        }
        const queued = await db.get(`envs/${envName}/queue/${key}`);
        const rolls = queued && (Array.isArray(queued.rolls) ? queued.rolls : Object.values(queued.rolls || {}));
        const roll = rolls && rolls[index];
        if (!roll?.timer || queued.mode !== 'roulette') return reply(cors, 400, { error: 'タイマー対象の抽選結果ではありません' });
        const result = await updateRestraints(db, envName, { type: 'award', eventId: `${key}:${index}`, rule: roll.timer });
        return reply(cors, 200, { ok: true, ...result });
      }
      if (url.pathname.startsWith('/display/')) {
        return await handleDisplay(request, env, db, url, cors);
      }

      if (url.pathname.startsWith('/admin/')) {
        return await handleAdmin(request, env, db, url, ctx, cors);
      }

      return reply(cors, 404, { error: 'not found' });
    } catch (err) {
      return reply(cors, 500, { error: String(err && err.message ? err.message : err) });
    }
  },
};
