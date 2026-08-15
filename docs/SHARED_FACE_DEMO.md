# Sites共有Faceデモの運用

更新日: 2026-08-15

## 目的

一般公開中のSitesデモで、Training済みのTavus Faceを別端末から再利用します。ログイン機能を実装する前のデモ専用構成です。

## 共有するもの

- Sites環境に設定済みのTraining済みTavus Face
- Faceを使ったリアルタイム動画生成機能

## 共有しないもの

- Face登録者がElevenLabsへ登録したクローン音声と`voice_id`
- Face登録者の元音声と音声試聴URL
- Face登録者の子どもの呼び方、好きなもの、会話履歴
- APIキー、設定変更権限、素材削除権限

別端末でクローン音声を使う場合、その端末の利用者が自分の写真と声を登録し、本人同意を完了する必要があります。Tavusへ送る音声は、その端末のプロフィールに保存された`voice_id`で生成したものだけです。

音声未登録の端末では、Face登録者のクローン音声へ代替しません。表示中の返答文を端末のブラウザ音声で読み上げ、Tavusリアルタイム動画は開始しません。

## 有効化と停止

Sitesの本番環境変数`DEMO_SHARED_TAVUS_FACE_ENABLED=true`で有効化します。`false`または変数削除で停止します。

共有Faceは、次の順で解決します。

1. SitesのD1に保存された最新のTraining済みFace
2. `TAVUS_FACE_IS_CUSTOM=true`として設定済みの`TAVUS_FACE_ID`

共有先はFaceの作り直しや削除を実行できません。

## 公開デモの制約

- URLを知っている人が共有Faceを利用できます。
- ElevenLabsとTavusの利用枠を消費します。
- Tavus Starterでは同時接続は1件です。
- 正式提供では、保護者アカウント、端末追加、権限失効、利用記録を実装します。

## 確認項目

- 新規端末の`voiceCloningAvailable`が`false`であること
- 新規端末へ元音声・音声試聴URLが返らないこと
- 音声未登録時の`audioUrl`が`null`であること
- 音声未登録時にTavus会話を開始できないこと
- 音声登録済み端末では、その端末の`voice_id`だけで音声生成すること
- 共有Faceの設定変更・削除ボタンが無効であること
