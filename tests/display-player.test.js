// 表示画面の再生担当・再生位置の保存(worker/src/display.js)を、偽の Firebase に対して確かめる
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../worker/src/index.js';
import { resetTokenCache } from '../worker/src/firebase.js';
import { decideClaim, PLAYER_TTL_MS } from '../worker/src/display.js';
import { createFakeFirebase } from './fake-firebase.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

let fb;
let env;
let now;
const realNow = Date.now;
const ctx = { waitUntil: () => {} };

const Q1 = '-Kq0000000000000001';
const Q2 = '-Kq0000000000000002';
const Q3 = '-Kq0000000000000003';

beforeEach(() => {
  fb = createFakeFirebase();
  globalThis.fetch = fb.fetch;
  resetTokenCache();
  now = 1_800_000_000_000;
  Date.now = () => now;
  env = {
    FIREBASE_DB_URL: fb.dbUrl,
    SA_CLIENT_EMAIL: 'sa@example.iam.gserviceaccount.com',
    SA_PRIVATE_KEY: PEM,
    WEBHOOK_KEY: 'hook-secret',
    ADMIN_KEY: 'admin-secret',
    DISPLAY_KEY_PROD: 'display-prod',
    DISPLAY_KEY_TEST: 'display-test',
  };
  for (const e of ['test', 'prod']) {
    for (const k of [Q1, Q2, Q3]) fb.set(`envs/${e}/queue/${k}`, { sender: k });
  }
});
afterEach(() => { Date.now = realNow; });

async function call(path, body, envName = 'test') {
  const res = await worker.fetch(new Request(`https://w.example.com${path}?env=${envName}`, {
    method: 'POST',
    // 表示画面は事前確認(プリフライト)の要らない text/plain で送る
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body),
  }), env, ctx);
  return { status: res.status, body: await res.json() };
}

const dk = (envName = 'test') => (envName === 'prod' ? 'display-prod' : 'display-test');
const claim = (id, token, envName = 'test') => call('/display/claim', { dk: dk(envName), id, token }, envName);
const beat = (id, token, envName = 'test') => call('/display/heartbeat', { dk: dk(envName), id, token }, envName);
const save = (id, token, key, envName = 'test') => call('/display/cursor', { dk: dk(envName), id, token, key }, envName);
const state = (envName = 'test') => fb.get(`envs/${envName}/state/display`) || {};

test('表示用の合言葉: 未設定・違う・別の環境の合言葉では使えない', async () => {
  assert.equal((await call('/display/claim', { dk: 'wrong', id: 'screen-A1' })).status, 401);
  // 本番の合言葉でテストの担当にはなれない(逆も同じ)
  assert.equal((await call('/display/claim', { dk: 'display-prod', id: 'screen-A1' }, 'test')).status, 401);
  assert.equal((await call('/display/claim', { dk: 'display-test', id: 'screen-A1' }, 'prod')).status, 401);
  delete env.DISPLAY_KEY_TEST;
  const r = await call('/display/claim', { dk: '', id: 'screen-A1' });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /DISPLAY_KEY_TEST/);
  assert.equal((await call('/display/claim', { dk: 'display-test', id: 'screen-A1' }, 'dev')).status, 400);
});

test('同時に開いても担当は1つ。動いている担当は奪われない', async () => {
  const a = await claim('screen-AAAA');
  assert.equal(a.body.role, 'player');
  assert.ok(a.body.token);
  const b = await claim('screen-BBBB');
  assert.equal(b.body.role, 'standby');
  assert.ok(b.body.retryAfterMs >= 2000 && b.body.retryAfterMs <= 10000);
  // 担当が更新を続けていれば、期限を過ぎる時間が経っても B は担当になれない
  for (let i = 0; i < 5; i++) {
    now += 10_000;
    assert.equal((await beat('screen-AAAA', a.body.token)).status, 200);
    assert.equal((await claim('screen-BBBB')).body.role, 'standby');
  }
  assert.equal(state().player.id, 'screen-AAAA');
});

