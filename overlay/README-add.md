# 統合表示ページ

`overlay/combined.html?env=prod` は、既存の `display.html` と `overlay/display.html` を1つのPRISMブラウザソースに重ねます。

- 既存ガチャ・ルーレットの処理は変更しません。
- `overlayDemo=1` : 追加オーバーレイだけをデモ表示。
- `gameDemo=gacha` または `gameDemo=roulette` : 既存ゲームだけをデモ表示。
- `overlayOpacity=0.6` : オーバーレイの不透明度を調整（0〜1）。
- 従来の `demo` パラメータは誤起動防止のため統合ページでは無視します。
- 既存の表示キー `dk` と Worker URL `w` は、元のゲームiframeへ渡します。ブラウザの履歴や共有URLに秘密の値が残らないよう注意してください。
- iframeを使うため、PRISMでの音声・描画・重なりは実機確認が必要です。
- オーバーレイのギフト通知とガチャ演出は同じキューをそれぞれ読み取ります。ガチャの再生位置には影響しません。
