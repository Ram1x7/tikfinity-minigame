// ブラウザ確認用: Firebase Realtime Database の SDK を真似するメモリ上のスタブ。
// tests/browser/smoke.mjs が gstatic の SDK の代わりにこれを読み込ませる。
// window.__fakeDb からテスト側がデータを書き込める。
// 再読み込みしてもデータが残るよう sessionStorage に保存する(本物のDBと同じ振る舞いにするため)
const STORE = '__fakeDbRoot';
const root = JSON.parse(sessionStorage.getItem(STORE) || '{}');
const listeners = new Set();
let seq = Number(sessionStorage.getItem(STORE + 'Seq') || 0);

const segs = (p) => String(p).split('/').filter(Boolean);

function getAt(path) {
  if (path === '.info/connected') return true;
  let cur = root;
  for (const s of segs(path)) {
    if (cur === null || typeof cur !== 'object' || !(s in cur)) return null;
    cur = cur[s];
  }
  return cur === undefined ? null : structuredClone(cur);
}

function resolve(v) {
  if (v && typeof v === 'object') {
    if (v['.sv'] === 'timestamp') return Date.now();
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = resolve(x);
    return out;
  }
  return v;
}

function writeAt(path, value) {
  const s = segs(path);
  let cur = root;
  for (const k of s.slice(0, -1)) {
    if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  const last = s[s.length - 1];
  if (value === null || value === undefined) delete cur[last];
  else cur[last] = resolve(structuredClone(value));
  sessionStorage.setItem(STORE, JSON.stringify(root));
  for (const l of [...listeners]) l.fire();
}

function evaluate(q) {
  let v = getAt(q.path);
  if (!q.constraints.length || v === null || typeof v !== 'object') return v;
  let entries = Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const c of q.constraints) {
    if (c.t === 'startAfter') entries = entries.filter(([k]) => k > c.k);
    if (c.t === 'limitToLast') entries = entries.slice(-c.n);
  }
  return Object.fromEntries(entries);
}

function snapshot(key, value) {
  return {
    key,
    val: () => (value === undefined ? null : structuredClone(value)),
    forEach(cb) {
      if (value && typeof value === 'object') {
        for (const k of Object.keys(value).sort()) cb(snapshot(k, value[k]));
      }
    },
  };
}

const toQuery = (r) => (r.constraints ? r : { path: r.path, constraints: [] });
const lastSeg = (p) => segs(p).pop() || null;

export const getDatabase = () => ({});
export const ref = (_db, path) => ({ path, constraints: [] });
export const query = (r, ...constraints) => ({ path: r.path, constraints });
export const orderByKey = () => ({ t: 'orderByKey' });
export const startAfter = (k) => ({ t: 'startAfter', k });
export const limitToLast = (n) => ({ t: 'limitToLast', n });
export const serverTimestamp = () => ({ '.sv': 'timestamp' });

export async function get(r) {
  const q = toQuery(r);
  return snapshot(lastSeg(q.path), evaluate(q));
}

export async function set(r, value) {
  writeAt(r.path, value);
}

export function onValue(r, cb) {
  const q = toQuery(r);
  let last;
  const l = {
    fire() {
      const v = evaluate(q);
      const s = JSON.stringify(v);
      if (s === last) return;
      last = s;
      cb(snapshot(lastSeg(q.path), v));
    },
  };
  listeners.add(l);
  setTimeout(() => l.fire(), 0);
  return () => listeners.delete(l);
}

export function onChildAdded(r, cb) {
  const q = toQuery(r);
  const seen = new Set();
  const l = {
    fire() {
      const v = evaluate(q) || {};
      for (const k of Object.keys(v).sort()) {
        if (seen.has(k)) continue;
        seen.add(k);
        cb(snapshot(k, v[k]));
      }
    },
  };
  listeners.add(l);
  setTimeout(() => l.fire(), 0);
  return () => listeners.delete(l);
}

window.__fakeDb = {
  root,
  get: getAt,
  set: writeAt,
  push(path, value) {
    const key = `-T${String(++seq).padStart(6, '0')}`;
    sessionStorage.setItem(STORE + 'Seq', String(seq));
    writeAt(`${path}/${key}`, value);
    return key;
  },
};
