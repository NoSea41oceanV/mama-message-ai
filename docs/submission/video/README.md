# 説明・提出動画

更新日: 2026-08-15

このディレクトリの既存動画と生成スクリプトは、2026-08-14時点の旧構成を説明する履歴成果物です。旧動画には30秒〜2分の録音、待機動画＋別音声、D-ID経路などが含まれるため、現在の最終提出動画としてそのまま使いません。

## 現行動画で見せる内容

- 3〜6歳の子どもと、保育士・シッター・親族・同席家族など信頼できる大人
- 「写真→声→話し方→確認」の初回登録
- 8場面×3文を1文ずつ録音し、ブラウザ内で結合してElevenLabs IVCへ1回送る流れ
- OrcaRouterによる`safetyLevel`、`supportMode`、`emotion`、返答文の構造化
- ElevenLabs本人声とTavus Echoを使った通常返答、または明示したフォールバック
- 同じ画面での通常会話2往復
- 6桁ペアリングと、離れた大人のチャット確認・音声再生
- 危険発話を赤く表示し、同席大人へ引き継ぐ安全経路
- 安全経路で外部音声・動画APIを呼ばないこと

台本は[3分デモ台本](../DEMO_SCRIPT_3MIN.md)を正本とします。

## 旧説明動画

- ファイル: `AI_HACK_2026_ohenji_current_explainer.webm`
- 作成日: 2026-08-14
- 尺: 約99秒
- 形式: WebM / VP8 / 1280×720 / Opus

再生成手順も旧構成の再現用です。

1. `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/generate-current-explainer-narration.ps1`
2. `node scripts/build-current-explainer-video.mjs`
3. `node scripts/validate-current-explainer-video.mjs`

## 取り扱い

動画ファイルは原則Git管理対象外です。人間による最終確認後、YouTubeなどの提出先へアップロードします。動画には`.env`、APIキー、`.data`、保護者の実写真・元音声、実在の子どもの会話を含めません。
