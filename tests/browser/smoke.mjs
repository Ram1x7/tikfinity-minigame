// ブラウザでの動作確認(任意)。Firebase と Worker を偽物に差し替えて、
// 表示画面・管理画面・テスト画面を実際の Chromium で動かす。
//
//   node tests/browser/smoke.mjs
//
// playwright が必要(npx playwright install chromium などで用意)。
// スクリーンショットは screenshots/ に保存される。
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { sanitizeConfig } from '../../shared/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const shots = join(root, 'screenshots');
await mkdir(shots, { recursive: true });

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* グローバルを探す */ }
  const globalRoot = execSync('npm root -g').toString().trim();
  return createRequire(join(globalRoot, 'noop.js'))('playwright');
}
const { chromium } = await loadPlaywright();

// ---- 静的ファイルサーバー ----
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    const file = join(root, path.endsWith('/') ? path + 'index.html' : path);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const stubDb = await readFile(join(root, 'tests/browser/firebase-database-stub.js'), 'utf8');
const stubConfig = `export const firebaseConfig = { apiKey: 'x', databaseURL: 'https://fake.example.com' };
export const DEFAULT_WORKER_URL = 'https://worker.test';`;

const workerCalls = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

async function newPage(viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/firebasejs/**/firebase-app.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'export const initializeApp = () => ({});' }));
  await page.route('**/firebasejs/**/firebase-database.js', (r) => r.fulfill({ contentType: 'text/javascript', body: stubDb }));
  await page.route('**/js/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: stubConfig }));
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('https://worker.test/**', async (r) => {
    const url = new URL(r.request().url());
    const body = r.request().postData();
    workerCalls.push({ path: url.pathname, search: url.search, body: body ? JSON.parse(body) : null, key: r.request().headers()['x-admin-key'] });
    const reply = url.pathname === '/admin/test-gift'
      ? { status: 'queued', key: '-x', rolls: ['釣り'] }
      : { ok: true, warnings: [] };
    await r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(reply) });
  });
  return { page, errors };
}

const item = (sender, mode, labels) => ({
  giftName: 'Rose', sender, repeatCount: labels.length, mode, title: 'テスト', source: 'test', receivedAt: Date.now(),
  rolls: labels.map((l, i) => ({ label: l, rarity: ['N', 'R', 'SR', 'SSR'][i % 4], color: '' })),
  pool: ['釣り', '虫とり', '料理', 'ガーデニング', '鳥の観察'].map((l) => ({ label: l, weight: 1, rarity: 'N', color: '' })),
});

