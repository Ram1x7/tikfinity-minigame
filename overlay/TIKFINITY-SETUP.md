# TikFinity イベント別Webhook設定（本番反映前の手順）

既存のギフト用Eventと `/webhook` は**変更しない**。下記は新しい `/overlay/webhook` 専用。

## 事前条件
1. GitHub Actions の CI / Overlay checks が両方成功。
2. 新しい Worker を Cloudflare に反映し、既存のギフト処理が動くことを確認。
3. Firebase Realtime Database の `database.rules.json` の差分を確認して適用。**既存ルールを無条件で丸ごと上書きしない**。
4. オーバーレイ画面をPRISMで読み込み、Firebase接続状態を確認。

## TikFinity Action のURL
現在のギフト用URLの**ドメインと認証キー**は流用するが、送信先パスを変更する。

| Event | URLの末尾の指定 |
| --- | --- |
| Follow | `/overlay/webhook?env=prod&k=<秘密の鍵>&type=follow` |
| Likesを送る（タップ） | `/overlay/webhook?env=prod&k=<秘密の鍵>&type=like` |
| チャット（どんなコメントでも） | `/overlay/webhook?env=prod&k=<秘密の鍵>&type=comment` |
| Join | `/overlay/webhook?env=prod&k=<秘密の鍵>&type=attendance` |

- `<秘密の鍵>` は既存の `WEBHOOK_KEY` と同じ値。公開しない。
- `env=test` で確認する場合はPRISM側の `env=test` と合わせる。
- URLの `type` はTikFinityのEventごとに固定。送信本文に `type` があってもURL側を優先する。
- TikFinityからのWebhookはPOSTが必要。実際の送信形式・受信成功は実機で確認する。
- Likeは「タップ」イベントのため高頻度になり得る。大量受信時の費用・動作は未検証。
- Joinを出席扱いにすると再入室のたびに加算される。1人1日1回の厳密な出席ではない。
- 表示画面は匿名イベントのみ受信。表示名・コメント本文は新規イベント履歴には保存しない。

## 本番確認
1. 既存のギフトイベントが引き続きガチャ・ルーレットを動かす。
2. Followイベントを一つ有効化し、通知を確認。
3. Like、Comment、Joinを**一つずつ**有効化して確認。
4. 動作に問題があれば追加したEventだけ無効化。既存ギフトEventは変更しない。

## 未解決
- TikFinityの実ペイロードとEvent ID形式は未検証。
- 同じIDがない場合、Webhook再送の重複排除はできない。
- いいね数・出席数はブラウザ内の簡易集計であり、端末間の厳密な共有値ではない。
