# 説明・提出動画

## 現状説明動画（2026-08-14）

- ファイル: `AI_HACK_2026_ohenji_current_explainer.webm`
- 尺: 約99秒
- 映像: WebM / VP8 / 1280x720 / 16:9
- 音声: Opus / Microsoft Haruka 日本語ナレーション
- サイズ: 約7.8MB

説明内容:

- ベビーシッター同席家庭向けMVP
- 音声入力、動画・動的音声・字幕、複数往復
- OrcaRouterによる返答・感情・安全判定
- アプリ内30秒〜2分録音からElevenLabs IVCをAPI作成
- Voice IDのプロフィール別暗号化保存と設定画面プレビュー
- OpenAI Custom Voice経路の温存と音声キャッシュ
- 危険・不確実・同意無効時の音声・D-ID呼び出し0回
- 現行mainは待機動画＋別音声であり、完全口同期は未達

生成方法:

1. `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/generate-current-explainer-narration.ps1`
2. `node scripts/build-current-explainer-video.mjs`
3. `node scripts/validate-current-explainer-video.mjs`

台本・画面構成は`scripts/current-explainer-scenes.json`、描画は`scripts/current-explainer-renderer.html`で管理します。検証スクリプトは1280x720の代表フレームを`current-explainer-review/`へ出力します。

## 取り扱い

`docs/submission/video/`の生成物はGit管理対象外です。動画をGitHubへ直接追加せず、人間による最終確認後にYouTubeなどの提出先へアップロードしてください。動画には`.env`、APIキー、`.data`、保護者写真・録音を含めません。