test('画面ID を知っているだけでは担当を奪えない', async () => {
  const a = await claim('screen-AAAA');
  assert.equal((await claim('screen-AAAA')).body.role, 'standby', 'token なし');
  assert.equal((await claim('screen-AAAA', 'x'.repeat(43))).body.role, 'standby', '違う token');
  assert.equal((await beat('screen-AAAA', 'x'.repeat(43))).status, 409);
  assert.equal((await save('screen-AAAA', 'x'.repeat(43), Q1)).status, 409);
  assert.equal((await beat('screen-AAAA', a.body.token)).status, 200, '本物の担当は影響を受けない');
});

test('再読み込み: 前回の token で待たずに担当へ戻れ、古い token は使えなくなる', async () => {
  const a = await claim('screen-AAAA');
  await save('screen-AAAA', a.body.token, Q2);
  const again = await claim('screen-AAAA', a.body.token);
  assert.equal(again.body.role, 'player');
  assert.equal(again.body.resumed, true);
  assert.equal(again.body.cursor, Q2, '再生位置を返す');
  assert.notEqual(again.body.token, a.body.token, 'token は新しくなる');
  assert.equal((await beat('screen-AAAA', a.body.token)).status, 409, '古い token(写し)は使えない');
  assert.equal((await beat('screen-AAAA', again.body.token)).status, 200);
});

test('期限切れなら別の画面が引き継ぎ、元の担当の要求は受け付けない', async () => {
  const a = await claim('screen-AAAA');
  now += PLAYER_TTL_MS + 1;
  const b = await claim('screen-BBBB');
  assert.equal(b.body.role, 'player');
  assert.equal(b.body.resumed, false);
  assert.equal((await beat('screen-AAAA', a.body.token)).status, 409);
  assert.equal((await save('screen-AAAA', a.body.token, Q1)).status, 409);
  assert.equal((await claim('screen-AAAA', a.body.token)).body.role, 'standby', '元の token でも取り戻せない');
  assert.equal(state().player.id, 'screen-BBBB');
});

test('期限を過ぎても誰も引き継いでいなければ、元の担当がそのまま続けられる(Worker 障害からの復帰)', async () => {
  const a = await claim('screen-AAAA');
  now += PLAYER_TTL_MS * 3;
  assert.equal((await beat('screen-AAAA', a.body.token)).status, 200);
  assert.equal((await save('screen-AAAA', a.body.token, Q1)).body.saved, Q1);
});

test('再生位置: 担当からだけ受け付け、形式・実在を確かめ、後戻りしない', async () => {
  const a = await claim('screen-AAAA');
  assert.equal((await save('screen-AAAA', a.body.token, 'abc')).status, 400, '形式');
  assert.equal((await save('screen-AAAA', a.body.token, '-Kq9999999999999999')).status, 400, 'キューに無い');
  assert.equal((await save('screen-AAAA', a.body.token, Q2)).body.saved, Q2);
  assert.equal((await save('screen-AAAA', a.body.token, Q1)).body.ignored, 'older');
  assert.equal((await save('screen-AAAA', a.body.token, Q2)).body.ignored, 'same', '再送は無害');
  assert.equal(state().lastPlayedKey, Q2);
  const b = await claim('screen-BBBB');
  assert.equal((await save('screen-BBBB', b.body.token || 'y'.repeat(43), Q3)).status, 409, '待機中の画面は保存できない');
  assert.equal(state().lastPlayedKey, Q2);
});

test('担当の入れ替えと保存が同時に起きても、入れ替え後に古い担当の保存は通らない', async () => {
  const a = await claim('screen-AAAA');
  now += PLAYER_TTL_MS + 1;
  // A の保存が state を読んだ直後に、B が担当を引き継いだ状況を作る
  const original = globalThis.fetch;
  let injected = false;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (!injected && (init.method || 'GET') === 'PUT' && u.pathname.endsWith('/envs/test/state/display.json')) {
      injected = true;
      globalThis.fetch = original;
      const b = await claim('screen-BBBB'); // B の書き込みが先に通る
      assert.equal(b.body.role, 'player');
      globalThis.fetch = async (i2, n2) => original(i2, n2);
    }
    return original(input, init);
  };
  const r = await save('screen-AAAA', a.body.token, Q3);
  globalThis.fetch = original;
  assert.ok(injected);
  assert.equal(r.status, 409, '読み直したら担当ではなくなっている');
  assert.equal(state().player.id, 'screen-BBBB');
  assert.equal(state().lastPlayedKey, undefined, '古い担当の位置は書かれない');
});

