# Gitメンバー共有ガイド

## 1. 共有するもの

このリポジトリでは、アプリ本体、テスト、デモ用素材、設計・提出資料を共有します。

- `public/`: ブラウザ画面
- `server.mjs`: HTTPサーバーとAPI
- `lib/`: 会話、サンプリング、動画生成などの実装
- `test/`: 自動テスト
- `scripts/`: デモ素材・資料生成用スクリプト
- `docs/`: 要件、構成、レビュー、提出準備資料

次のデータは共有しません。

- `.env`: APIキーなどの秘密情報
- `.data/`: 登録した保護者の写真、音声、生成動画
- `tmp/`、ログ、ローカルキャッシュ
- D-ID、OrcaRouterなど外部サービスの認証情報

## 2. 初回セットアップ

必要環境はNode.js 20以上です。外部npmパッケージは現在使用していません。

```powershell
git clone <共有されたGitリポジトリURL>
Set-Location "AI HACK 2026"
Copy-Item .env.example .env
npm test
npm start
```

キーなしでもデモモードで起動できます。ブラウザで `http://127.0.0.1:4173/` を開いてください。

実サービスへ接続する担当者だけが、自分の `.env` にキーを設定します。キーの値はチャットやGitへ貼り付けません。

## 3. 推奨ブランチ運用

`main` はデモ可能な状態を保ちます。通常の変更は作業ブランチで行い、レビュー後に `main` へ取り込みます。

```powershell
git switch main
git pull --rebase origin main
git switch -c feature/<短い作業名>
```

Codexが作業ブランチを作る場合は `codex/<短い作業名>` を使用します。

変更後は次を実行します。

```powershell
npm test
git status --short
git diff --check
git add <確認済みのファイル>
git commit -m "feat: 変更内容"
git push -u origin HEAD
```

`git add .` は `.gitignore` で大半を防げますが、提出物や大きな生成ファイルを誤って含めないよう、原則としてファイルを確認して指定します。

## 4. 3人チームでの担当

- 主担当: 実装、動作確認、デモ統合、最終マージ
- レビュー担当1: 子ども向け画面、文言、会話の自然さ、安全時の表示
- レビュー担当2: API連携、設定、テスト結果、要件・発表内容との整合

レビュー担当はコードを細部まで書き直すより、動作と要件の差分を短く具体的に報告します。

## 5. レビュー依頼時に共有する情報

Pull Requestまたはメッセージには、最低限次を含めます。

1. 何を変更したか
2. どの画面・操作を確認してほしいか
3. `npm test` の結果
4. APIキーなしで確認できるか
5. 未実装、既知の制約、外部サービス利用料金の有無

## 6. 共有開始時の管理者操作

GitHubなどで空の非公開リポジトリを作成した後、主担当PCで一度だけ実行します。

```powershell
git remote add origin <GitリポジトリURL>
git push -u origin main
```

すでに `origin` がある場合は追加せず、`git remote -v` でURLを確認してください。メンバー2名をリポジトリへ招待し、直接 `main` を編集せずPull Requestで確認する運用を推奨します。

## 7. 共有前チェック

- `.env` が `git status` に出ていない
- `.data/`、録音、登録写真、API応答ログが含まれていない
- `npm test` が成功する
- `git diff --check` でエラーがない
- デモ画面がキーなしでも起動できる
- 実サービス接続時の制限と費用をREADMEまたはPull Requestへ明記している
- 動画・画像・Office資料が大きすぎる場合はGitではなく共有ストレージを使う
