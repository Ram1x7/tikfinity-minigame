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
import { generateKeyPairSync } from 'node:crypto';
import { sanitizeConfig } from '../../shared/core.js';
import realWorker from '../../worker/src/index.js';
import { resetTokenCache } from '../../worker/src/firebase.js';
import { createFakeFirebase } from '../fake-firebase.js';

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
export const DEFAULT_WORKER_URL = 'https://worker.test';
export const IS_PREVIEW_SITE = false;`;

const workerCalls = [];

// ---- 再生担当・再生位置(/display/*)は、本物の Worker のコードを偽の Firebase に対して動かす ----
const { privateKey: saKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
let wfb;
let workerEnv;
let workerDown = false; // true の間は /display/* に届かない(Worker 障害の再現)
// 表示画面に伝える担当の期限・更新間隔を短くする(障害で再生が止まるまでを短い時間で確かめるため。Worker 側の判断は変えない)
let clientTiming = null;
function resetWorker() {
  wfb = createFakeFirebase();
  resetTokenCache();
  workerEnv = {
    FIREBASE_DB_URL: wfb.dbUrl,
    SA_CLIENT_EMAIL: 'sa@example.iam.gserviceaccount.com',
    SA_PRIVATE_KEY: saKey.export({ type: 'pkcs8', format: 'pem' }),
    WEBHOOK_KEY: 'hook', ADMIN_KEY: 'admin-secret', DISPLAY_KEY_PROD: 'dk-prod', DISPLAY_KEY_TEST: 'dk-test',
  };
}
resetWorker();
globalThis.fetch = (...a) => wfb.fetch(...a); // Worker から Firebase への通信を偽物へ
const workerState = (env) => wfb.get(`envs/${env}/state/display`) || {};
async function until(fn, timeout, label) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`時間切れ: ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
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
    if (url.pathname.startsWith('/display/') || url.pathname === '/admin/display/release') {
      if (workerDown && url.pathname.startsWith('/display/')) { await r.abort('failed'); return; }
      if (r.request().method() === 'OPTIONS') {
        await r.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
        return;
      }
      workerCalls.push({ path: url.pathname, search: url.search });
      // 表示画面のキュー(ブラウザ側の偽 DB)を Worker 側の偽 DB に写す(再生位置の実在確認のため)
      for (const e of ['test', 'prod']) {
        const q = await page.evaluate((x) => window.__fakeDb?.get(`envs/${x}/queue`), e).catch(() => null);
        if (q) for (const [k, v] of Object.entries(q)) if (!wfb.get(`envs/${e}/queue/${k}`)) wfb.set(`envs/${e}/queue/${k}`, v);
      }
      const res = await realWorker.fetch(new Request(url.toString(), {
        method: r.request().method(), headers: r.request().headers(), body: body ?? undefined,
      }), workerEnv, { waitUntil: () => {} });
      let text = await res.text();
      if (clientTiming && url.pathname === '/display/claim') {
        const data = JSON.parse(text);
        if (data.role === 'player') text = JSON.stringify({ ...data, ...clientTiming });
      }
      await r.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: text });
      return;
    }
    workerCalls.push({ path: url.pathname, search: url.search, body: body ? JSON.parse(body) : null, key: r.request().headers()['x-admin-key'] });
    const replies = {
      '/': { ok: true, service: 'tikfinity-minigame', version: 'test', secrets: { FIREBASE_DB_URL: true, SA_CLIENT_EMAIL: true, SA_PRIVATE_KEY: true, WEBHOOK_KEY: false, ADMIN_KEY: true }, allowedOrigins: [],
        allowedEnvs: workerEnv.ALLOWED_ENVS ? workerEnv.ALLOWED_ENVS.split(',') : null },
      '/admin/ping': { ok: true, firebase: 'ok' },
      '/admin/test-gift': { status: 'queued', key: '-x', rolls: ['釣り'] },
    };
    if (r.request().method() === 'OPTIONS') {
      await r.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
      return;
    }
    const reply = replies[url.pathname] || { ok: true, warnings: [] };
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
    await page.goto(`${base}/display.html?env=test&dk=dk-test&speed=4`);
    await page.waitForFunction(() => document.body.dataset.player === 'player', null, { timeout: 10000 });
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
    await until(() => workerState('test').lastPlayedKey === keys[2], 20000, '再生位置の保存(Worker 経由)');
    const unique = order.filter((t, i) => t !== order[i - 1]);
    assert.deepEqual(unique, ['一郎 さん', '二郎 さん', '三郎 さん'], `再生順: ${unique}`);
    const transparent = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(transparent, 'rgba(0, 0, 0, 0)', '背景が透明');
    assert.deepEqual(errors, [], `表示画面のエラー: ${errors}`);
    console.log('✔ 表示画面: 3件を届いた順に再生し、再生位置を保存した');

    // 読み込み直しても再生済みのものは再生しない
    const before = order.length;
    const screenId = workerState('test').player.id;
    const t0 = Date.now();
    await page.reload();
    // 再読み込みしても待たずに担当へ戻る(期限切れの30秒を待たない)
    await page.waitForFunction(() => document.body.dataset.player === 'player', null, { timeout: 5000 });
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(workerState('test').player.id, screenId, '同じ画面(タブ)のまま担当');
    await page.waitForTimeout(1500);
    const visible = await page.evaluate(() => document.getElementById('event').classList.contains('show'));
    assert.equal(visible, false, '再読み込み後に再生済みを再生しない');
    assert.equal(order.length, before);
    console.log('✔ 表示画面: 読み込み直しても二重再生しない(待たずに担当へ戻る)');
    await page.close();
  }

  // ---------- 表示画面: 再生担当は1つだけ。切り替え・Worker 障害・本番とテストの分離 ----------
  {
    resetWorker();
    const a = await newPage({ width: 360, height: 640 });
    const b = await newPage({ width: 360, height: 640 });
    const role = (p) => p.page.evaluate(() => document.body.dataset.player);
    await a.page.goto(`${base}/display.html?env=test&dk=dk-test&speed=4`);
    await a.page.waitForFunction(() => document.body.dataset.player === 'player', null, { timeout: 10000 });
    await b.page.goto(`${base}/display.html?env=test&dk=dk-test&speed=4&debug=1`);
    await b.page.waitForFunction(() => document.body.dataset.player === 'standby', null, { timeout: 10000 });
    assert.match(await b.page.textContent('#notice'), /待機中/, 'debug=1 のときだけ待機中と表示');
    // 同じギフトが両方の画面に届いても、再生するのは担当だけ
    for (const p of [a, b]) await p.page.evaluate((it) => window.__fakeDb.push('envs/test/queue', it), item('同時', 'gacha', ['釣り']));
    await a.page.waitForFunction(() => document.getElementById('event').classList.contains('show'), null, { timeout: 5000 });
    await b.page.waitForTimeout(1500);
    assert.equal(await b.page.evaluate(() => document.getElementById('event').classList.contains('show')), false, '待機中の画面は再生しない');
    // 担当が動いているあいだは奪われない
    await b.page.waitForTimeout(11000);
    assert.equal(await role(b), 'standby');
    assert.equal(await role(a), 'player');
    console.log('✔ 再生担当: 同時に開いても再生は1つ、動いている担当は奪われない');

    // 管理画面から担当を外すと、待機中の画面が引き継ぎ、元の画面は待機になる
    const adm = await realWorker.fetch(new Request('https://w/admin/display/release?env=test', { method: 'POST', headers: { 'X-Admin-Key': 'admin-secret' }, body: '{}' }), workerEnv, { waitUntil: () => {} });
    assert.equal((await adm.json()).released, true);
    await b.page.waitForFunction(() => document.body.dataset.player === 'player', null, { timeout: 15000 });
    await a.page.waitForFunction(() => document.body.dataset.player === 'standby', null, { timeout: 15000 });
    console.log('✔ 再生担当: 管理画面からの切り替え');

    // Worker に届かないあいだも再生は続け、再生位置の保存は復旧後にやり直して届く
    workerDown = true;
    const k = await b.page.evaluate((it) => window.__fakeDb.push('envs/test/queue', it), item('障害中', 'gacha', ['料理']));
    await b.page.waitForFunction(() => document.getElementById('ev-sender').textContent.startsWith('障害中'), null, { timeout: 8000 });
    await b.page.waitForTimeout(4000);
    assert.notEqual(workerState('test').lastPlayedKey, k, '障害中は保存できない');
    workerDown = false;
    await until(() => workerState('test').lastPlayedKey === k, 25000, '復旧後に再生位置が保存される');
    assert.equal(await role(b), 'player', '担当のまま');
    console.log('✔ 再生担当: Worker 障害のあいだは保存をやり直し、復旧後に保存');

    // 本番とテストは別々: テストの合言葉では本番の担当になれない。本番の担当はテストと別に持てる
    const pWrong = await newPage({ width: 360, height: 640 });
    await pWrong.page.goto(`${base}/display.html?env=prod&dk=dk-test&speed=4`);
    await pWrong.page.waitForFunction(() => document.body.dataset.player === 'error', null, { timeout: 10000 });
    assert.match(await pWrong.page.textContent('#notice'), /合言葉/, '設定の誤りは画面に出す');
    const pOk = await newPage({ width: 360, height: 640 });
    await pOk.page.goto(`${base}/display.html?env=prod&dk=dk-prod&speed=4`);
    await pOk.page.waitForFunction(() => document.body.dataset.player === 'player', null, { timeout: 10000 });
    assert.equal(workerState('test').player.id !== workerState('prod').player.id, true);
    // 合言葉が URL に無ければ再生せず案内を出す
    const pNone = await newPage({ width: 360, height: 640 });
    await pNone.page.goto(`${base}/display.html?env=test&speed=4`);
    await pNone.page.waitForFunction(() => /合言葉/.test(document.getElementById('notice').textContent), null, { timeout: 10000 });
    for (const p of [a, b, pWrong, pOk, pNone]) assert.deepEqual(p.errors.filter((e) => !/Failed to load resource|ERR_FAILED/.test(e)), []);
    console.log('✔ 再生担当: 本番とテストの合言葉・担当・再生位置は別々');
    for (const p of [a, b, pWrong, pOk, pNone]) await p.page.close();
  }

  // Worker が長く止まると新しい再生を止め、復旧後に未再生分を順番どおり再生する
  {
    resetWorker();
    clientTiming = { ttlMs: 4000, heartbeatMs: 1000 };
    const c = await newPage({ width: 360, height: 640 });
    await c.page.goto(`${base}/display.html?env=test&dk=dk-test&speed=4`);
    await c.page.waitForFunction(() => document.body.dataset.player === 'player', null, { timeout: 10000 });
    const seenOrder = [];
    await c.page.exposeFunction('__rec', (t) => seenOrder.push(t));
    await c.page.evaluate(() => new MutationObserver(() => {
      const t = document.getElementById('ev-sender').textContent;
      if (t) window.__rec(t);
    }).observe(document.getElementById('ev-sender'), { childList: true, characterData: true, subtree: true }));
    workerDown = true;
    const names = ['停止1', '停止2', '停止3', '停止4'];
    const ks = [];
    for (const n of names) ks.push(await c.page.evaluate((it) => window.__fakeDb.push('envs/test/queue', it), item(n, 'gacha', ['釣り'])));
    // 期限(4秒)を過ぎても Worker に届かないので、途中で新しい再生を止めて待つ
    await c.page.waitForTimeout(12000);
    const during = seenOrder.filter((t, i) => t !== seenOrder[i - 1]);
    assert.ok(during.length < names.length, `障害中は途中で止まる: ${during}`);
    assert.equal(await c.page.evaluate(() => document.body.dataset.player), 'offline');
    assert.notEqual(workerState('test').lastPlayedKey, ks[3]);
    workerDown = false;
    await until(() => workerState('test').lastPlayedKey === ks[3], 40000, '復旧後に最後まで再生して保存');
    const all = seenOrder.filter((t, i) => t !== seenOrder[i - 1]);
    assert.deepEqual(all, names.map((n) => `${n} さん`), `復旧後も順番どおり・重複なし: ${all}`);
    assert.equal(await c.page.evaluate(() => document.body.dataset.player), 'player');
    clientTiming = null;
    await c.page.close();
    console.log(`✔ 再生担当: Worker 停止中は再生を止め、復旧後に未再生分を順番どおり再生(停止中に再生 ${during.length} 件)`);
  }

  // ---------- 表示画面: demo/debug で大きさの確認ができ、zoom で拡縮される ----------
  {
    const page = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.goto(`${base}/display.html?demo=1&speed=3`);
    await page.waitForSelector('.roulette canvas');
    await page.waitForTimeout(600);
    const info = await page.evaluate(() => ({
      zoom: document.getElementById('stage').style.zoom,
      canvas: document.querySelector('.roulette canvas').width,
      debug: document.getElementById('debug').textContent,
      rect: document.getElementById('stage').getBoundingClientRect().toJSON(),
    }));
    assert.equal(Number(info.zoom).toFixed(3), (360 / 1080).toFixed(3), 'zoom で縮小している');
    assert.equal(info.canvas, Math.round(780 * (360 / 1080) * 3), 'canvas は実際の画素数で描く');
    assert.ok(Math.abs(info.rect.width - 360) < 1 && Math.abs(info.rect.height - 640) < 1, `画面いっぱい: ${JSON.stringify(info.rect)}`);
    await page.screenshot({ path: join(shots, 'display-demo-phone.png') });
    await page.setViewportSize({ width: 960, height: 540 });
    await page.waitForTimeout(200);
    const landscape = await page.evaluate(() => document.getElementById('debug').textContent);
    assert.match(landscape, /横長/);
    assert.deepEqual(errors, []);
    console.log('✔ 表示画面: demo/debug 表示、zoom による拡縮、canvas の解像度');
    await page.close();
  }

  // ---------- 表示画面(従来デザイン): 初期表示は以前と同じ(上端300・100%・縮小なし・結果は横並び最大3件) ----------
  {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.goto(`${base}/display.html?demo=gacha&speed=4`);
    await page.waitForFunction(() => document.querySelectorAll('.event__results .chip').length >= 2, null, { timeout: 40000 });
    const info = await page.evaluate(() => {
      const ev = document.getElementById('event');
      const r = ev.getBoundingClientRect();
      return { top: Math.round(r.top), width: Math.round(r.width), zoom: ev.style.zoom, minH: document.getElementById('ev-results').style.minHeight,
        dir: getComputedStyle(document.getElementById('ev-results')).flexDirection };
    });
    assert.equal(info.top, 300, `上端 ${info.top}`);
    assert.equal(info.width, 1000, `幅 ${info.width}`);
    assert.ok(info.zoom === '1' || info.zoom === '', `倍率 ${info.zoom}`);
    assert.equal(info.minH, '', '結果欄の高さを確保しない(以前と同じ)');
    assert.equal(info.dir, 'row', '結果は横並び(以前と同じ)');
    assert.deepEqual(errors, []);
    // 次の項目に移ったら前の結果は消える
    await page.goto(`${base}/display.html?demo=1&speed=4`);
    const leftover = await page.waitForFunction(() => {
      if (!document.getElementById('ev-sender').textContent.includes('ためしユーザー')) return false;
      return { n: document.querySelectorAll('.event__results .chip').length };
    }, null, { timeout: 60000, polling: 'raf' }).then((h) => h.jsonValue());
    assert.equal(leftover.n, 0, '前の項目の結果が残っていない');
    console.log('✔ 表示画面(従来): 初期表示が以前と同じ・前の結果が残らない');
    await page.close();
  }

  // ---------- 表示画面(和風・台紙なし) ----------
  {
    const page = await browser.newPage({ viewport: { width: 540, height: 960 } });
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.goto(`${base}/display.html?demo=gacha&theme=wafu&panel=0&speed=4`);
    await page.waitForFunction(() => document.body.classList.contains('theme-wafu'), null, { timeout: 20000 });
    const bg = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('event'));
      return { image: cs.backgroundImage, color: cs.backgroundColor, border: cs.borderTopWidth };
    });
    assert.equal(bg.image, 'none');
    assert.equal(bg.color, 'rgba(0, 0, 0, 0)');
    assert.equal(bg.border, '0px');
    console.log('✔ 表示画面(和風): 台紙なしの設定');
    await page.close();
  }

  // ---------- 表示画面(和風): 宝珠の分割開封(7枚そろえば使う。1枚でも欠ければ従来の玉) ----------
  {
    const page = await browser.newPage({ viewport: { width: 540, height: 960 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.goto(`${base}/display.html?demo=gacha&theme=wafu&rarity=SSR&speed=2`);
    await page.waitForSelector('.wafu-orb', { timeout: 20000 });
    assert.equal(await page.locator('.wafu-orb > img').count(), 8, 'SSR は7枚の部品と金粉(きらめきをもう1枚)');
    assert.equal(await page.locator('.img-gacha__capsule').count(), 0, '従来の玉は出さない');
    // 開き切ったところで止めて、上蓋・光球・SSR の金色を確かめる
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.wafu-orb__sparkles')).opacity > 0.95, null, { timeout: 20000, polling: 20 });
    await page.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
    const o = await page.evaluate(() => {
      const rect = (k) => document.querySelector(`.wafu-orb__${k}`).getBoundingClientRect();
      const op = (sel) => Number(getComputedStyle(document.querySelector(sel)).opacity);
      return {
        lid: rect('lid'), base: rect('base'),
        core: op('.wafu-orb__core'), closed: op('.wafu-orb__closed'),
        gold: op('.wafu-orb__aura--open'), purple: op('.wafu-orb__aura--omen'),
        layers: [...document.querySelectorAll('.wafu-orb > img')].map((e) => e.className.split(' ')[0].replace('wafu-orb__', '')),
        clip: getComputedStyle(document.querySelector('.wafu-orb__base')).clipPath,
      };
    });
    assert.ok(o.lid.top < o.base.top - o.base.height * 0.3, `上蓋が下半球の上へ開いている: ${o.lid.top} / ${o.base.top}`);
    assert.ok(o.lid.left > o.base.left, '上蓋は右奥へ開く');
    assert.ok(o.core > 0.9 && o.closed < 0.05, `光球が見え、閉じた玉は消えている: ${o.core} / ${o.closed}`);
    assert.ok(o.gold > 0.9 && o.purple < 0.3, `SSR は紫から金へ: 金 ${o.gold} 紫 ${o.purple}`);
    assert.deepEqual(o.layers, ['closed', 'base', 'lid', 'core', 'energy', 'petals', 'sparkles', 'dust'], 'SSR は金粉まで全部');
    assert.equal(o.clip, 'inset(0px 0px 0px 7%)', '素材の切れ端の補正は theme.json から');
    assert.deepEqual(errors, []);
    await page.close();

    // N は白銀の光粒だけ(桜・光の輪は出さない)。開く前の紫の予兆も出さない
    const n = await browser.newPage({ viewport: { width: 540, height: 960 } });
    await n.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await n.goto(`${base}/display.html?demo=gacha&theme=wafu&rarity=N&speed=2`);
    await n.waitForSelector('.wafu-orb', { timeout: 20000 });
    const nLayers = await n.evaluate(() => [...document.querySelectorAll('.wafu-orb > img')].map((e) => e.className.split(' ')[0].replace('wafu-orb__', '')));
    assert.deepEqual(nLayers, ['closed', 'base', 'lid', 'core', 'sparkles'], `N の部品: ${nLayers}`);
    await n.waitForFunction(() => getComputedStyle(document.querySelector('.wafu-orb__sparkles')).opacity > 0.95, null, { timeout: 20000, polling: 20 });
    assert.ok(Number(await n.evaluate(() => getComputedStyle(document.querySelector('.wafu-orb__aura--omen')).opacity)) < 0.01, 'N は紫の予兆なし');
    // 札が出たあとの演出にも桜は出さない
    await n.waitForSelector('.fx', { timeout: 20000 });
    assert.equal(await n.locator('.fx__petal').count(), 0, 'N は桜なし');
    assert.equal(await n.evaluate(() => document.querySelector('.fx').dataset.rarity), 'N');
    await n.close();

    // 部品が1枚でも読めなければ、従来の玉の画像で演出する
    const fb = await browser.newPage({ viewport: { width: 540, height: 960 } });
    await fb.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await fb.route('**/orb-core.png', (r) => r.fulfill({ status: 404, body: '' }));
    await fb.goto(`${base}/display.html?demo=gacha&theme=wafu&rarity=SSR&speed=4`);
    await fb.waitForSelector('.img-gacha', { timeout: 20000 });
    assert.equal(await fb.locator('.wafu-orb').count(), 0, '欠けたら分割開封は使わない');
    assert.equal(await fb.locator('.img-gacha__capsule').count(), 2, '従来の玉(閉じた・開いた)');
    await fb.waitForSelector('.img-card.sheen', { timeout: 20000 });
    await fb.close();
    console.log('✔ 表示画面(和風): 宝珠の分割開封(上蓋・光球・SSR の昇格・N の控えめな光)と、部品が欠けたときの従来演出');
  }

  // ---------- 表示画面(和風テーマ): 画像・文字・透過、コメント欄よけ、候補が多いルーレット ----------
  {
    const page = await browser.newPage({ viewport: { width: 540, height: 960 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('requestfailed', (r) => { if (r.url().includes('/images/themes/')) errors.push(`読み込み失敗: ${r.url()}`); });
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.goto(`${base}/display.html?demo=1&theme=wafu&speed=4&safe=1300&g=150,100&r=150,100`);
    const waitOpaque = (sel) => page.waitForFunction((s) => { const el = document.querySelector(s); return el && getComputedStyle(el).opacity === '1'; }, sel, { timeout: 40000 });
    await waitOpaque('.roulette__result');
    // 札の窓・リングの穴の位置を画像から測れている
    const geo = await page.evaluate(() => ({
      win: getComputedStyle(document.documentElement).getPropertyValue('--card-win-left'),
      hole: getComputedStyle(document.documentElement).getPropertyValue('--ring-hole-d'),
    }));
    assert.match(geo.win, /%$/);
    assert.ok(Number(geo.hole) > 0.3 && Number(geo.hole) < 0.95, `リングの穴: ${geo.hole}`); // 素材によって変わるので、測れていることだけを確認
    await waitOpaque('.img-card');
    await page.waitForFunction(() => document.querySelectorAll('.event__results .chip').length >= 2, null, { timeout: 30000 });
    // 結果2件のときでも台紙の下端が safe(1300) を越えない(画面は 0.5 倍なので 650px)
    const bottom = await page.evaluate(() => document.getElementById('event').getBoundingClientRect().bottom);
    assert.ok(bottom <= 650 + 1, `台紙の下端 ${bottom}`);
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.img-card__label, .event__title, .event__sender')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className));
    assert.deepEqual(overflow, [], `はみ出し: ${overflow}`);
    const broken = await page.evaluate(() => [...document.querySelectorAll('img')].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src));
    assert.deepEqual(broken, [], `表示できない画像: ${broken}`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)', '背景が透明');
    // 候補12個のルーレットでは、針の下の候補名を大きく表示する
    await page.waitForFunction(() => document.getElementById('ev-sender').textContent.includes('たくさん候補'), null, { timeout: 60000 });
    await page.waitForFunction(() => { const t = document.querySelector('.roulette__ticker'); return t && !t.hidden && t.textContent; }, null, { timeout: 20000 });
    // 候補名は盤面の外(下)に出し、盤面に重ねない
    const tick = await page.evaluate(() => ({
      wheel: document.querySelector('.img-wheel').getBoundingClientRect().bottom,
      ticker: document.querySelector('.roulette__ticker').getBoundingClientRect().top,
    }));
    assert.ok(tick.ticker >= tick.wheel, `候補名が盤面に重なっている: ${JSON.stringify(tick)}`);
    // 止まった後は盤面を小さくして上に寄せ、結果枠は盤面の下側に少しだけ重ねる
    await waitOpaque('.roulette__result');
    // 盤面を CSS で回しても、針の下で止まる候補は抽選結果のまま
    const landed = await page.evaluate(() => ({
      landed: document.querySelector('.roulette').dataset.landed,
      result: document.querySelector('.img-result__text').textContent,
      spin: document.querySelector('.img-wheel canvas').style.transform,
    }));
    assert.equal(landed.landed, landed.result, `針の下の候補と結果: ${JSON.stringify(landed)}`);
    assert.equal(landed.spin, '', '止まったら CSS の回転を外して描き直す');
    await page.waitForTimeout(600);
    const stop = await page.evaluate(() => {
      const w = document.querySelector('.img-wheel').getBoundingClientRect();
      const r = document.querySelector('.roulette__result').getBoundingClientRect();
      return { overlap: (w.bottom - r.top) / w.height };
    });
    assert.ok(stop.overlap < 0.25, `結果枠が盤面を隠しすぎ: ${JSON.stringify(stop)}`);
    assert.deepEqual(errors, []);
    console.log('✔ 表示画面(和風): 画像・透過・コメント欄よけ・候補が多いルーレット(候補名は盤面の外、結果枠は盤面の下)');
    await page.close();
  }

  // ---------- 表示画面(和風・初期値): コメント欄よけ 1100 で縮めても結果の文字が小さくなりすぎない ----------
  {
    const page = await browser.newPage({ viewport: { width: 540, height: 960 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.goto(`${base}/display.html?demo=gacha&theme=wafu&speed=4`);
    await page.waitForFunction(() => document.querySelectorAll('.event__results .chip').length >= 2, null, { timeout: 40000 });
    const m = await page.evaluate(() => {
      const ev = document.getElementById('event');
      const zoom = parseFloat(ev.style.zoom || '1');
      const eff = (el) => parseFloat(getComputedStyle(el).fontSize) * zoom; // 1080×1920 の画面での見た目の大きさ
      const chips = [...document.querySelectorAll('.event__results .chip')];
      return {
        zoom,
        boost: parseFloat(ev.style.getPropertyValue('--text-boost')),
        bottom: ev.getBoundingClientRect().bottom,
        chipEff: Math.min(...chips.map(eff)),
        labelEff: eff(document.querySelector('.img-card__label')),
        overflow: [...document.querySelectorAll('.img-card__label')].filter((el) => el.scrollHeight > el.clientHeight + 1).length,
      };
    });
    assert.ok(m.bottom <= 550 + 1, `台紙の下端 ${m.bottom}(初期値 1100 = 画面 0.5 倍で 550px)`);
    assert.ok(m.zoom < 1 && m.boost > 1, `縮めたぶん結果の文字を大きくする: zoom ${m.zoom} boost ${m.boost}`);
    assert.ok(m.chipEff >= 36, `結果の一覧の見た目の大きさ ${m.chipEff.toFixed(1)}px`);
    assert.ok(m.labelEff >= 28 * m.zoom - 0.5, `札の文字 ${m.labelEff.toFixed(1)}px`);
    assert.equal(m.overflow, 0, '札の文字がはみ出していない');
    // レア度別の演出(SSR)は時間がたつと要素ごと消え、通常の表示に戻る
    await page.waitForFunction(() => !document.querySelector('.fx'), null, { timeout: 15000 });
    assert.deepEqual(errors, []);
    console.log(`✔ 表示画面(和風・初期値): コメント欄よけ 1100 で ${Math.round(m.zoom * 100)}%、結果の文字 ×${m.boost.toFixed(2)}`);
    await page.close();
  }

  // ---------- 管理画面: サンプル読み込み→保存で Worker に正しい形で送る ----------
  {
    const { page, errors } = await newPage({ width: 390, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem('tm.adminKey', 'admin-secret');
      localStorage.setItem('tm.displayKey.prod', 'dk-prod');
      localStorage.setItem('tm.displayKey.test', 'dk-test');
    });
    await page.goto(`${base}/admin.html?env=test`);
    page.on('dialog', (d) => d.accept());

    // 接続テスト: シークレット未設定を指摘できる
    await page.click('#conn-card summary');
    await page.fill('#conn-url', 'https://worker.test');
    await page.click('#conn-test');
    await page.waitForSelector('#conn-checks .check');
    const checks = await page.$$eval('#conn-checks .check', (els) => els.map((e) => e.textContent));
    assert.ok(checks.some((c) => c.includes('未設定: WEBHOOK_KEY')), `接続テスト: ${checks}`);
    assert.ok(checks.some((c) => c.includes('✓Worker から Firebase への接続')), `接続テスト: ${checks}`);
    await page.screenshot({ path: join(shots, 'admin-conn-test.png') });
    const bad = await page.evaluate(async () => {
      const { diagnose } = await import('./js/api.js');
      return (await diagnose('https://dash.cloudflare.com/abc', 'k')).map((r) => r.detail).join();
    });
    assert.match(bad, /workers\.dev/);
    console.log('✔ 管理画面: 接続テストで原因を表示できる');
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

    // 表示の調整: スライダーで変えた値が URL とプレビューに入る
    await page.click('#layout-card summary');
    await page.waitForSelector('#layout-editor select');
    await page.selectOption('#layout-editor select', 'wafu');
    const range = page.locator('#layout-editor fieldset').first().locator('input[type=range]').first();
    await range.evaluate((el) => { el.value = '300'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    const urls = await page.$$eval('#layout-editor code', (els) => els.map((e) => e.textContent));
    assert.ok(urls[0].includes('env=prod') && urls[0].includes('theme=wafu') && urls[0].includes('g=300%2C100'), `URL: ${urls[0]}`);
    // 画面では表示用の合言葉を伏せ、コピーする値には環境ごとの合言葉が入る
    assert.ok(urls.every((u) => u.includes('dk=●●●●●●') && !u.includes('dk-prod') && !u.includes('dk-test')), `画面では伏せる: ${urls}`);
    const values = await page.$$eval('#layout-editor code', (els) => els.map((e) => e.dataset.value));
    assert.ok(values[0].includes('dk=dk-prod') && values[1].includes('dk=dk-test'), '表示用の合言葉は環境ごと');
    assert.ok(!values.join().includes('admin-secret'), '管理用の合言葉は URL に入らない');
    const shown = await page.textContent('#url-display');
    const html = (await page.content()).replace(/data-value="[^"]*"/g, '');
    const at = html.indexOf('dk=dk-');
    assert.ok(!shown.includes('dk-test') && at < 0, `URL の案内も伏せる: ${at >= 0 ? html.slice(at - 200, at + 50) : ''}`);
    await page.waitForFunction(() => document.querySelector('#layout-editor iframe')?.src.includes('demo=gacha'), null, { timeout: 5000 });
    assert.ok((await page.textContent('#url-display')).includes('theme=wafu'), 'URL の案内にも反映');
    // 従来デザインに戻すと、従来の初期値のまま(和風で動かした値の影響を受けない)
    await page.selectOption('#layout-editor select', '');
    const classic = await page.$$eval('#layout-editor code', (els) => els[0].textContent);
    assert.ok(classic.includes('g=300%2C100') && classic.includes('safe=0') && !classic.includes('theme='), `従来: ${classic}`);
    // 和風に戻すと、和風で変えた値が残っている
    await page.selectOption('#layout-editor select', 'wafu');
    const wafuAgain = await page.$$eval('#layout-editor code', (els) => els[0].textContent);
    assert.ok(wafuAgain.includes('g=300%2C100') && wafuAgain.includes('theme=wafu') && wafuAgain.includes('safe=1100'), `和風: ${wafuAgain}`);
    await page.screenshot({ path: join(shots, 'admin-layout.png'), fullPage: true });
    console.log('✔ 管理画面: 表示の調整で URL を作れる');

    // 再生担当の表示と「再生担当を外す」
    resetWorker();
    wfb.set('envs/test/state/display', { lastPlayedKey: '-T0000000001', player: { id: 'scr-old', tokenHash: 'x', since: Date.now(), expiresAt: Date.now() + 30000, gen: 1 } });
    await page.evaluate((st) => window.__fakeDb.set('envs/test/state/display', st), wfb.get('envs/test/state/display'));
    await page.click('#player-card summary');
    await page.waitForFunction(() => document.getElementById('player-status').textContent.includes('担当あり'), null, { timeout: 5000 });
    let dialogText = '';
    page.once('dialog', (d) => { dialogText = d.message(); });
    await page.click('#player-release');
    await until(() => dialogText, 3000, '確認ダイアログ');
    assert.match(dialogText, /最大30秒/, '待機画面が無いと止まることを明示');
    await until(() => !workerState('test').player, 5000, '担当を外す');
    assert.equal(workerState('test').lastPlayedKey, '-T0000000001', '再生位置は残る');
    console.log('✔ 管理画面: 再生担当の表示と切り替え');
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

  // ---------- プレビューサイト: 本番を選べず、常にテスト環境 ----------
  {
    const { page, errors } = await newPage({ width: 390, height: 844 });
    await page.route('**/js/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: stubConfig.replace('IS_PREVIEW_SITE = false', 'IS_PREVIEW_SITE = true') }));
    await page.addInitScript(() => localStorage.setItem('tm.adminKey', 'admin-secret'));
    await page.goto(`${base}/admin.html?env=prod`);
    await page.waitForSelector('#env-switch a');
    const nav = await page.$$eval('#env-switch > *', (els) => els.map((e) => e.textContent));
    assert.deepEqual(nav, ['テスト', 'プレビュー(テスト専用)'], `切り替え: ${nav}`);
    assert.equal(await page.isHidden('#env-warning'), true, '?env=prod でも本番の警告は出ない(テストとして動く)');
    await page.goto(`${base}/test.html?env=prod`);
    await page.fill('#t-gift', 'Rose');
    const before = workerCalls.length;
    await page.click('#t-send');
    await page.waitForSelector('#t-result .log--queued');
    const sent = workerCalls.slice(before).find((c) => c.path === '/admin/test-gift');
    assert.equal(sent.search, '?env=test', 'プレビューサイトからは本番へ送らない');
    // テスト専用 Worker(ALLOWED_ENVS=test)なら、接続テストで本番への要求が拒否されることまで確かめる
    workerEnv.ALLOWED_ENVS = 'test';
    await page.goto(`${base}/admin.html`);
    await page.evaluate(() => { document.getElementById('conn-card').open = true; });
    await page.fill('#conn-url', 'https://worker.test');
    await page.click('#conn-test');
    await page.waitForFunction(() => document.querySelectorAll('#conn-checks .check').length > 3, null, { timeout: 10000 });
    const checks = await page.$$eval('#conn-checks .check', (els) => els.map((e) => e.textContent));
    assert.ok(checks.some((c) => c.startsWith('✓この Worker で使える環境') && c.includes('テストのみ')), `接続テスト: ${checks}`);
    assert.ok(checks.some((c) => c.startsWith('✓本番への要求の拒否')), `接続テスト: ${checks}`);
    delete workerEnv.ALLOWED_ENVS;
    // 本番への確認の要求が 403 で返るのは想定どおり(ブラウザがコンソールに出す)
    assert.deepEqual(errors.filter((e) => !e.includes('status of 403')), []);
    console.log('✔ プレビューサイト: ?env=prod でもテスト環境として動き、接続テストで本番の拒否を確認できる');
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
