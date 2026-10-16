// テスト用: Firebase Realtime Database REST API と Google のトークン発行を
// メモリ上で真似する fetch。Worker を実際の通信なしで最後まで動かすために使う。

const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

export function createFakeFirebase({ dbUrl = 'https://fake-db.firebaseio.com' } = {}) {
  const root = {};
  const calls = [];
  const failures = []; // { method, pathIncludes } 1回だけ 500 を返す
  let pushSeq = 0;
  let now = 1_700_000_000_000;

  function pushId() {
    // 時系列順に並ぶキー(本物と同じく文字列比較で古い順)
    let n = now * 1000 + pushSeq++;
    let id = '';
    for (let i = 0; i < 12; i++) { id = PUSH_CHARS[n % 64] + id; n = Math.floor(n / 64); }
    return '-' + id;
  }

  const segs = (path) => path.split('/').filter(Boolean);

  function getAt(path) {
    let cur = root;
    for (const s of segs(path)) {
      if (cur === null || typeof cur !== 'object' || !(s in cur)) return null;
      cur = cur[s];
    }
    return cur === undefined ? null : structuredClone(cur);
  }

  function resolveSv(v) {
    if (v && typeof v === 'object') {
      if (v['.sv'] === 'timestamp') return now;
      const out = Array.isArray(v) ? [] : {};
      for (const [k, x] of Object.entries(v)) out[k] = resolveSv(x);
      return out;
    }
    return v;
  }

  function prune(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    for (const k of Object.keys(obj)) {
      obj[k] = prune(obj[k]);
      if (obj[k] === null || (typeof obj[k] === 'object' && Object.keys(obj[k]).length === 0)) delete obj[k];
    }
    return obj;
  }

  function setAt(path, value) {
    const s = segs(path);
    if (s.length === 0) { for (const k of Object.keys(root)) delete root[k]; Object.assign(root, value || {}); return; }
    let cur = root;
    for (const k of s.slice(0, -1)) {
      if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    const last = s[s.length - 1];
    if (value === null || value === undefined) delete cur[last];
    else cur[last] = structuredClone(value);
    prune(root);
  }

  const etagOf = (v) => (v === null ? 'null_etag' : 'e' + Buffer.from(JSON.stringify(v)).toString('base64').slice(0, 24) + JSON.stringify(v).length);

  async function fakeFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    calls.push({ method, url: url.toString() });

    if (url.href.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'fake-token', expires_in: 3600 });
    }
    if (!url.href.startsWith(dbUrl)) return new Response('unknown host', { status: 404 });
    if (url.searchParams.get('access_token') !== 'fake-token') return new Response('unauthorized', { status: 401 });

    const path = url.pathname.replace(/\.json$/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;

    const fail = failures.findIndex((f) => f.method === method && path.includes(f.pathIncludes));
    if (fail >= 0) {
      failures.splice(fail, 1);
      return new Response('{"error":"boom"}', { status: 500 });
    }

    if (method === 'GET') {
      let v = getAt(path);
      if (url.searchParams.get('shallow') === 'true' && v && typeof v === 'object') {
        v = Object.fromEntries(Object.keys(v).map((k) => [k, true]));
      }
      if (url.searchParams.get('orderBy') === '"$value"' && v && typeof v === 'object') {
        const endAt = Number(url.searchParams.get('endAt'));
        const limit = Number(url.searchParams.get('limitToFirst') || Infinity);
        const entries = Object.entries(v).filter(([, x]) => x <= endAt).sort((a, b) => a[1] - b[1]).slice(0, limit);
        v = Object.fromEntries(entries);
      }
      const h = { 'Content-Type': 'application/json' };
      if (headers.get('X-Firebase-ETag') === 'true') h.ETag = etagOf(getAt(path));
      return new Response(JSON.stringify(v), { status: 200, headers: h });
    }
    if (method === 'PUT') {
      const ifMatch = headers.get('if-match');
      if (ifMatch && ifMatch !== etagOf(getAt(path))) return new Response('{"error":"precondition"}', { status: 412 });
      setAt(path, resolveSv(body));
      return Response.json(body ?? null);
    }
    if (method === 'PATCH') {
      for (const [k, v] of Object.entries(body)) setAt(`${path}/${k}`, resolveSv(v));
      return Response.json(body);
    }
    if (method === 'POST') {
      const name = pushId();
      setAt(`${path}/${name}`, resolveSv(body));
      return Response.json({ name });
    }
    if (method === 'DELETE') {
      setAt(path, null);
      return Response.json(null);
    }
    return new Response('bad method', { status: 405 });
  }

  return {
    fetch: fakeFetch,
    dbUrl,
    get: getAt,
    set: setAt,
    calls,
    advance(ms) { now += ms; },
    failOnce(method, pathIncludes) { failures.push({ method, pathIncludes }); },
    get now() { return now; },
  };
}
