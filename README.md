# TikFinity ミニゲーム(ガチャ・ルーレット)

TikTok LIVE のギフトに反応して、配信画面にガチャやルーレットを表示するミニゲームです。
抽選結果は「ハートピアでの行動・縛りチャレンジ」などの文言として表示します。
PC は不要で、iPhone / iPad のブラウザだけで設定・運用できるように作っています。

```
視聴者がギフトを送る
  → TikFinity(iPhone)が Webhook を送信
  → Cloudflare Worker が受信:重複チェック → 設定と照合 → 抽選(ここで1回だけ確定)
  → Firebase Realtime Database の「再生待ちキュー」に追加
  → 表示画面(PRISM LIVE)が届いた順に1件ずつ再生
```

## できること

- ギフトごとに「ガチャ」か「ルーレット」を割り当てる
- ギフトごとに 有効/無効・抽選テーブル・画面に出すタイトル・連続ギフト(コンボ)時の扱い を設定する
- 抽選テーブルごとに 候補・重み(当たりやすさ)・レア度 を設定する(確率は自動計算)
- 複数のギフトが続けて届いても、届いた順に最後まで1件ずつ再生する
- 表示画面を読み込み直しても、続きから再生する(二重再生・取りこぼしなし)
- 同じイベントが2回届いても1回分として扱う
- 本番用とテスト用のデータを完全に分ける(URL の `?env=prod` / `?env=test`)

## ページ一覧

| ページ | 役割 | 開く場所 |
|---|---|---|
| `display.html?env=prod` | 表示画面(背景透明・9:16) | PRISM LIVE |
| `admin.html` | 管理画面(ギフト・抽選テーブル・受信ログ) | iPhone / iPad の Safari |
| `test.html` | テスト画面(疑似ギフト送信・キュー確認・プレビュー) | iPhone / iPad の Safari |
| `index.html` | ページ一覧 | どこでも |

`?env=` を付けない場合はすべて **テスト** になります(本番を誤操作しないため)。

---

## セットアップ

所要時間の目安は 30〜60 分です。上から順に進めてください。

### 1. GitHub Pages を有効にする

1. このリポジトリの **Settings → Pages** を開く
2. **Source** を「Deploy from a branch」、**Branch** を `main` / `/(root)` にして保存
3. 数分後に `https://<ユーザー名>.github.io/tikfinity-minigame/` で開けるようになる

### 2. Firebase プロジェクトを作る(新規)

