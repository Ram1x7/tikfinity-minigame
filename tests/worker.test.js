// Worker を偽の Firebase に対して最後まで動かす結合テスト
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../worker/src/index.js';
import { resetTokenCache, extractPrivateKey } from '../worker/src/firebase.js';
import { allowedOrigins } from '../worker/src/index.js';
import { createFakeFirebase } from './fake-firebase.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

let fb;
let env;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };

beforeEach(() => {
  fb = createFakeFirebase();
  globalThis.fetch = fb.fetch;
  resetTokenCache();
  env = {
    FIREBASE_DB_URL: fb.dbUrl,
    SA_CLIENT_EMAIL: 'sa@example.iam.gserviceaccount.com',
    // ダッシュボードで改行が \n の文字列として入っても動くことを確認
    SA_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'),
    WEBHOOK_KEY: 'hook-secret',
    ADMIN_KEY: 'admin-secret',
  };
});

async function settle() {
  while (pending.length) await pending.shift();
}

function webhook(params, { key = 'hook-secret', envName = 'test', json = false } = {}) {
  const url = `https://w.example.com/webhook?env=${envName}&k=${encodeURIComponent(key)}`;
  const init = json
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) }
    : { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() };
  return worker.fetch(new Request(url, init), env, ctx);
}

function admin(path, body, { key = 'admin-secret' } = {}) {
  return worker.fetch(new Request(`https://w.example.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
    body: JSON.stringify(body ?? {}),
  }), env, ctx);
}

const CONFIG = {
  tables: {
    t1: { title: '縛り', items: [{ label: '釣り禁止', weight: 1 }, { label: '料理3品', weight: 1 }] },
  },
  gifts: {
    a: { giftName: 'Rose', mode: 'gacha', tableId: 't1', combo: 'perCount', maxRolls: 5 },
    b: { giftName: 'Off', mode: 'gacha', tableId: 't1', enabled: false },
  },
  settings: { dedupeWindowSec: 3 },
};

const queue = (e = 'test') => Object.entries(fb.get(`envs/${e}/queue`) || {}).sort(([x], [y]) => (x < y ? -1 : 1));

test('合言葉が違えば拒否し、何も書き込まない', async () => {
  assert.equal((await webhook({ giftName: 'Rose' }, { key: 'wrong' })).status, 401);
  assert.equal((await admin('/admin/config', CONFIG, { key: 'wrong' })).status, 401);
  assert.equal(fb.get('envs'), null);
});

test('設定を保存し、form形式のWebhookでキューに積まれる', async () => {
  const saved = await (await admin('/admin/config?env=test', CONFIG)).json();
  assert.equal(saved.ok, true);
  assert.equal(fb.get('envs/test/config/gifts/Rose/tableId'), 't1');

  const res = await (await webhook({ giftName: 'Rose', repeatCount: '3', nickname: 'たろう', uniqueId: 'taro' })).json();
  await settle();
  assert.equal(res.status, 'queued');
  const q = queue();
  assert.equal(q.length, 1);
  const item = q[0][1];
  assert.equal(item.sender, 'たろう');
  assert.equal(item.rolls.length, 3);
  assert.ok(item.rolls.every((r) => ['釣り禁止', '料理3品'].includes(r.label)));
  assert.equal(typeof item.receivedAt, 'number');
  assert.equal(item.source, 'webhook');

  // 本番側には書き込まれていない
  assert.equal(fb.get('envs/prod'), null);
  // 受信ログが残る
  const log = Object.values(fb.get('envs/test/log'));
  assert.equal(log[0].fields.giftName, 'Rose');
  assert.equal(log[0].result.status, 'queued');
});

test('JSON形式・入れ子のデータでも受け付ける', async () => {
  await admin('/admin/config?env=test', CONFIG);
  const res = await (await webhook({ data: { giftName: 'Rose', repeatCount: 1, nickname: 'はな' } }, { json: true })).json();
  assert.equal(res.status, 'queued');
});

test('同じmsgIdは二重に積まない。msgIdが無い時は時間窓で判定', async (t) => {
  await admin('/admin/config?env=test', CONFIG);
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);

  assert.equal((await (await webhook({ giftName: 'Rose', msgId: 'X1' })).json()).status, 'queued');
  now += 60_000;
  assert.equal((await (await webhook({ giftName: 'Rose', msgId: 'X1' })).json()).status, 'duplicate');

  assert.equal((await (await webhook({ giftName: 'Rose', uniqueId: 'u' })).json()).status, 'queued');
  now += 1000;
  assert.equal((await (await webhook({ giftName: 'Rose', uniqueId: 'u' })).json()).status, 'duplicate');
  now += 5000;
  assert.equal((await (await webhook({ giftName: 'Rose', uniqueId: 'u' })).json()).status, 'queued');
  await settle();
  assert.equal(queue().length, 3);
});

test('キューへの書き込みに失敗したら重複記録を取り消し、再送を受け付ける', async () => {
  await admin('/admin/config?env=test', CONFIG);
  fb.failOnce('POST', '/queue');
  const first = await webhook({ giftName: 'Rose', msgId: 'retry-me' });
  assert.equal(first.status, 500);
  assert.equal(fb.get('envs/test/dedupe'), null, '重複記録が残っていない');
  const retry = await (await webhook({ giftName: 'Rose', msgId: 'retry-me' })).json();
  assert.equal(retry.status, 'queued');
  await settle();
  assert.equal(queue().length, 1);
});

test('同時に届いた同一イベントは片方だけ積まれる', async () => {
  await admin('/admin/config?env=test', CONFIG);
  const results = await Promise.all([
    webhook({ giftName: 'Rose', msgId: 'same' }),
    webhook({ giftName: 'Rose', msgId: 'same' }),
    webhook({ giftName: 'Rose', msgId: 'same' }),
  ].map((p) => p.then((r) => r.json())));
  await settle();
  assert.equal(results.filter((r) => r.status === 'queued').length, 1);
  assert.equal(queue().length, 1);
});

test('別々のギフトが続けて届くと、届いた順にキューに並ぶ', async () => {
  await admin('/admin/config?env=test', CONFIG);
  for (const name of ['一郎', '二郎', '三郎', '四郎']) {
    await webhook({ giftName: 'Rose', nickname: name, uniqueId: name });
    fb.advance(10);
  }
  await settle();
  assert.deepEqual(queue().map(([, v]) => v.sender), ['一郎', '二郎', '三郎', '四郎']);
});

test('未設定・無効・連続ギフト途中はキューに積まずログに残す', async () => {
  await admin('/admin/config?env=test', CONFIG);
  const r1 = await (await webhook({ giftName: 'Unknown' })).json();
  const r2 = await (await webhook({ giftName: 'Off' })).json();
  const r3 = await (await webhook({ giftName: 'Rose', repeatEnd: 'false', msgId: 'streak' })).json();
  assert.deepEqual([r1.status, r2.status, r3.status], ['skipped', 'skipped', 'skipped']);
  assert.equal(queue().length, 0);
  assert.equal(Object.keys(fb.get('envs/test/log')).length, 3);
});

test('テスト用ギフト・設定コピー・消去', async () => {
  await admin('/admin/config?env=test', CONFIG);
  const r = await (await admin('/admin/test-gift?env=test', { giftName: 'Rose', repeatCount: 2, nickname: 'テスト' })).json();
  assert.equal(r.status, 'queued');
  assert.equal(queue()[0][1].source, 'test');

  await admin('/admin/copy-config?from=test&to=prod');
  assert.equal(fb.get('envs/prod/config/gifts/Rose/giftName'), 'Rose');
  assert.equal(fb.get('envs/prod/queue'), null, 'コピーするのは設定だけ');

  await admin('/admin/clear?env=test');
  assert.equal(fb.get('envs/test/queue'), null);
  assert.equal(fb.get('envs/test/config/gifts/Rose/giftName'), 'Rose', '設定は消さない');
});

test('古いキューと重複記録を掃除して容量を保つ', async () => {
  await admin('/admin/config?env=test', CONFIG);
  const many = {};
  for (let i = 0; i < 310; i++) many[`-k${String(i).padStart(4, '0')}`] = { sender: String(i) };
  fb.set('envs/test/queue', many);
  fb.set('envs/test/dedupe/old', Date.now() - 2 * 24 * 60 * 60 * 1000);

  await webhook({ giftName: 'Rose', uniqueId: 'x' });
  await settle();
  const keys = queue().map(([k]) => k);
  assert.equal(keys.length, 300);
  assert.ok(!keys.includes('-k0000'), '古いものから消える');
  assert.equal(fb.get('envs/test/dedupe/old'), null);
});

test('env の指定が不正なら拒否', async () => {
  assert.equal((await webhook({ giftName: 'Rose' }, { envName: 'dev' })).status, 400);
  assert.equal((await admin('/admin/config?env=staging', CONFIG)).status, 400);
});

test('ALLOWED_ORIGIN はパスや末尾の / が付いていても受け付ける', async () => {
  assert.deepEqual(allowedOrigins('https://ram1x7.github.io/tikfinity-minigame/'), ['https://ram1x7.github.io']);
  assert.deepEqual(allowedOrigins(' https://a.example.com , ram1x7.github.io '), ['https://a.example.com']);
  assert.deepEqual(allowedOrigins(''), []);

  env.ALLOWED_ORIGIN = 'https://ram1x7.github.io/tikfinity-minigame/';
  const res = await worker.fetch(new Request('https://w.example.com/admin/ping', {
    method: 'OPTIONS', headers: { Origin: 'https://ram1x7.github.io' },
  }), env, ctx);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://ram1x7.github.io');
});

test('動作確認用の GET / はシークレットの有無だけを返す(値は返さない)', async () => {
  delete env.WEBHOOK_KEY;
  const body = await (await worker.fetch(new Request('https://w.example.com/'), env, ctx)).json();
  assert.equal(body.service, 'tikfinity-minigame');
  assert.equal(body.secrets.ADMIN_KEY, true);
  assert.equal(body.secrets.WEBHOOK_KEY, false);
  assert.ok(!JSON.stringify(body).includes('admin-secret'));
});

test('/admin/ping で Firebase への接続まで確認できる', async () => {
  const ok = await (await admin('/admin/ping')).json();
  assert.equal(ok.firebase, 'ok');
  assert.equal((await admin('/admin/ping', {}, { key: 'x' })).status, 401);

  env.FIREBASE_DB_URL = 'https://console.firebase.google.com/project/x';
  const bad = await admin('/admin/ping');
  assert.equal(bad.status, 500);
  assert.match((await bad.json()).error, /FIREBASE_DB_URL の形式/);
});

test('SA_PRIVATE_KEY の貼り付けミスを吸収し、読めない時は分かるエラーを返す', async () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\n';
  assert.equal(extractPrivateKey(JSON.stringify({ private_key: pem })), pem.trim());
  assert.equal(extractPrivateKey(`"${pem.replace(/\n/g, '\\n')}"`), pem.trim());

  // JSON ファイルを丸ごと貼っても動く
  env.SA_PRIVATE_KEY = JSON.stringify({ type: 'service_account', private_key: PEM });
  assert.equal((await (await admin('/admin/ping')).json()).firebase, 'ok');

  resetTokenCache();
  env.SA_PRIVATE_KEY = 'これは鍵ではない';
  const bad = await (await admin('/admin/ping')).json();
  assert.match(bad.firebase, /SA_PRIVATE_KEY/);
});
