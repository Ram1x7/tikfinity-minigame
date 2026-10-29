# 管理画面からBGMファイルをアップロードする

この機能は **Cloudflare R2** に音声ファイルを保存します。GitHub Pagesは静的サイトなので、管理画面だけでGitHubにファイルを書き込むことはできません。管理画面の管理用合言葉でWorkerへアップロードし、WorkerがR2へ保存します。

## 初回のみ：Cloudflare側の設定

1. Cloudflare Dashboard → R2 Object Storage で新しいバケットを作成（例: `tikfinity-bgm`）。
2. Workers & Pages → 配信用の既存Worker → Settings → Bindings → Add binding → R2 bucket。
3. Variable name を **`BGM_BUCKET`**、R2 bucketを手順1で作ったバケットにして保存。
4. GitHubの `worker/dist/worker.js` の最新版をWorkerに貼り付けて **Deploy**。Workerの環境変数や既存の秘密鍵は変更不要。
5. 管理画面を再読み込みする。

※ R2の利用にはCloudflareアカウントの課金設定が必要な場合があります。料金・無料枠はCloudflare側で確認してください。

## 毎回の操作

1. 本番管理画面 `admin.html?env=prod` → 抽選テーブル → 対象の候補 → 「縛りタイマーを使用」。
2. 「MP3などをアップロード」で配信利用が許可された音源を選ぶ（MP3/M4A/OGG/WAV、**10MB以下**）。
3. アップロードが完了すると「実行中BGMのURL」にWorker上の公開URLが自動で設定される。
4. 音量を設定し、画面下の「保存」を押す。
5. PRISMのブラウザソースを再読み込みし、疑似ギフトで動作を確認する。

## 注意

- 音源のURLを知っている人はファイルを再生できます。非公開音源はアップロードしないでください。
- ファイルはR2に保存され、管理画面のURL変更や候補削除だけではR2上の音声ファイルは削除されません。不要なファイルはCloudflare R2のバケットから削除してください。
- PRISM/iPadでは音声自動再生が制限されることがあります。MP3方式でも自動再生は保証できません。
- YouTubeのURLは従来どおり公式の動画プレーヤーで表示します。動画を非表示にした音声のみのYouTube再生には対応しません。
