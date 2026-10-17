// ============================================================
// js/player.js  表示画面の「再生担当」(Worker の /display/*)
// ------------------------------------------------------------
// 同じ環境で再生できる表示画面は1つだけ。担当になれた画面だけが再生し、
// 再生位置を Worker 経由で保存する(ブラウザから Firebase へは書き込まない)。
//
//   - 担当がいれば待機し、期限切れ・解除されたら引き継ぐ
//   - 担当の更新(heartbeat)を一定間隔で送る。担当でなくなったら onLost を呼ぶ
//   - 再読み込みしたときは、前回の token(このタブの sessionStorage)で待たずに担当へ戻る
//   - Worker に届かないあいだは再生位置の保存をやり直し続ける。担当の期限を過ぎても
//     届かなければ、二重再生を避けるため新しい再生を止めて待つ(canPlay)
//
// 表示画面の URL:  display.html?env=prod&dk=表示用の合言葉[&w=Worker の URL]
//   w を省略したときは js/config.js の DEFAULT_WORKER_URL を使う。
// ============================================================
import { DEFAULT_WORKER_URL } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** URL のパラメーターから Worker の URL と表示用の合言葉を読む */
export function playerParams(params) {
  return {
    workerUrl: String(params.get('w') || DEFAULT_WORKER_URL || '').trim().replace(/\/+$/, ''),
    displayKey: String(params.get('dk') || '').trim(),
  };
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return 'scr-' + [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
}

function store(storage) {
  return {
    get: (k) => { try { return storage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { if (v) storage.setItem(k, v); else storage.removeItem(k); } catch { /* 保存できない環境 */ } },
  };
}

/**
 * onStatus({ kind, message }) で状態を知らせる:
 *   player(担当になった) / standby(待機中) / offline(Worker に届かない) / error(設定の誤り)
 */
export function createPlayer({ env, workerUrl, displayKey, onStatus = () => {}, onLost = () => {}, storage = sessionStorage }) {
  const kv = store(storage);
  const K_ID = `tm.player.${env}.id`;
  const K_TOKEN = `tm.player.${env}.token`;
  // 画面の ID はこのタブの中だけで同じ(再読み込みしても変わらない)
  let id = kv.get(K_ID);
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) { id = randomId(); kv.set(K_ID, id); }

  let token = kv.get(K_TOKEN);
  let active = false;
  let ttlMs = 30000;
  let heartbeatMs = 10000;
  let lastOkAt = 0;
  let timer = null;
  let pendingKey = null;
  let flushing = null;

  async function post(path, body = {}) {
    // text/plain にして、事前確認(プリフライト)の往復を省く
    const res = await fetch(`${workerUrl}/display/${path}?env=${env}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ dk: displayKey, id, ...body }),
      keepalive: path === 'release',
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  function lose() {
    if (!active) return;
    active = false;
    token = '';
    kv.set(K_TOKEN, '');
    clearInterval(timer);
    timer = null;
    pendingKey = null;
    onLost();
  }

  async function heartbeat() {
    if (!active) return;
    try {
      const r = await post('heartbeat', { token });
      if (r.status === 200) { lastOkAt = Date.now(); onStatus({ kind: 'player' }); return; }
      if (r.status === 409) { lose(); return; }
      onStatus({ kind: 'offline', message: r.data.error || `Worker の応答 ${r.status}` });
    } catch {
      onStatus({ kind: 'offline', message: 'Worker に接続できません(再接続を待っています)' });
    }
  }

  /** 担当になるまで待つ。担当になったら { cursor, resumed } を返す */
  async function acquire() {
    if (!workerUrl || !displayKey) {
      const message = !workerUrl
        ? 'Worker の URL がありません。管理画面の「URL の案内」から表示画面の URL をコピーし直してください'
        : '表示用の合言葉(dk)が URL にありません。管理画面の「URL の案内」から表示画面の URL をコピーし直してください';
      onStatus({ kind: 'error', message });
      throw new Error(message);
    }
    let wait = 1000;
    for (;;) {
      let r;
      try {
        r = await post('claim', token ? { token } : {});
      } catch {
        onStatus({ kind: 'offline', message: 'Worker に接続できません(再接続を待っています)' });
        await sleep(wait);
        wait = Math.min(30000, wait * 2);
        continue;
      }
      wait = 1000;
      if (r.status === 200 && r.data.role === 'player') {
        token = r.data.token;
        kv.set(K_TOKEN, token);
        ttlMs = Number(r.data.ttlMs) || ttlMs;
        heartbeatMs = Number(r.data.heartbeatMs) || heartbeatMs;
        active = true;
        lastOkAt = Date.now();
        clearInterval(timer);
        timer = setInterval(heartbeat, heartbeatMs);
        onStatus({ kind: 'player', resumed: Boolean(r.data.resumed) });
        return { cursor: r.data.cursor || null, resumed: Boolean(r.data.resumed) };
      }
      if (r.status === 200 && r.data.role === 'standby') {
        token = '';
        kv.set(K_TOKEN, '');
        onStatus({ kind: 'standby', message: '別の表示画面が再生を担当しています(待機中)' });
        await sleep(Number(r.data.retryAfterMs) || 10000);
        continue;
      }
      // 合言葉の誤り・Worker の設定不足など。直るまでゆっくり確認し直す
      onStatus({ kind: 'error', message: r.data.error || `Worker の応答 ${r.status}` });
      await sleep(30000);
    }
  }

  /** 再生位置を保存する(届かなければやり直す。新しい位置が来たら古い位置は送らない) */
  function saveCursor(key) {
    if (!active || !key) return Promise.resolve();
    if (!pendingKey || key > pendingKey) pendingKey = key;
    if (!flushing) {
      flushing = (async () => {
        let wait = 1000;
        while (active && pendingKey) {
          const key2 = pendingKey;
          try {
            const r = await post('cursor', { token, key: key2 });
            if (r.status === 409) { lose(); break; }
            if (r.status === 200 || r.status === 400) {
              // 400(キューに無い位置など)はやり直しても通らないので捨てる
              if (r.status === 400) console.error('再生位置を保存できません', r.data.error);
              if (pendingKey === key2) pendingKey = null;
              lastOkAt = Date.now();
              onStatus({ kind: 'player' }); // Worker に届いた(障害からの復帰を含む)
              wait = 1000;
              continue;
            }
            onStatus({ kind: 'offline', message: r.data.error || `Worker の応答 ${r.status}` });
          } catch {
            onStatus({ kind: 'offline', message: 'Worker に接続できません(再生位置の保存をやり直します)' });
          }
          await sleep(wait);
          wait = Math.min(30000, wait * 2);
        }
        flushing = null;
      })();
    }
    return flushing;
  }

  /**
   * 担当を降りる(ページを閉じる・再読み込みする時)。
   * token はこのタブに残す: 再読み込み後の要求が先に届いた場合はその token で担当に戻り、
   * 降りる要求が先に届いた場合は空いた担当にそのままなれる(どちらでも待たない)。
   */
  function release() {
    if (!active) return;
    active = false;
    clearInterval(timer);
    post('release', { token }).catch(() => {});
  }

  return {
    id,
    acquire,
    saveCursor,
    release,
    /** 担当で、かつ担当の期限内に Worker と通信できているか(できていなければ新しい再生を待つ) */
    canPlay: () => active && Date.now() - lastOkAt < ttlMs,
    get active() { return active; },
  };
}
