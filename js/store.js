// ============================================================
// js/store.js
// ------------------------------------------------------------
// ブラウザ側で Firebase を直接扱うのはこのファイルだけ。
// ブラウザは「読む」だけ(Firebase のルールでブラウザからの書き込みは禁止)。
// 設定の保存・テスト送信は Worker 経由(js/api.js)、表示画面の再生位置の保存も Worker 経由(js/player.js)。
// ============================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, get, onValue, onChildAdded, query,
  orderByKey, startAfter, limitToLast,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from './config.js';

let db = null;

export function isConfigured() {
  return Boolean(firebaseConfig.databaseURL && firebaseConfig.apiKey);
}

function database() {
  if (!isConfigured()) {
    throw new Error('js/config.js に Firebase の接続情報が入っていません');
  }
  if (!db) db = getDatabase(initializeApp(firebaseConfig));
  return db;
}

const envRef = (env, path) => ref(database(), `envs/${env}/${path}`);

/** Firebase は配列を {0:..} で返すことがあるので、テーブルの候補を配列に揃える */
export function normalizeConfig(raw) {
  const config = raw || {};
  const tables = {};
  for (const [id, t] of Object.entries(config.tables || {})) {
    const items = Array.isArray(t.items) ? t.items : Object.values(t.items || {});
    tables[id] = { ...t, items: items.filter(Boolean) };
  }
  return { gifts: config.gifts || {}, tables, settings: config.settings || {} };
}

export async function loadConfig(env) {
  const snap = await get(envRef(env, 'config'));
  return normalizeConfig(snap.val());
}

export function watchConfig(env, onChange) {
  return onValue(envRef(env, 'config'), (snap) => onChange(normalizeConfig(snap.val())));
}

/** Firebase との接続状態 */
export function watchConnection(onChange) {
  return onValue(ref(database(), '.info/connected'), (snap) => onChange(snap.val() === true));
}

// ---------------- 表示画面 ----------------
// 再生位置は Worker が担当の確認つきで保存する(js/player.js)。ここでは読むだけ

export async function latestQueueKey(env) {
  const snap = await get(query(envRef(env, 'queue'), limitToLast(1)));
  let key = null;
  snap.forEach((child) => { key = child.key; });
  return key;
}

/** cursor より新しいキュー項目を、古い順に1件ずつ通知する */
export function watchQueueAfter(env, cursor, onItem) {
  const q = cursor
    ? query(envRef(env, 'queue'), orderByKey(), startAfter(cursor))
    : query(envRef(env, 'queue'), orderByKey());
  return onChildAdded(q, (snap) => onItem(snap.key, snap.val()));
}

// ---------------- 管理・テスト画面の確認用 ----------------

export function watchRecentQueue(env, count, onChange) {
  return onValue(query(envRef(env, 'queue'), limitToLast(count)), (snap) => {
    const list = [];
    snap.forEach((child) => { list.push({ key: child.key, ...child.val() }); });
    onChange(list.reverse());
  });
}

export function watchRecentLog(env, count, onChange) {
  return onValue(query(envRef(env, 'log'), limitToLast(count)), (snap) => {
    const list = [];
    snap.forEach((child) => { list.push({ key: child.key, ...child.val() }); });
    onChange(list.reverse());
  });
}

export function watchDisplayState(env, onChange) {
  return onValue(envRef(env, 'state/display'), (snap) => onChange(snap.val() || {}));
}

/** Overlay events: read-only subscription, isolated from lottery queue. */
export async function latestOverlayEventKey(env) {
  const snap = await get(query(envRef(env, 'overlay/events'), limitToLast(1)));
  let key = null;
  snap.forEach(child => { key = child.key; });
  return key;
}
export function watchOverlayEventsAfter(env, cursor, onItem) {
  const base = envRef(env, 'overlay/events');
  const q = cursor ? query(base, orderByKey(), startAfter(cursor)) : query(base, orderByKey());
  return onChildAdded(q, snap => onItem(snap.key, snap.val()));
}

/** タイマー状態のリアルタイム購読（読み取りのみ） */
export function watchRestraints(env, onChange) {
  return onValue(envRef(env, 'state/restraints'), (snap) => onChange(snap.val() || null));
}
