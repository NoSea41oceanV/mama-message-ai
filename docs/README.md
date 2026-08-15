# 資料一覧と正本

更新日: 2026-08-15

資料同士で説明が異なる場合は、次の順に新しい内容を正本として扱います。

1. ルートの [README](../README.md)
2. [実装変更一覧](IMPLEMENTATION_CHANGES.md)
3. [原価と売価試算](COST_MODEL.md)
4. `docs/submission/` の現行提出資料

`docs/hackathon-build/` と一部のチーム資料は、初期設計や当時の検証結果を残す履歴資料です。Qwen、D-ID、短い待機動画、3ルート分類などの記載は当時の事実であり、現在の主構成を示すものではありません。

## 現在の構成

- 入力: 子どもの音声。認識文を同席する大人が確認して送信
- 会話: OrcaRouter経由の`openai/gpt-5.6-luna`。`safetyLevel`、`supportMode`、`emotion`、返答文を構造化
- 音声: ElevenLabs Instant Voice Clone。8場面×3文を個別録音し、ブラウザ内で1つのWAVへ結合して1回登録
- 動画: Tavus Echoを主経路とし、生成済みクローン音声をリアルタイム映像へ渡す
- 代替: 静止画＋クローン音声、LiveAvatar、HeyGen。D-ID/Klingは後方互換の旧経路
- 安全: 危険・重大・判定不能時は外部音声・動画を呼ばず、その場にいる大人へ引き継ぐ
- 継続: 複数往復の会話と、6桁ペアリングコードによる離れた大人のチャット確認

既定起動はキー不要のデモモードです。外部サービスの「実装済み」と「現在の環境で接続済み」を混同せず、`GET /api/health`と実機デモで確認します。

## 現行資料

- [実装変更一覧](IMPLEMENTATION_CHANGES.md)
- [原価と売価試算](COST_MODEL.md)
- [Sites共有Faceデモの運用](SHARED_FACE_DEMO.md)
- [Git共有ガイド](team/GIT_SHARING_GUIDE.md)
- [現行要件レビューチェックリスト](team/REQUIREMENTS_REVIEW_CHECKLIST.md)
- [3分デモ台本](submission/DEMO_SCRIPT_3MIN.md)
- [最終レビューチェックリスト](submission/FINAL_REVIEW_CHECKLIST.md)
- [販売価格・ビジネスプラン](submission/BUSINESS_PLAN.md)
- [デモ動画情報](submission/video/README.md)

記事下書きは別PRで管理します。この資料更新では [記事下書き](submission/ARTICLE_DRAFT.md) を変更しません。

## 履歴資料

- [初期要件定義](hackathon-build/prd.md)
- [初期開発チェックリスト](hackathon-build/checklist.md)
- [開発記録](hackathon-build/build-notes.md)
- [初期チーム開発進行ガイド](team/TEAM_WORKFLOW.md)

履歴資料は過去の判断根拠を追跡するために保持します。現行仕様へ読み替える場合は、各ファイル冒頭の注記と上記の正本を参照してください。

## GitHubへ置かないもの

- APIキーを含む`.env`
- 保護者ごとの写真・音声・生成動画を保存する`.data/`
- PowerPoint、PDF、Wordなどの提出用バイナリ成果物
- 実在人物や子どもの写真・録音・会話本文
- 一時ファイル、ログ、ローカルキャッシュ
