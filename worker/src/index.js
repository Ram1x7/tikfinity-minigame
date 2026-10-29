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
//   POST /admin/bgm/upload?env=   BGM音声ファイルをR2にアップロード
//   GET  /bgm/{id}.mp3|m4a|ogg|wav   公開音声ファイルを配信
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
//   BGM_BUCKET        R2バケットのバインディング（BGM音声保存用）
//   ALLOWED_ORIGIN    (任意) 管理画面の公開元。例: https://ram1x7.github.io
//   ALLOWED_ENVS      (任意) この Worker で使える環境。テスト専用の Worker では "test" にする。
//                     一覧に無い環境(env=prod など)への要求は、Webhook・管理・表示のすべてで 403 にする
// ============================================================

import {
  isEnv,
  normalizeGift,
  buildQueueItem,
  sanitizeConfig,
  dedupeRule,
  isDuplicate,
  DEFAULT_SETTINGS,
} from '../../shared/core.js';
import { createDb } from './firebase.js';
import { reply, safeEqual, allowedEnvs, envAllowed, ENV_DENIED } from './http.js';
import { handleDisplay, releaseByAdmin } from './display.js';
import { saveActivity, getActivity } from './activity.js';
import { updateRestraints, readRestraints } from './restraint.js';
import { todoEntries } from '../../shared/gacha-todo.js';

const QUEUE_KEEP = 300;   // キューに残す件数
const LOG_KEEP = 100;     // 受信ログに残す件数
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

export const WORKER_VERSION = '1.4.0';

const SECRET_NAMES = ['FIREBASE_DB_URL', 'SA_CLIENT_EMAIL', 'SA_PRIVATE_KEY', 'WEBHOOK_KEY', 'ADMIN_KEY', 'DISPLAY_KEY_PROD', 'DISPLAY_KEY_TEST'];

/**
 * ALLOWED_ORIGIN をオリジン(https://ホスト名)の一覧に直す。
 * 「https://xxx.github.io/tikfinity-minigame/」のようにパスや末尾の / が付いていても受け付ける。
 * カンマ区切りで複数指定できる。
 */
export function allowedOrigins(value) {
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
export async function processGift(db, envName, fields, source, nowMs = Date.now()) {
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

  if (path === '/admin/bgm/upload') {
    if (!env.BGM_BUCKET) return reply(cors, 503, { error: 'R2バケット BGM_BUCKET が未設定です。Cloudflareでバケットを作成しWorkerにバインドしてください' });
    const maxBytes = 10 * 1024 * 1024;
    const length = Number(request.headers.get('Content-Length') || 0);
    if (length > maxBytes) return reply(cors, 413, { error: 'BGMは10MB以下にしてください' });
    const ext = String(url.searchParams.get('ext') || '').toLowerCase();
    const types = { mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav' };
    if (!types[ext]) return reply(cors, 400, { error: 'MP3/M4A/OGG/WAVのみ対応しています' });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > maxBytes) return reply(cors, 413, { error: '音声ファイルは1バイト以上10MB以下にしてください' });
    // 拡張子だけを偽装したファイルを拒否。
    const ascii = (a, b) => String.fromCharCode(...bytes.slice(a, b));
    const valid = ext === 'mp3'
      ? (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
      : ext === 'm4a' ? ascii(4, 8) === 'ftyp'
      : ext === 'ogg' ? ascii(0, 4) === 'OggS'
      : ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
    if (!valid) return reply(cors, 400, { error: '音声ファイルの形式を確認してください（拡張子と内容が一致しません）' });
    const id = crypto.randomUUID().replace(/-/g, '');
    const key = `${envName}/${id}.${ext}`;
    await env.BGM_BUCKET.put(key, bytes, { httpMetadata: { contentType: types[ext], cacheControl: 'public, max-age=86400' } });
    return reply(cors, 200, { ok: true, url: `${url.origin}/bgm/${key}`, bytes: bytes.length });
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
    if (request.method === 'GET' && url.pathname.startsWith('/bgm/')) {
      if (!env.BGM_BUCKET) return reply(cors, 503, { error: 'BGM_BUCKET が未設定です' });
      const key = url.pathname.slice('/bgm/'.length);
      if (!/^(prod|test)\/[a-f0-9]{32}\.(mp3|m4a|ogg|wav)$/.test(key)) return reply(cors, 404, { error: 'not found' });
      const envName = key.split('/')[0];
      if (!envAllowed(env, envName)) return reply(cors, 403, { error: ENV_DENIED });
      const rangeHeader = request.headers.get('Range');
      const metadata = await env.BGM_BUCKET.head(key);
      if (!metadata) return reply(cors, 404, { error: 'not found' });
      let range;
      if (rangeHeader) {
        const match = /^bytes=(\\d*)-(\\d*)$/.exec(rangeHeader);
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { ...cors, 'Content-Range': `bytes */${metadata.size}` } });
        let start = match[1] ? Number(match[1]) : Math.max(0, metadata.size - Number(match[2]));
        let end = match[2] && match[1] ? Number(match[2]) : metadata.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= metadata.size || end < start) return new Response(null, { status: 416, headers: { ...cors, 'Content-Range': `bytes */${metadata.size}` } });
        end = Math.min(end, metadata.size - 1);
        range = { offset: start, length: end - start + 1 };
      }
      const object = await env.BGM_BUCKET.get(key, range ? { range } : {});
      if (!object) return reply(cors, 404, { error: 'not found' });
      const headers = new Headers(cors);
      object.writeHttpMetadata(headers);
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Content-Length', String(range ? range.length : metadata.size));
      if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
      headers.set('Cache-Control', 'public, max-age=86400');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(object.body, { status: range ? 206 : 200, headers });
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
