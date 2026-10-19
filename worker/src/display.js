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
import { isEnv } from '../../shared/core.js';
import { reply, safeEqual, envAllowed, ENV_DENIED } from './http.js';

export const PLAYER_TTL_MS = 30 * 1000;   // 更新が無ければ担当が切れるまでの時間
export const HEARTBEAT_MS = 10 * 1000;    // 担当の更新間隔(表示画面に伝える)
const STANDBY_POLL_MAX_MS = 10 * 1000;    // 待機中の画面が担当を確認し直す間隔の上限
const CAS_TRIES = 5;

const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;
export const QUEUE_KEY_RE = /^-[0-9A-Za-z_-]{8,40}$/;

/** 環境ごとの表示用の合言葉の名前(本番とテストで別々) */
export function displayKeyName(envName) {
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
export function decideClaim(player, { id, tokenHash }, nowMs, released = null) {
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
export function isHolder(player, id, tokenHash) {
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

export async function handleDisplay(request, env, db, url, cors) {
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
export function releaseByAdmin(db, envName) {
  const now = Date.now();
  return updateDisplayState(db, `envs/${envName}/state/display`, (st) => (st.player
    ? {
      write: { ...st, player: null, released: { id: st.player.id, until: now + PLAYER_TTL_MS } },
      result: { ok: true, released: true, previous: { since: st.player.since, expiresAt: st.player.expiresAt } },
    }
    : { result: { ok: true, released: false } }));
}
