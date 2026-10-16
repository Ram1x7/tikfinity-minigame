// ============================================================
// Firebase の接続情報
// ------------------------------------------------------------
// Firebase コンソール → プロジェクトの設定 → マイアプリ(ウェブアプリ) に表示される
// firebaseConfig の値をここに貼り付けてください。
// この値はブラウザに公開される前提のもので、パスワードではありません。
// データの保護はセキュリティルール(database.rules.json)で行います。
// ============================================================
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  databaseURL: '',
  projectId: '',
  appId: '',
};

// Cloudflare Worker の URL(例: https://tikfinity-minigame.xxxx.workers.dev)
// ここに書いておくと、管理画面・テスト画面で毎回入力しなくて済みます。
// 管理画面の「接続設定」で端末ごとに上書きもできます。
export const DEFAULT_WORKER_URL = '';
