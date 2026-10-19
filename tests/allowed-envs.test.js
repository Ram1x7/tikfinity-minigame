// テスト専用の Worker(ALLOWED_ENVS=test)では、本番への要求をすべての入口で拒否する
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../worker/src/index.js';
import { resetTokenCache } from '../worker/src/firebase.js';
import { allowedEnvs, envAllowed } from '../worker/src/http.js';
import { createFakeFirebase } from './fake-firebase.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const ctx = { waitUntil: () => {} };
let fb;
let env;

const CONFIG = {
  tables: { t1: { title: 'T', items: [{ label: '釣り', weight: 1 }] } },
  gifts: { Rose: { giftName: 'Rose', mode: 'gacha', tableId: 't1' } },
};

beforeEach(() => {
  fb = createFakeFirebase();
  globalThis.fetch = fb.fetch;
  resetTokenCache();
  env = {
    FIREBASE_DB_URL: fb.dbUrl,
    SA_CLIENT_EMAIL: 'sa@example.iam.gserviceaccount.com',
    SA_PRIVATE_KEY: PEM,
    WEBHOOK_KEY: 'hook',
    ADMIN_KEY: 'admin',
    DISPLAY_KEY_TEST: 'dk-test',
    DISPLAY_KEY_PROD: 'dk-prod',
    ALLOWED_ENVS: 'test',
  };
  fb.set('envs/prod/config', CONFIG);
  fb.set('envs/test/config', CONFIG);
});

const post = (path, { admin = false, body = {}, type = 'application/json' } = {}) => worker.fetch(new Request(`https://w${path}`, {
  method: 'POST',
  headers: { 'Content-Type': type, ...(admin ? { 'X-Admin-Key': 'admin' } : {}) },
  body: JSON.stringify(body),
}), env, ctx);

test('ALLOWED_ENVS の読み方', () => {
  assert.equal(allowedEnvs({}), null, '未設定なら制限なし');
  assert.deepEqual(allowedEnvs({ ALLOWED_ENVS: ' Test ' }), ['test']);
  assert.deepEqual(allowedEnvs({ ALLOWED_ENVS: 'test,prod' }), ['test', 'prod']);
  assert.deepEqual(allowedEnvs({ ALLOWED_ENVS: 'tset' }), [], '書き間違いはどの環境も使えない(安全側)');
  assert.equal(envAllowed({}, 'prod'), true);
  assert.equal(envAllowed({ ALLOWED_ENVS: 'test' }, 'prod'), false);
  assert.equal(envAllowed({ ALLOWED_ENVS: 'test' }, undefined), false);
});

test('本番への要求は Webhook・管理・表示のすべてで 403 になり、本番のデータは変わらない', async () => {
  const before = JSON.stringify(fb.get('envs/prod'));
  const denied = [
    ['Webhook', post('/webhook?env=prod&k=hook', { body: { giftName: 'Rose', msgId: 'p1' } })],
    ['設定の保存', post('/admin/config?env=prod', { admin: true, body: CONFIG })],
    ['テスト送信', post('/admin/test-gift?env=prod', { admin: true, body: { giftName: 'Rose' } })],
    ['消去', post('/admin/clear?env=prod', { admin: true })],
    ['設定のコピー', post('/admin/copy-config?from=test&to=prod', { admin: true })],
    ['設定のコピー(本番から)', post('/admin/copy-config?from=prod&to=test', { admin: true })],
    ['再生担当の解除', post('/admin/display/release?env=prod', { admin: true })],
    ['再生担当', post('/display/claim?env=prod', { type: 'text/plain', body: { dk: 'dk-prod', id: 'screen-AAAA' } })],
    ['担当の更新', post('/display/heartbeat?env=prod', { type: 'text/plain', body: { dk: 'dk-prod', id: 'screen-AAAA', token: 'x'.repeat(43) } })],
    ['再生位置', post('/display/cursor?env=prod', { type: 'text/plain', body: { dk: 'dk-prod', id: 'screen-AAAA', token: 'x'.repeat(43), key: '-Kq0000000000000001' } })],
    ['担当を降りる', post('/display/release?env=prod', { type: 'text/plain', body: { dk: 'dk-prod', id: 'screen-AAAA', token: 'x'.repeat(43) } })],
  ];
  for (const [label, p] of denied) {
    const res = await p;
    assert.equal(res.status, 403, label);
    assert.match((await res.json()).error, /ALLOWED_ENVS/, label);
  }
  assert.equal(JSON.stringify(fb.get('envs/prod')), before, '本番のデータは変わらない');
});

test('環境の指定が無い要求も拒否する', async () => {
  assert.equal((await post('/webhook?k=hook', { body: { giftName: 'Rose' } })).status, 400);
  assert.equal((await post('/admin/config', { admin: true, body: CONFIG })).status, 400);
  assert.equal((await post('/display/claim', { type: 'text/plain', body: { dk: 'dk-test', id: 'screen-AAAA' } })).status, 400);
  assert.equal(fb.get('envs/test/queue'), null);
});

test('テスト環境はそのまま使える', async () => {
  assert.equal((await (await post('/webhook?env=test&k=hook', { body: { giftName: 'Rose', msgId: 't1' } })).json()).status, 'queued');
  assert.equal((await post('/admin/config?env=test', { admin: true, body: CONFIG })).status, 200);
  const claim = await (await post('/display/claim?env=test', { type: 'text/plain', body: { dk: 'dk-test', id: 'screen-AAAA' } })).json();
  assert.equal(claim.role, 'player');
  const ping = await (await post('/admin/ping', { admin: true })).json();
  assert.equal(ping.firebase, 'ok');
  const info = await (await worker.fetch(new Request('https://w/'), env, ctx)).json();
  assert.deepEqual(info.allowedEnvs, ['test'], '接続テストで制限を確認できる');
});

test('ALLOWED_ENVS が書き間違いならテストも本番も使えない', async () => {
  env.ALLOWED_ENVS = 'tset';
  assert.equal((await post('/webhook?env=test&k=hook', { body: { giftName: 'Rose' } })).status, 403);
  assert.equal((await post('/admin/config?env=test', { admin: true, body: CONFIG })).status, 403);
});

test('ALLOWED_ENVS が無い Worker(本番用)はこれまでどおり両方使える', async () => {
  delete env.ALLOWED_ENVS;
  assert.equal((await (await post('/webhook?env=prod&k=hook', { body: { giftName: 'Rose', msgId: 'p2' } })).json()).status, 'queued');
  assert.equal((await post('/admin/config?env=prod', { admin: true, body: CONFIG })).status, 200);
});
