// ============================================================
// Firebase の接続情報・Worker の URL
// ------------------------------------------------------------
// Firebase コンソール → プロジェクトの設定 → マイアプリ(ウェブアプリ) に表示される
// firebaseConfig の値をここに貼り付けてください。
// この値はブラウザに公開される前提のもので、パスワードではありません。
// データの保護はセキュリティルール(database.rules.json)で行います。
//
// 本番のサイト(PRODUCTION_HOSTS)で開いたときは PRODUCTION を、
// それ以外の場所(Cloudflare Pages のプレビューサイトなど)で開いたときは PREVIEW を使う。
// PREVIEW にはテスト専用の Firebase プロジェクトの値を入れる。未設定のあいだは
// プレビューサイトはどの Firebase にもつながらない(本番のデータに触れないように)。
// ============================================================

// 本番として扱うサイトのホスト名(GitHub Pages)
const PRODUCTION_HOSTS = ['ram1x7.github.io'];

const PRODUCTION = {
  firebaseConfig: {
    apiKey: 'AIzaSyBCReilo2NqkLL06f7XHGTNLa54p9QIZ70',
    authDomain: 'tikfinity-minigame.firebaseapp.com',
    databaseURL: 'https://tikfinity-minigame-default-rtdb.firebaseio.com',
    projectId: 'tikfinity-minigame',
    appId: '1:860894209998:web:fa4f55ac9a132bfd8fed9f',
  },
  // Cloudflare Worker の URL(例: https://tikfinity-minigame.xxxx.workers.dev)
  // ここに書いておくと、管理画面・テスト画面で毎回入力しなくて済みます(管理画面の「接続設定」で端末ごとに上書きも可)
  workerUrl: '',
};

// テスト専用(プレビュー)。テスト専用 Firebase プロジェクトとテスト専用 Worker の値を入れる
const PREVIEW = {
  // テスト専用 Firebase プロジェクト tikfinity-minigame-test
  firebaseConfig: {
    apiKey: 'AIzaSyBHz3eeRo0KHSIS-gTrfqweu8MWQSdgCXY',
    authDomain: 'tikfinity-minigame-test.firebaseapp.com',
    databaseURL: 'https://tikfinity-minigame-test-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'tikfinity-minigame-test',
    appId: '1:659941206860:web:152b140922a8dead58fde9',
  },
  workerUrl: '',        // 例: 'https://tikfinity-minigame-preview.xxxx.workers.dev'
};

/** 本番以外の場所(プレビューサイト・手元の確認用サーバー)で開いているか */
export const IS_PREVIEW_SITE = typeof location === 'undefined' || !PRODUCTION_HOSTS.includes(location.hostname);

const site = IS_PREVIEW_SITE ? PREVIEW : PRODUCTION;
export const firebaseConfig = site.firebaseConfig || {};
export const DEFAULT_WORKER_URL = site.workerUrl || '';