1. [Firebase コンソール](https://console.firebase.google.com/) で新しいプロジェクトを作成(Google アナリティクスは不要)
2. **構築 → Realtime Database → データベースを作成**
   - ロケーションはどこでも可。「ロックモードで開始」を選ぶ
   - 作成後に表示される URL(`https://〜.firebaseio.com` または `https://〜.firebasedatabase.app`)を控える
3. **ルール** タブを開き、このリポジトリの [`database.rules.json`](database.rules.json) の中身をすべて貼り付けて **公開**
4. **プロジェクトの設定(歯車)→ 全般 → マイアプリ → ウェブ(</>)** でアプリを登録
   - 表示される `firebaseConfig` の値を、GitHub 上で [`js/config.js`](js/config.js) を編集して貼り付ける
     (`apiKey` `authDomain` `databaseURL` `projectId` `appId` の5つ)
   - この値はブラウザに公開される前提のもので、秘密情報ではありません
5. **プロジェクトの設定 → サービスアカウント → 新しい秘密鍵を生成** で JSON ファイルをダウンロード
   - この中の `client_email` と `private_key` を次の手順で使います
   - **このファイルは誰にも見せず、GitHub にも置かないでください**(データベースを自由に書き換えられる鍵です)

### 3. Cloudflare Worker を作る

1. [Cloudflare](https://dash.cloudflare.com/) にログイン(無料プランで可)
2. **Workers & Pages → 作成 → Worker を作成**(名前は例: `tikfinity-minigame`)→ デプロイ
3. **コードを編集** を開き、中身をすべて消して [`worker/dist/worker.js`](worker/dist/worker.js) の中身を貼り付け → **デプロイ**
4. Worker の **設定 → 変数とシークレット** で、次をすべて「シークレット」として追加

   | 名前 | 値 |
   |---|---|
   | `FIREBASE_DB_URL` | 手順2-2で控えたデータベースの URL |
   | `SA_CLIENT_EMAIL` | 秘密鍵 JSON の `client_email` |
   | `SA_PRIVATE_KEY` | 秘密鍵 JSON の `private_key`(`-----BEGIN PRIVATE KEY-----` から `-----END PRIVATE KEY-----\n` まで全部) |
   | `WEBHOOK_KEY` | TikFinity の URL に付ける合言葉(長めのランダムな英数字) |
   | `ADMIN_KEY` | 管理画面・テスト画面用の合言葉(`WEBHOOK_KEY` とは別のもの) |
   | `ALLOWED_ORIGIN` | (任意)`https://<ユーザー名>.github.io` を入れると、他のサイトから管理APIを呼べなくなる |

5. Worker の URL(`https://tikfinity-minigame.〜.workers.dev`)をブラウザで開き、`{"ok":true,...}` と出れば OK

> コードを更新したときは、手順3-3 をやり直してください。

### 4. 管理画面で設定する(まずはテスト用)

1. `admin.html` を開く(上部が「テスト」になっていることを確認)
2. **接続設定** に Worker の URL と `ADMIN_KEY` を入れて保存(この端末のブラウザにだけ保存されます)
   - URL は `https://〜.workers.dev` まで(後ろに `/` 以降を付けない)
   - `js/config.js` の `DEFAULT_WORKER_URL` に書いておくと、URL の入力は省略できます
3. **接続テスト** を押し、すべて ✓ になることを確認(✗ の項目に原因と直し方が表示されます)
4. **サンプルを読み込む** → 内容を編集 → **保存**

### 5. テスト画面で確認する

1. `test.html` を開き、「表示画面のプレビュー」をオン
2. 「1件送信」「5人から連続で送信」「同じギフトを2回送信(重複テスト)」で動きを確認
3. 本物の表示画面で確認したい場合は、別の端末やタブで `display.html?env=test` を開く(右上に TEST と出ます)

### 6. TikFinity から Webhook を送る

1. TikFinity の **Actions & Events** で、Webhook を送るアクションを作る
2. 送信先 URL に次を設定(管理画面の「URL の案内」からコピーできます)
   ```
   https://<Worker の URL>/webhook?env=test&k=<WEBHOOK_KEY>
   ```
3. ギフトを受け取った時にそのアクションが実行されるよう、イベントを設定
4. 実際にギフトを送ってもらい(または TikFinity のテスト機能で)、管理画面の **受信ログ** を確認
   - どんな項目名(`giftName` など)で届いているか
   - ギフト名が何語で届いているか(管理画面のギフト名はこれと完全一致させる)
   - 連続ギフトのとき、Webhook が「途中で何回も」届くのか「最後に1回」なのか

> **要確認**:iPhone の TikFinity アプリで Webhook アクションが使えるかは、このリポジトリでは確認できていません。
> 受信ログに何も出ない場合は、TikFinity 側の設定・対応状況を確認してください。

Worker が理解できる項目名は次のとおりです(form 形式・JSON・URL のクエリのどれでも可)。
これ以外の名前で届く場合は [`shared/core.js`](shared/core.js) の `normalizeGift` に候補名を足します。

| 用途 | 受け付ける項目名 |
|---|---|
| ギフト名(必須) | `giftName` `gift_name` `giftname` |
| 個数 | `repeatCount` `repeat_count` `repeatcount`(無ければ1) |
| 送った人の表示名 | `nickname` `displayName` `username` `uniqueId` `userId` |
| 一意なID(重複判定) | `msgId` `msg_id` `messageId` `eventId` `event_id` |
| コンボ確定 | `repeatEnd`(`false` の時は途中経過として無視) |

### 7. PRISM LIVE に表示画面を追加する

1. まず見本で大きさを合わせる。PRISM LIVE で Web(ブラウザ)ソースを追加し、URL に次を設定
   ```
   https://<ユーザー名>.github.io/tikfinity-minigame/display.html?demo=1
   ```
   見本のガチャ・ルーレットが繰り返し再生され、左下に表示領域の大きさが出ます
2. Web ソースの **幅・高さを縦長の大きいサイズ(例 1080×1920)** にする
   - 左下に「⚠ 横長です」「⚠ 小さく描画されています」と出たら、幅・高さを見直す
   - 幅・高さが小さいと、小さく描いたものを引き伸ばすことになり、文字がぼやけます
3. 文字がはっきり見えるようになったら、URL を本番用に変える
   ```
   https://<ユーザー名>.github.io/tikfinity-minigame/display.html?env=prod
   ```
4. カードの縦位置は `&top=300` のように調整できます(1080×1920 基準の px)。背景は透明です

> **要確認**:iPad の PRISM LIVE「画面配信」モードで Web ソースを重ねられるかは未確認です。

### 8. 本番に切り替える

1. 管理画面(テスト)で **テスト → 本番にコピー**
2. TikFinity の Webhook URL の `env=test` を `env=prod` に変更
3. PRISM LIVE の表示画面が `?env=prod` になっていることを確認

---

## 設定項目の説明

### 連続ギフト(コンボ)のとき

| 設定 | 動き | 例(バラ×5) |
|---|---|---|
| 何個でも1回だけ抽選 | 個数に関係なく1回 | 1回 |
| 個数ぶん抽選 | 個数と同じ回数(上限あり) | 5回 |
| N個ごとに1回抽選 | 個数÷N 回(端数切り捨て、上限あり) | N=2 なら2回 |

複数回の場合、表示画面では「1 / 5 回目」のように1回ずつ再生し、結果を下に並べていきます。

### 全体設定

- **古い未再生イベントを飛ばす(分)**:表示画面を長く閉じていた後に開いた時、古いものまで再生しないようにする
- **重複とみなす間隔(秒)**:TikFinity が一意な ID を送ってこない場合の重複判定。同じ人・同じギフト・同じ個数がこの秒数以内に届いたら1回分として扱う

### 表示画面の URL オプション

| パラメータ | 意味 |
|---|---|
| `env=prod` | 本番のキューを再生(省略時はテスト) |
| `top=300` | カードの上端位置 |
| `skip=1` | 起動時に溜まっている未再生分を飛ばす |
| `speed=2` | 演出の速さ(確認用) |
| `demo=1` | 見本を繰り返し再生(Firebase に接続しない)。PRISM での大きさ合わせ用 |
| `debug=1` | 表示領域の大きさ・倍率を左下に表示 |
| `soft=2` | 視聴者側で文字がギザギザに崩れる時の対策(1〜5)。配信用に縮小される前にごく軽くぼかす |

---

## データの持ち方(Firebase Realtime Database)

```
/envs/{prod|test}/
  config/                  設定(管理画面から Worker 経由で保存)
    gifts/{ギフト名を変換したキー}  { giftName, enabled, mode, tableId, title, combo, comboN, maxRolls }
    tables/{tableId}       { title, items: [{ label, weight, rarity, color }] }
    settings               { staleMinutes, dedupeWindowSec }
  queue/{pushId}           再生待ち(Worker が抽選済みの結果を追加。最新300件を保持)
                           { giftName, sender, repeatCount, mode, title, rolls[], pool[], receivedAt, source }
  state/display            { lastPlayedKey, updatedAt }  表示画面がどこまで再生したか
  dedupe/{hash}            重複判定用の受信時刻(24時間で削除)
  log/{pushId}             受信ログ(最新100件を保持)
```

- 書き込みは原則 Worker(サービスアカウント)だけが行います。ブラウザから書けるのは `state/display` だけです
- `config` `queue` `state` `log` は誰でも読めます(表示画面がログインなしで読むため)。
  受信ログには視聴者の表示名などが含まれます

## トラブルシューティング

| 症状 | 確認すること |
|---|---|
| 表示画面の右下に「js/config.js に〜」 | `js/config.js` の Firebase 接続情報 |
| 表示画面の右下に「Firebase に接続できません」 | ネット接続、`databaseURL` |
| 管理画面で保存できない・「Worker から応答を受け取れませんでした」 | 管理画面の「接続設定」→「接続テスト」で原因を確認。よくある原因: Worker が Hello World のまま(コードの貼り付け・デプロイ忘れ)、URL の間違い、`ALLOWED_ORIGIN` の値違い、シークレットの未設定 |
| 受信ログに何も出ない | TikFinity の Webhook URL(`k=` の合言葉・`env=`)、Worker の URL |
| 受信ログに「未設定のギフト」 | 管理画面のギフト名と、ログに出ているギフト名が完全一致しているか(ログの「このギフトを設定に追加」ボタンが便利) |
| 受信ログに「重複のため無視」が多すぎる | 全体設定の「重複とみなす間隔」を短くする(0 で無効) |
| 連続ギフトで何回も再生される | 受信ログで `repeatEnd` が届いているか確認。届かず途中経過も送られてくる場合は「何個でも1回だけ」にする |
| 視聴者側だけ文字がギザギザに崩れる | 表示画面の URL に `&soft=2` を付ける(足りなければ 3)。PRISM の画面はきれいでも、配信用に縮小される時に細い線が崩れることがあります |
| 配信画面で文字がぼやける・小さい | `display.html?demo=1` を開いて左下の表示を確認し、Web ソースの幅・高さを縦長の大きいサイズ(例 1080×1920)にする |
| 再生が溜まりすぎた | テスト画面の「キュー・ログを消去」、または表示画面を `&skip=1` 付きで開く |

## 開発者向け

```sh
npm test                       # 単体テスト・Worker の結合テスト(偽の Firebase を使用)
npm run build                  # worker/dist/worker.js を生成(Worker のコードを変えたら必ず実行)
npm run check                  # worker/dist/worker.js が最新か確認(CI でも実行)
node tests/browser/smoke.mjs   # ブラウザでの動作確認(playwright が必要)
```

- `shared/core.js`:正規化・抽選・連続ギフト・重複判定・設定の検証(Worker とブラウザで共通)
- `worker/src/`:Worker 本体と Firebase REST クライアント
- `js/store.js`:ブラウザで Firebase を扱う唯一のファイル
- `js/api.js`:ブラウザから Worker を呼ぶ関数
- 外部ライブラリは Firebase の公式 SDK(CDN)のみで、ビルド工程はありません
