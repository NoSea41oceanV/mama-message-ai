# 3分デモ動画

ローカル生成済みの提出レビュー候補:

- `AI_HACK_2026_3min_demo_review.webm`
- 尺: 2分49.98秒
- 映像: VP8 / 1280x720 / 16:9
- 音声: Opus / 48kHz / stereo / Microsoft Haruka日本語音声
- ファイルサイズ: 約14MB

内容は、対象ユーザー、音声入力、認識文確認、通常LEVEL 3、OrcaRouterの役割、匿名技術ログ、LEVEL 1〜4、生成失敗LEVEL 4、安全`ADULT_HANDOFF`、AIと人間の分担の10場面です。

検証:

- ブラウザで再生開始できることを確認
- 3秒、65秒、125秒、145秒の映像フレームを直接デコードして目視
- 映像・音声トラックと170.012秒の尺メタデータを確認
- YouTubeアップロードと限定公開URL確認は、人間の最終承認後に実施

再生成する場合:

1. `scripts/demo-video-scenes.json`を確認する
2. `powershell -ExecutionPolicy Bypass -File scripts/generate-demo-narration.ps1`でHaruka音声を生成する
3. `node scripts/render-demo-video.mjs`を起動する
4. `http://127.0.0.1:4180`でレンダリングする
5. WebMをリマックスして尺メタデータを付与する

動画・音声・中間フレームはGit管理対象外です。最終動画はYouTube限定公開URLで共有します。