test('本番とテストの担当・再生位置は別々', async () => {
  const t = await claim('screen-TEST', undefined, 'test');
  const p = await claim('screen-PROD', undefined, 'prod');
  assert.equal(t.body.role, 'player');
  assert.equal(p.body.role, 'player', 'テストの担当がいても本番は別');
  await save('screen-TEST', t.body.token, Q3, 'test');
  await save('screen-PROD', p.body.token, Q1, 'prod');
  assert.equal(state('test').lastPlayedKey, Q3);
  assert.equal(state('prod').lastPlayedKey, Q1);
  // テストの token で本番は操作できない
  assert.equal((await beat('screen-TEST', t.body.token, 'prod')).status, 409);
});

test('管理画面から担当を外すと、待機中の画面がすぐ担当になれる。再生位置は残る', async () => {
  const a = await claim('screen-AAAA');
  await save('screen-AAAA', a.body.token, Q2);
  assert.equal((await claim('screen-BBBB')).body.role, 'standby');
  const res = await worker.fetch(new Request('https://w.example.com/admin/display/release?env=test', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'admin-secret' }, body: '{}',
  }), env, ctx);
  assert.equal((await res.json()).released, true);
  const b = await claim('screen-BBBB');
  assert.equal(b.body.role, 'player');
  assert.equal(b.body.cursor, Q2);
  assert.equal((await beat('screen-AAAA', a.body.token)).status, 409, '外された画面は担当ではない');
  assert.equal(state().released, undefined, '別の画面が担当になったら外された記録は消える');
  // 管理用の合言葉が必要
  const denied = await worker.fetch(new Request('https://w.example.com/admin/display/release?env=test', {
    method: 'POST', headers: { 'X-Admin-Key': 'nope' }, body: '{}',
  }), env, ctx);
  assert.equal(denied.status, 401);
});

test('管理画面から外された画面は、すぐには担当に戻れない(待機中の画面へ確実に切り替わる)', async () => {
  const a = await claim('screen-AAAA');
  const rel = () => worker.fetch(new Request('https://w.example.com/admin/display/release?env=test', {
    method: 'POST', headers: { 'X-Admin-Key': 'admin-secret' }, body: '{}',
  }), env, ctx);
  await rel();
  assert.equal((await claim('screen-AAAA', a.body.token)).body.role, 'standby', '元の token でも戻れない');
  assert.equal((await claim('screen-AAAA')).body.role, 'standby');
  // ほかに画面が無ければ、30秒後には元の画面が担当に戻れる
  now += PLAYER_TTL_MS + 1;
  assert.equal((await claim('screen-AAAA')).body.role, 'player');
});

test('担当を降りると、次の画面がすぐ担当になれる', async () => {
  const a = await claim('screen-AAAA');
  assert.equal((await call('/display/release', { dk: dk(), id: 'screen-AAAA', token: a.body.token })).status, 200);
  assert.equal((await claim('screen-BBBB')).body.role, 'player');
});

test('decideClaim: 判断の表', () => {
  const p = { id: 'screen-AAAA', tokenHash: 'h1', expiresAt: 2000 };
  assert.equal(decideClaim(null, { id: 'x', tokenHash: '' }, 1000).action, 'claim');
  assert.equal(decideClaim(p, { id: 'screen-AAAA', tokenHash: 'h1' }, 1000).action, 'resume');
  assert.equal(decideClaim(p, { id: 'screen-AAAA', tokenHash: '' }, 1000).action, 'standby');
  assert.equal(decideClaim(p, { id: 'other', tokenHash: 'h1' }, 1000).action, 'standby', 'ID と token の両方が必要');
  assert.equal(decideClaim(p, { id: 'other', tokenHash: '' }, 2000).action, 'claim', '期限ちょうどで切れる');
});

test('Firebase ルール: ブラウザから state/display に書き込めない', () => {
  const rules = JSON.parse(readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8'));
  const text = JSON.stringify(rules);
  assert.ok(!text.includes('".write":"$env'), 'どのパスにもブラウザからの書き込み許可が無い');
  const st = rules.rules.envs.$env.state;
  assert.equal(st.display, undefined, 'state/display に書き込みの許可を置かない');
  assert.ok(st['.read'], '再生位置・担当の状態は読める(テスト画面・管理画面の表示用)');
});
