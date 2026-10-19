# テスト専用環境(プレビュー)の作り方

本番(GitHub Pages・本番の Worker・本番の Firebase)には一切触れずに、
`wafu-preview` ブランチを実機(iPad の PRISM LIVE・iPhone の TikFinity)で試すための手順です。
1つの見出しが1つの画面です。上から順に進めてください。

> **合言葉・秘密鍵は、GitHub・チャット・スクリーンショットに載せないでください。**
> パスワード管理アプリ(iCloud キーチェーンなど)に保存して使います。
> Firebase の「ウェブアプリの設定(firebaseConfig)」は公開前提の値なので、`js/config.js` に書いて構いません。

## 全体の形

| | 本番(変更しない) | テスト専用(これから作る) |
|---|---|---|
| Web ページ | GitHub Pages(main) | Cloudflare Pages(`wafu-preview` ブランチ) |
| Worker | 今の Worker | 新しい Worker `tikfinity-minigame-preview`(`ALLOWED_ENVS=test`) |
| Firebase | `tikfinity-minigame` | 新しいプロジェクト `tikfinity-minigame-test`(おすすめ) |

本番を守る仕組み:

- テスト専用の Worker は `ALLOWED_ENVS=test` で、`env=prod` や環境の指定が無い要求を Webhook・管理・表示のすべてで拒否します
- プレビューサイトのページは、`?env=prod` を付けて開いても常にテスト環境として動きます(本番を選ぶボタンも出ません)
- プレビューサイトは `js/config.js` の `PREVIEW` の Firebase にだけつながります。未設定のあいだはどこにもつながりません

## Firebase: 本番と同じプロジェクトか、テスト専用プロジェクトか

| | 本番と同じプロジェクト(`envs/test`) | テスト専用プロジェクト(おすすめ) |
|---|---|---|
| 本番データへの影響 | 間違えると本番に触れる可能性(サービスアカウントの鍵は本番も書ける) | 物理的に別。触れようがない |
| 新しいルールの確認 | 本番の表示画面に影響するため、ルールを変えて確かめられない | 新しいルールを公開して、実際の動き(ETag 付きの書き込みなど)まで確かめられる |
| 鍵の管理 | 本番と同じプロジェクトの鍵を増やす | テスト用の鍵だけ。終わったらプロジェクトごと消せる |
| 手間 | 少ない | プロジェクト作成・ウェブアプリ登録など +15分ほど |
| ページの設定 | 不要 | `js/config.js` の `PREVIEW` に firebaseConfig を入れる(1回だけ) |

→ **テスト専用プロジェクトを使う手順**で書いています。

---

## A. 合言葉を3つ作る(パスワード管理アプリ)

パスワード管理アプリの「パスワードを生成」で、**英数字20文字以上**のものを3つ作り、名前を付けて保存します。

| 名前 | 使う場所 |
|---|---|
| `PREVIEW WEBHOOK_KEY` | TikFinity のテスト用 Webhook の URL |
| `PREVIEW ADMIN_KEY` | プレビューサイトの管理画面・テスト画面 |
| `DISPLAY_KEY_TEST` | プレビューの表示画面(PRISM に設定する URL) |

**本番の合言葉とは別の値にしてください。**

---

## B. テスト専用 Firebase プロジェクト

### B-1. プロジェクトを作る
1. https://console.firebase.google.com/ を開く
2. **プロジェクトを追加**(英語表示なら *Add project*)
3. 名前: `tikfinity-minigame-test` → 続行
4. Google アナリティクス: **オフ** → プロジェクトを作成

### B-2. Realtime Database を作る
1. 左のメニュー **構築 → Realtime Database** → **データベースを作成**
2. ロケーション: どれでも可(日本から近いのは `asia-southeast1`(シンガポール))
3. **ロックモードで開始** → 有効にする
4. 画面上部に出る URL を控える(例 `https://tikfinity-minigame-test-default-rtdb.asia-southeast1.firebasedatabase.app`)
   → 後で Worker の `FIREBASE_DB_URL` に使う

