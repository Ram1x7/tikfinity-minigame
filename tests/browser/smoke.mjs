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
    const replies = {
      '/': { ok: true, service: 'tikfinity-minigame', version: 'test', secrets: { FIREBASE_DB_URL: true, SA_CLIENT_EMAIL: true, SA_PRIVATE_KEY: true, WEBHOOK_KEY: false, ADMIN_KEY: true }, allowedOrigins: [] },
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
    assert.deepEqual(errors, []);
    console.log(`✔ 表示画面(和風・初期値): コメント欄よけ 1100 で ${Math.round(m.zoom * 100)}%、結果の文字 ×${m.boost.toFixed(2)}`);
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
