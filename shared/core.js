// ============================================================
// shared/core.js
// ------------------------------------------------------------
// Worker と ブラウザ(管理画面・テスト画面) の両方で使う純粋な関数だけを置く。
// DOM・Firebase・fetch には一切依存しないので、node --test で単体テストできる。
// ============================================================

export const ENVS = ['prod', 'test'];
export const MODES = ['gacha', 'roulette'];
export const COMBO_MODES = ['once', 'perCount', 'everyN'];
export const RARITIES = ['N', 'R', 'SR', 'SSR'];

export const LIMITS = {
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

export const DEFAULT_SETTINGS = {
  staleMinutes: 10,      // これより古い未再生イベントは表示側で飛ばす
  dedupeWindowSec: 3,    // msgIdが無い時、同じ内容をこの秒数内は重複とみなす(0で無効)
};

export function isEnv(v) {
  return ENVS.includes(v);
}

/**
 * ギフト名などを Firebase のキーとして使える形にする(可逆)。
 * Firebaseのキーに使えない . # $ [ ] / と制御文字を %XX に置き換える。
 */
export function encodeKey(str) {
  return String(str).replace(/[%.#$[\]/\u0000-\u001f\u007f]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

export function decodeKey(key) {
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
export function normalizeGift(fields) {
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
export function isStreakInProgress(gift) {
  return gift.repeatEnd === false;
}

/** ギフト設定と個数から、抽選する回数を決める */
export function rollCount(giftCfg, repeatCount) {
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
export function secureRandom() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 4294967296;
}

/** 重みが正の候補だけを返す */
export function activeItems(table) {
  const items = Array.isArray(table && table.items) ? table.items : [];
  return items.filter((it) => it && it.label && Number(it.weight) > 0);
}

/** 重み付き抽選。rand は 0以上1未満を返す関数(テストで差し替え可能) */
export function weightedPick(items, rand = secureRandom) {
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
export function probabilities(items) {
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
  const bgmUrl = str(input.bgmUrl, 600);
  return {
    id,
    durationMs: Math.round(minutes * 60000),
    group: input.group === 'parallel' ? 'parallel' : 'exclusive',
    // Direct audio URLs only; YouTube embeds cannot be used as hidden audio players.
    ...(/^https:\/\/[^\s]+\.(?:mp3|m4a|ogg|wav)(?:\?[^\s]*)?$/i.test(bgmUrl) ? { bgmUrl } : {}),
  };
}

/**
 * 管理画面から届いた設定を検証・整形する。
 * 不正な値は捨てるか既定値に直し、{ config, errors } を返す。
 * gifts は { [encodeKey(giftName)]: {...} }、tables は { [tableId]: {...} } の形で保存する。
 */
export function sanitizeConfig(input) {
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
      if (raw?.timer?.enabled === true && raw.timer.bgmUrl && !sanitizeTimer(raw.timer)?.bgmUrl) {
        errors.push(`テーブル「${id}」の候補${index + 1}: BGMにはHTTPSの音声ファイルURL（mp3/m4a/ogg/wav）を指定してください`);
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
export function buildQueueItem(gift, config, rand = secureRandom) {
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
export async function dedupeRule(gift, windowSec) {
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
export function isDuplicate(existingTs, nowMs, windowMs) {
  if (typeof existingTs !== 'number') return false;
  if (windowMs === null) return true;
  return nowMs - existingTs < windowMs;
}
