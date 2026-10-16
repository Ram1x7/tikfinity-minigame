// Cloudflare に貼り付ける1ファイル版(worker/dist/worker.js)が、元のコードと同じように動くか確認する
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../worker/dist/worker.js';
import { createFakeFirebase } from './fake-firebase.js';

test('1ファイル版でも設定保存→Webhook→キュー追加ができる', async () => {
  const fb = createFakeFirebase();
  globalThis.fetch = fb.fetch;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = {
    FIREBASE_DB_URL: fb.dbUrl,
    SA_CLIENT_EMAIL: 'sa@example.iam.gserviceaccount.com',
    SA_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    WEBHOOK_KEY: 'hook',
    ADMIN_KEY: 'admin',
  };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };

  const cfg = await worker.fetch(new Request('https://w/admin/config?env=prod', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'admin' },
    body: JSON.stringify({
      tables: { t: { title: 'T', items: [{ label: 'A', weight: 1 }] } },
      gifts: [{ giftName: 'Rose', tableId: 't' }],
    }),
  }), env, ctx);
  assert.equal(cfg.status, 200);

  const res = await worker.fetch(new Request('https://w/webhook?env=prod&k=hook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'giftName=Rose&repeatCount=1&nickname=%E3%81%9F%E3%82%8D%E3%81%86',
  }), env, ctx);
  await Promise.all(pending);
  assert.equal((await res.json()).status, 'queued');
  const item = Object.values(fb.get('envs/prod/queue'))[0];
  assert.equal(item.sender, 'たろう');
  assert.equal(item.rolls[0].label, 'A');

  const health = await worker.fetch(new Request('https://w/'), env, ctx);
  assert.equal(health.status, 200);
});
