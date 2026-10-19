# 第2段階・宝珠分割開封（作業ブランチ専用）

このブランチは `wafu-preview` から分岐した開発用です。まだ `wafu-preview` / `main` にマージしないでください。

## 実装状況
- `theme.json` に `orbParts`（closed/lid/base/core/energy/petals/sparkles）を追加。
- `js/theme.js` で7枚を読み込み、**全て正常に読み込めた場合だけ** `theme.orbParts` を有効化。
- `js/play-gacha-image.js` に上蓋・下半球・光球・エフェクトの分割アニメーションを追加。
- `theme.css` に和風限定の位置合わせとSSR昇格色を追加。
- 画像がない場合は従来の capsule 2枚による演出に戻る。

## 画像の追加（未完了）
このコミットにはPNGをまだ含めていません。素材ZIP内の次の7枚を
`images/themes/wafu/` に同名で置いてください。

```
orb-closed.png
orb-open-lid.png
orb-open-base.png
orb-core.png
orb-energy.png
orb-petals.png
orb-sparkles.png
```

**注意:** 上蓋と下半球は閉じた宝珠と完全には一致しません。拡大や変形でごまかさず、まず実画面で確認してください。

## テスト（必須）
1. PNGがない場合に従来演出へフォールバックすること。
2. 7枚揃えた場合に上蓋が開き、光球と光の演出が出ること。
3. N/R/SR/SSRの表示、SSRの紫→金への変化。
4. 長い名前・景品名・結果カード、9:16表示、安全領域。
5. 連続イベント・自動消去・Classicの表示が従来どおり。
6. 既存の `npm run check`、自動テスト、ブラウザテスト。
7. PRISM LIVE実機で透過・熱・負荷を確認。

## 変更禁止
本番のFirebase/Worker/Webhook、抽選確率、キュー、認証、`main`、既存PRのマージ。