### B-3. ルールを公開する(テスト専用プロジェクトなので本番には影響しません)
1. Realtime Database の **ルール** タブ
2. 中身をすべて消し、GitHub の `wafu-preview` ブランチの [`database.rules.json`](../database.rules.json) を貼り付け
   (Raw で開いてコピー: https://raw.githubusercontent.com/Ram1x7/tikfinity-minigame/wafu-preview/database.rules.json )
3. **公開**

### B-4. ウェブアプリを登録する
1. 左上の歯車 → **プロジェクトの設定 → 全般**
2. 下の **マイアプリ** で **</>(ウェブ)**
3. アプリのニックネーム: `preview` → 登録(Firebase Hosting は設定しない)
4. 表示される `firebaseConfig` の5つの値(`apiKey` `authDomain` `databaseURL` `projectId` `appId`)を控える
   → `js/config.js` の `PREVIEW.firebaseConfig` に入れる(公開前提の値。Claude に渡して入れてもらって構いません)

### B-5. サービスアカウントの秘密鍵(Worker 用)
1. 歯車 → **プロジェクトの設定 → サービス アカウント**
2. **新しい秘密鍵を生成** → 鍵を生成(JSON がダウンロードされる)
3. この JSON は**誰にも渡さず、GitHub にも置かない**。中の `client_email` と `private_key` を Worker に入れる

### B-6. 初期データ
作業は不要です。後の手順 E-4 で、管理画面の「サンプルを読み込む → 保存」で `envs/test/config` ができます。

---

## C. テスト専用 Worker(Cloudflare)

### C-1. Worker を作る
1. https://dash.cloudflare.com/ → 左メニュー **Workers & Pages**
2. **作成**(*Create*)→ **Worker を作成**(*Create Worker*)
3. 名前: `tikfinity-minigame-preview` → **デプロイ**

### C-2. コードを貼り付ける
1. 作った Worker の **コードを編集**(*Edit code*)
2. 中身をすべて消す
3. https://raw.githubusercontent.com/Ram1x7/tikfinity-minigame/wafu-preview/worker/dist/worker.js を開き、**最後まで**すべてコピーして貼り付け
4. **デプロイ**

### C-3. 変数とシークレット
Worker の **設定 → 変数とシークレット**(*Settings → Variables and Secrets*)→ **追加**

| 名前 | 種類 | 値 |
|---|---|---|
| `ALLOWED_ENVS` | テキスト | `test` |
| `FIREBASE_DB_URL` | シークレット | B-2 で控えた URL |
| `SA_CLIENT_EMAIL` | シークレット | B-5 の JSON の `client_email` |
| `SA_PRIVATE_KEY` | シークレット | B-5 の JSON の `private_key`(`-----BEGIN PRIVATE KEY-----` から `-----END PRIVATE KEY-----` まで全部) |
| `WEBHOOK_KEY` | シークレット | A の `PREVIEW WEBHOOK_KEY` |
| `ADMIN_KEY` | シークレット | A の `PREVIEW ADMIN_KEY` |
| `DISPLAY_KEY_TEST` | シークレット | A の `DISPLAY_KEY_TEST` |
| `ALLOWED_ORIGIN` | テキスト | D-3 で決まるプレビューサイトの URL(D の後で追加) |

`DISPLAY_KEY_PROD` は**入れません**。保存後 **デプロイ**。

### C-4. 動いているか確認
Worker の URL(`https://tikfinity-minigame-preview.<あなたのサブドメイン>.workers.dev`)をブラウザで開き、次が出れば OK:
`"version":"1.4.0"` と `"allowedEnvs":["test"]`

---

## D. プレビューサイト(Cloudflare Pages)

### D-1. GitHub とつなぐ
1. Cloudflare の **Workers & Pages → 作成 → Pages** タブ → **Git に接続**(*Connect to Git*)
2. GitHub のアカウントを選び、権限の画面で **Only select repositories → `Ram1x7/tikfinity-minigame`** だけを選んで許可

### D-2. ビルドの設定
| 項目 | 値 |
|---|---|
| プロジェクト名 | 例 `tikfinity-preview`(URL の一部になります) |
| 本番ブランチ(*Production branch*) | `wafu-preview` |
| フレームワーク プリセット | なし(*None*) |
| ビルド コマンド | (空欄) |
| ビルド出力ディレクトリ | `/` |

**保存してデプロイ**。

### D-3. URL を控える
完了すると `https://tikfinity-preview.pages.dev` のような URL が出ます。
- C-3 の `ALLOWED_ORIGIN` にこの URL を入れて Worker を再デプロイ
- `wafu-preview` ブランチに push するたびに自動で更新されます(GitHub Pages の本番サイトは変わりません)

### D-4. ページの設定を入れる(Claude が行う)
B-4 の firebaseConfig と C-4 の Worker の URL を `js/config.js` の `PREVIEW` に入れて `wafu-preview` に push します。
数分で D-3 のサイトに反映されます。

---

## E. 実機接続テスト(①〜⑧)

| # | やること | 合格の目安 |
|---|---|---|
| ① | `https://tikfinity-preview.pages.dev/admin.html` を開く | 上部に「テスト」「プレビュー(テスト専用)」。本番は選べない |
| ② | Firebase との接続 | 「Firebase に接続できません」が出ない |
| ③ | **接続設定**: Worker の URL(D-4 で入れていれば空欄可)・`PREVIEW ADMIN_KEY`・**表示用の合言葉・テスト**(`DISPLAY_KEY_TEST`)→ 保存 → **接続テスト** | すべて ✓。バージョン 1.4.0、「この Worker で使える環境: テストのみ」。未設定は `DISPLAY_KEY_PROD` だけ |
| ④ | **サンプルを読み込む → 保存**。`test.html` で「1件送信」 | 「再生待ちに追加」 |
| ⑤ | 管理画面の **URL の案内** の表示画面の URL を **コピー** し、別のタブで開く | ガチャ・ルーレットが再生される。管理画面の「表示画面の再生担当」が「担当あり」。テスト画面で「再生済み」 |
| ⑥ | iPad の PRISM LIVE に Web ソースとして ⑤ の URL を登録(下の「PRISM LIVE の確認項目」) | 配信画面に透過で重なる |
| ⑦ | iPhone の TikFinity で Webhook のアクションを**新しく**作る: `https://tikfinity-minigame-preview.<サブドメイン>.workers.dev/webhook?env=test&k=<PREVIEW WEBHOOK_KEY>` | 管理画面の **受信ログ** に出る。**本番用のアクションは変更しない** |
| ⑧ | テスト用の配信でギフトを受け取る(TikFinity にテスト機能があればそれでも可) | 受信 → 抽選 → PRISM で演出 → 演出が終わって透明に戻る → テスト画面で「再生済み」 |

あわせて確認すること:

- PRISM で Web ソースを再読み込み → 待たずに再生が続く
- 管理画面の「再生担当を外す」→ 確認ダイアログ → 別のタブ(待機中)が引き継ぐ
- Worker が `env=prod` を拒否する: `…/webhook?env=prod&k=…` に送ると受信ログに出ない(403)

## F. PRISM LIVE(iPad)の確認項目

| 確認すること | 確認方法・合格の目安 | だめだった場合 |
|---|---|---|
| 今の配信方式で Web ソースを追加できるか | 配信の設定画面のソース(素材)の追加に「Web」「ブラウザ」などがあるか | 方式によっては追加できない場合があります。どの方式なら追加できるかを確認 |
| 画面配信(ゲーム画面をそのまま配信)で重なるか | 画面配信中に Web ソースが配信映像に映るか(視聴者側の画面で確認) | 画面配信では iPad の画面そのものを送るため、アプリ内の重ね合わせが映らない可能性があります。その場合は別の方式を検討 |
| 大きさ | Web ソースの幅・高さを 1080×1920 にできるか。URL に `&debug=1` を付けると左下に表示領域と倍率が出る | 小さいと文字がぼやける。指定できる最大の縦長サイズにする |
| 透過 | ゲーム画面の上で背景が透明になっているか | 透けない場合は PRISM の設定(背景色・透過)を確認 |
| 重ね順 | ゲーム画面より上にあるか | ソースの並び順を入れ替える |
| 再読み込み | Web ソースの再読み込み(更新)後、待たずに再生が続くか(管理画面で「担当あり」のまま) | 最大40秒ほど待つことがある(README「制限事項」) |
| 背景で動き続けるか | PRISM を前面にしたまま・ゲームに切り替えたとき、ギフトが届いたら演出が出るか | iPad が PRISM を止めている可能性。管理画面の「表示画面の再生担当」で応答が途切れていないか確認 |
| 視聴者側の見え方 | 別の端末で配信を見て、文字・光が読めるか | URL に `&soft=2` を付ける |
| 長時間 | 30分ほど流して、発熱・電池・重さに問題が無いか | 演出を控えめにする(theme.json の effects) |

## G. 片付け(テストが終わったら)

1. Cloudflare: Pages の `tikfinity-preview` と Worker `tikfinity-minigame-preview` を削除
2. Firebase: プロジェクト `tikfinity-minigame-test` を削除(または B-5 の鍵だけ削除)
3. TikFinity: テスト用の Webhook アクションを削除
4. パスワード管理アプリの3つの合言葉を削除