try {
  // ---------- 表示画面: 連続で届いた3件を順番に再生し、再生位置を保存する ----------
  {
    const { page, errors } = await newPage({ width: 540, height: 960 });
    await page.goto(`${base}/display.html?env=test&speed=4`);
    await page.waitForTimeout(300);
    const order = [];
    await page.exposeFunction('__record', (t) => order.push(t));
    await page.evaluate(() => {
      new MutationObserver(() => {
        const t = document.getElementById('ev-sender').textContent;
        if (t) window.__record(t);
      }).observe(document.getElementById('ev-sender'), { childList: true, characterData: true, subtree: true });
    });
    const keys = await page.evaluate((items) => items.map((it) => window.__fakeDb.push('envs/test/queue', it)), [
      item('一郎', 'gacha', ['魚を3匹釣る', '花を植える']),
      item('二郎', 'roulette', ['料理']),
      item('三郎', 'gacha', ['住民にあいさつ']),
    ]);
    await page.waitForSelector('#pending:not([hidden])', { timeout: 3000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(shots, 'display-gacha.png') });
    await page.waitForFunction(() => document.querySelector('#ev-sender').textContent.startsWith('二郎'), null, { timeout: 15000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(shots, 'display-roulette.png') });
    await page.waitForFunction((k) => window.__fakeDb.get('envs/test/state/display/lastPlayedKey') === k, keys[2], { timeout: 20000 });
    const unique = order.filter((t, i) => t !== order[i - 1]);
    assert.deepEqual(unique, ['一郎 さん', '二郎 さん', '三郎 さん'], `再生順: ${unique}`);
    const transparent = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(transparent, 'rgba(0, 0, 0, 0)', '背景が透明');
    assert.deepEqual(errors, [], `表示画面のエラー: ${errors}`);
    console.log('✔ 表示画面: 3件を届いた順に再生し、再生位置を保存した');

    // 読み込み直しても再生済みのものは再生しない
    const before = order.length;
    await page.reload();
    await page.waitForTimeout(1500);
    const visible = await page.evaluate(() => document.getElementById('event').classList.contains('show'));
    assert.equal(visible, false, '再読み込み後に再生済みを再生しない');
    assert.equal(order.length, before);
    console.log('✔ 表示画面: 読み込み直しても二重再生しない');
    await page.close();
  }

  // ---------- 管理画面: サンプル読み込み→保存で Worker に正しい形で送る ----------
  {
    const { page, errors } = await newPage({ width: 390, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem('tm.adminKey', 'admin-secret');
    });
    await page.goto(`${base}/admin.html?env=test`);
    page.on('dialog', (d) => d.accept());
    await page.click('#load-sample');
    await page.waitForSelector('#gift-list .item');
    const probs = await page.$$eval('#table-list .item:first-child .prob', (els) => els.map((e) => e.textContent));
    assert.ok(probs.length > 0 && probs.every((p) => p.endsWith('%')), `確率表示: ${probs}`);
    await page.click('#add-gift');
    await page.fill('#gift-list .item:last-child .item__name', 'Galaxy');
    await page.screenshot({ path: join(shots, 'admin-iphone.png'), fullPage: true });
    await page.click('#save');
    await page.waitForTimeout(500);
    const call = workerCalls.find((c) => c.path === '/admin/config');
    assert.ok(call, '設定保存の呼び出し');
    assert.equal(call.key, 'admin-secret');
    assert.equal(call.search, '?env=test');
    const { config, errors: warn } = sanitizeConfig(call.body);
    assert.deepEqual(warn, []);
    assert.ok(config.gifts.Galaxy && config.gifts.Rose, 'ギフトが送られている');
    assert.equal(Object.keys(config.tables).length, 2);
    assert.deepEqual(errors, [], `管理画面のエラー: ${errors}`);
    console.log('✔ 管理画面: 編集内容を正しい形で Worker に保存できる');
    await page.close();
  }

  // ---------- テスト画面: 疑似ギフト送信 ----------
  {
    const { page, errors } = await newPage({ width: 1024, height: 1366 });
    await page.addInitScript(() => localStorage.setItem('tm.adminKey', 'admin-secret'));
    await page.goto(`${base}/test.html?env=test`);
    await page.fill('#t-gift', 'Rose');
    await page.click('#t-send');
    await page.waitForSelector('#t-result .log--queued');
    const call = workerCalls.find((c) => c.path === '/admin/test-gift');
    assert.equal(call.body.giftName, 'Rose');
    assert.equal(call.search, '?env=test');
    await page.evaluate(() => window.__fakeDb.push('envs/test/queue', {
      giftName: 'Rose', sender: 'テストさん', repeatCount: 1, mode: 'gacha', rolls: [{ label: '釣り', rarity: 'N' }], receivedAt: Date.now(), source: 'test',
    }));
    await page.waitForSelector('#t-queue .log__item');
    await page.screenshot({ path: join(shots, 'test-ipad.png'), fullPage: true });
    assert.deepEqual(errors, [], `テスト画面のエラー: ${errors}`);
    console.log('✔ テスト画面: 疑似ギフトを送信し、キューを表示できる');
    await page.close();
  }

  // ---------- トップページ ----------
  {
    const { page, errors } = await newPage({ width: 390, height: 844 });
    await page.goto(`${base}/`);
    await page.waitForFunction(() => document.getElementById('setup-status').textContent !== '');
    assert.deepEqual(errors, []);
    console.log('✔ トップページ');
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
