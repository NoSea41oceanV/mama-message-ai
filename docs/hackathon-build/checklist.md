# AI HACK 2026 Build Checklist

Mode: Codex実行・人間レビュー型  
Verification: Codexの自動確認 + 人間の10〜15分レビュー  
Git cadence: 15〜30分単位のコミット  
Deadline: 2026-08-15 15:00 JST

- [ ] **1. Gitと共有基盤を準備する（Codex）**
  Spec ref: `prd.md > 10. 3人の担当と完了条件`
  What to build: GitHubリポジトリ、`feature/core-mvp` と2つの `support/*` ブランチ、README、秘密情報を除外する設定を用意する。
  Acceptance: 3人がリポジトリを取得でき、APIキーを含めずに作業を開始できる。
  Verify: 各担当が自分のブランチから小さなテストコミットを作れることを確認する。

- [x] **2. 共通レスポンス契約を固定する（Codex）**
  Spec ref: `prd.md > 6. 機能要件`
  What to build: 3分類、即時返信、動画メッセージ、安全メッセージ、リクエストログのデータ形式を定義する。
  Acceptance: フロントエンドがモックレスポンスだけで3分岐を表示できる。
  Verify: 3種類のJSONサンプルを読み込み、想定画面へ遷移する。

- [x] **3. 子ども向け成功シナリオをモックで通す（Codex）**
  Spec ref: `prd.md > 5. 基本ユーザージャーニー`
  What to build: 入力、即時返信、動画生成中、固定動画再生を一本につなぐ。
  Acceptance: 「ブロックでおうちを作ったよ」の入力から動画再生まで止まらない。
  Verify: ブラウザ上で最初から最後まで手動実行する。

- [x] **4. OrcaRouterで構造化判定を実装する（Codex）**
  Spec ref: `prd.md > Epic 2`
  What to build: `safetyLevel`、`supportMode`、`emotion`、`reasonCodes`、返答文をstructured outputsで受け取り、通常メディアまたは安全引き継ぎへ分岐する。
  Acceptance: JSON Schema違反・タイムアウト・判定不能を通常返信へ流さず、`ADULT_HANDOFF`へ倒す。
  Verify: fetch注入テストで正常応答、JSON不正、タイムアウトを確認した。2026-08-14に公式API認証HTTP 200と、アプリ経路の `READY` / `generate_guardian_message` / `normal` / `encourage` / LEVEL 3を確認した。10秒timeoutでfail-closedした後、25秒へ調整した。

- [x] **5. リクエストログを残す（Codex）**
  Spec ref: `prd.md > 9.2 コスト要件`
  What to build: モデル、原価、レイテンシ、ルート、ステータスを表示または保存する。
  Acceptance: 代表リクエストでモデル、レイテンシ、トークン、ステータス、fallback levelを確認でき、APIキーと発話本文を記録しない。未取得の費用は未計測と明記する。
  Verify: 2回のライブ実行で `qwen/qwen3.7-plus`、約20.5秒/21.5秒、prompt tokens 58、completion tokens 1073/1113を確認した。`costUsd` / `providerRoute` は `null` のため、費用は未計測とする。

- [x] **6. メディア生成境界とフォールバックを実装する（Codex）**
  Spec ref: `prd.md > Epic 4`
  What to build: LEVEL 1生成動画、LEVEL 2事前動画、LEVEL 3静止画+音声+字幕、LEVEL 4中立案内の境界を実装する。
  Acceptance: 生成動画プロバイダー未接続でもLEVEL 3、意図的な失敗ではLEVEL 4でデモを完走できる。
  Verify: ブラウザと自動テストでLEVEL 1〜4の段階縮退を確認する。

- [x] **7. 安全シナリオを実装する（Codex）**
  Spec ref: `prd.md > Epic 6`
  What to build: 深刻な発言を動画生成から除外し、大人への相談案内と保護者確認ログへ切り替える。
  Acceptance: `safety_escalation` で母親風の動画・断定的助言を返さない。
  Verify: 安全テスト入力を実行し、動画生成リクエストが発生しないことを確認する。

- [x] **8. 資料・記事・提出原稿を作る（Codex）**
  Spec ref: `prd.md > 10. 3人の担当と完了条件`
  What to build: テスト入力、固定素材、要件・進行PowerPoint、記事下書き、動画台本、提出確認表を用意する。
  Acceptance: 人間が10〜15分で内容をレビューできる完成度になっている。
  Verify: Codexが成果物と判断事項を一覧で提示し、人間が承認・修正点・保留を返す。

- [x] **9. 統合・回帰確認を行う（Codex）**
  Spec ref: `prd.md > 2.2 提出時の成功条件`
  What to build: 3ブランチを統合し、成功・安全・API失敗の3ケースを確認する。
  Acceptance: `main` で3ケースが再現し、APIキーや個人情報が含まれない。
  Verify: 起動手順どおりに別環境で起動し、3ケースを手動確認する。外部送信は `ROUTER_PROVIDER=orcarouter` の場合だけ有効になることも確認する。

- [ ] **10. 3分デモ動画を完成させる（Codex、人間レビュー）**
  Spec ref: `prd.md > 11.1 3分デモ動画の構成`
  What to build: 課題、成功デモ、OrcaRouter、コストログ、安全対応を3分以内に収録する。
  Acceptance: YouTube限定公開URLをログアウト状態でも再生できる。
  Verify: 動画尺とURLを別端末またはシークレットウィンドウで確認する。

- [ ] **11. 記事・README・フォーム提出を完了する（Codex準備、人間承認）**
  Spec ref: `prd.md > 15. 提出物チェックリスト`
  What to build: README、Qiita/Zenn記事、公開ソースURL、Googleフォームを完成させる。
  Acceptance: 記事に「AI HACK 2026」「OrcaRouter」、コスト、安全設計が含まれ、14:30までにフォーム送信済みである。
  Verify: 3つのURLとフォーム送信完了画面をチーム全員で確認する。
