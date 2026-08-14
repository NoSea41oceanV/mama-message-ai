# 提出デモ動画

現在の提出候補:

- `AI_HACK_2026_3min_demo_live_v2.webm`
- 尺: 約2分27秒
- 映像: VP8 / 1280x720 / 16:9
- 音声: Opus / 48kHz / stereo / Microsoft Haruka日本語音声
- ファイルサイズ: 約20MB

## 内容

- ベビーシッター同席時に、子どもと離れた保護者をつなぐ利用場面
- 保護者同意、見守る大人、AIは補助という利用原則
- 実際に動くアプリ画面による通常会話2往復
- 危険発話で保護者動画を出さず、シッターへ引き継ぐ安全ルート
- 現在の実画面と、D-IDで会話ごとに口同期する次期構成の区別
- 家庭・ベビーシッター向けMVP、価格案、保育園への展開案

旧版の`AI_HACK_2026_3min_demo_review.webm`は内容が古いため、提出には使用しません。

## 検証

- 実アプリを1280x720で録画
- 冒頭、原則、ライブデモ、次期構成、事業案、締めの代表フレームを目視
- 146秒地点の映像をデコードでき、148秒地点に映像がないことを確認
- VP8映像トラックとOpus音声トラックを確認

## 再生成

1. `scripts/updated-demo-scenes.json`で構成とナレーションを確認する
2. `powershell -ExecutionPolicy Bypass -File scripts/generate-updated-demo-narration.ps1`で音声を生成する
3. `node scripts/record-live-app-demo.mjs`で最新の実画面を録画する
4. `node scripts/build-updated-demo-video.mjs`で最終動画を合成する

YouTubeへのアップロードと公開範囲の設定は、人間の最終確認後に行います。
