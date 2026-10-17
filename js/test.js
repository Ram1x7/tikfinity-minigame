// ============================================================
// js/test.js  テスト画面
// ------------------------------------------------------------
// Worker の /admin/test-gift に疑似ギフトを送り、Webhook と同じ処理を通す。
// ============================================================
import { getEnv, envLabel, urlWithEnv, pageUrl } from './env.js';
import { isConfigured, watchConfig, watchRecentQueue, watchDisplayState } from './store.js';
import { sendTestGift, clearEnv } from './api.js';
import { h, toast, formatTime } from './dom.js';
import { loadSavedLayout } from './layout-editor.js';
import { layoutToParams } from './layout.js';

const env = getEnv();
const $ = (id) => document.getElementById(id);

// ---------------- ヘッダー ----------------
$('env-switch').replaceChildren(
  ...['test', 'prod'].map((e) => h('a', {
    href: urlWithEnv(e),
    class: `env-switch__item${e === env ? ' is-active' : ''} env-${e}`,
  }, envLabel(e)))
);
$('env-warning').hidden = env !== 'prod';
document.title = `テスト画面(${envLabel(env)})`;

// ---------------- 送信 ----------------
const STATUS_LABEL = { queued: '再生待ちに追加', duplicate: '重複のため無視', skipped: '処理せず' };
const uid = () => `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function showResult(label, res) {
  const line = h('div', { class: `log__item log--${res.status || 'error'}` },
    h('div', { class: 'log__head' },
      h('span', { class: 'log__time' }, formatTime(Date.now())),
      h('span', { class: 'tag' }, label),
      h('span', { class: 'log__status' }, STATUS_LABEL[res.status] || res.status || 'エラー'),
      res.reason || res.error ? h('span', { class: 'hint' }, res.reason || res.error) : null),
    res.rolls ? h('p', { class: 'log__rolls' }, `結果: ${res.rolls.join(' / ')}`) : null);
  const box = $('t-result');
  box.prepend(line);
  while (box.children.length > 20) box.lastChild.remove();
}

function formGift(overrides = {}) {
  const giftName = $('t-gift').value.trim();
  const nickname = $('t-name').value.trim() || 'テストさん';
  return {
    giftName,
    nickname,
    uniqueId: nickname,
    repeatCount: String(Math.max(1, Number($('t-count').value) || 1)),
    msgId: $('t-msgid').value.trim() || uid(),
    ...overrides,
  };
}

async function send(label, gift) {
  if (env === 'prod' && !confirm('本番に送信します。よろしいですか?')) return null;
  if (!gift.giftName) { toast('ギフト名を入力してください', true); return null; }
  try {
    const res = await sendTestGift(env, gift);
    showResult(label, res);
    return res;
  } catch (err) {
    showResult(label, { error: err.message });
    toast(err.message, true);
    return null;
  }
}

$('t-send').addEventListener('click', () => send('1件', formGift()));

$('t-burst').addEventListener('click', async () => {
  if (env === 'prod' && !confirm('本番に5件送信します。よろしいですか?')) return;
  const base = formGift();
  // ほぼ同時に5人から届いた状況を再現する(届いた順に再生されるかの確認)
  await Promise.all(['あおい', 'かえで', 'さくら', 'つばさ', 'ひなた'].map((name) =>
    sendTestGift(env, { ...base, nickname: name, uniqueId: name, msgId: uid() })
      .then((res) => showResult(`連続(${name})`, res))
      .catch((err) => showResult(`連続(${name})`, { error: err.message }))));
});

$('t-dup').addEventListener('click', async () => {
  const gift = formGift({ msgId: $('t-msgid').value.trim() || uid() });
  const first = await send('重複テスト1回目', gift);
  if (first) await send('重複テスト2回目', gift);
});

$('t-streak').addEventListener('click', () => send('コンボ途中', formGift({ repeatEnd: 'false' })));

$('t-clear').addEventListener('click', async () => {
  if (!confirm(`${envLabel(env)}の再生待ちキュー・受信ログ・重複記録・再生位置を消去します(設定は消えません)。よろしいですか?`)) return;
  try {
    await clearEnv(env);
    toast('消去しました');
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------- キューの様子 ----------------
let lastPlayedKey = '';
let recent = [];

function renderQueue() {
  const box = $('t-queue');
  if (recent.length === 0) {
    box.replaceChildren(h('p', { class: 'hint' }, 'キューは空です。'));
    return;
  }
  box.replaceChildren(...recent.map((q) => {
    const played = lastPlayedKey && q.key <= lastPlayedKey;
    const rolls = Array.isArray(q.rolls) ? q.rolls : Object.values(q.rolls || {});
    return h('div', { class: `log__item ${played ? 'is-played' : ''}` },
      h('div', { class: 'log__head' },
        h('span', { class: 'log__time' }, formatTime(q.receivedAt)),
        h('span', { class: 'tag' }, q.source === 'test' ? 'テスト' : 'Webhook'),
        h('span', { class: 'log__status' }, played ? '再生済み' : '未再生'),
        h('span', {}, `${q.sender} / ${q.giftName} ×${q.repeatCount} / ${q.mode === 'roulette' ? 'ルーレット' : 'ガチャ'}`)),
      h('p', { class: 'log__rolls' }, rolls.map((r) => `[${r.rarity}] ${r.label}`).join(' / ')));
  }));
}

// ---------------- プレビュー ----------------
$('t-preview').addEventListener('change', (e) => {
  const box = $('preview-box');
  box.hidden = !e.target.checked;
  box.replaceChildren(e.target.checked
    // 管理画面の「表示の調整」で決めたデザイン・位置で表示する
    ? h('iframe', { src: pageUrl('display.html', { env, preview: '1', ...layoutToParams(loadSavedLayout()) }), title: '表示画面のプレビュー' })
    : '');
});

// ---------------- 起動 ----------------
if (!isConfigured()) {
  toast('js/config.js に Firebase の接続情報を設定してください', true);
} else {
  watchConfig(env, (config) => {
    const names = Object.values(config.gifts).map((g) => g.giftName);
    $('gift-names').replaceChildren(...names.map((n) => h('option', { value: n })));
    if (!$('t-gift').value && names[0]) $('t-gift').value = names[0];
  });
  watchRecentQueue(env, 15, (list) => { recent = list; renderQueue(); });
  watchDisplayState(env, (s) => { lastPlayedKey = s.lastPlayedKey || ''; renderQueue(); });
}
