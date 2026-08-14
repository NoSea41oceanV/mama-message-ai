# AI HACK 2026 - AIビデオメッセージ

家庭・保育・一時預かりの場で大人同席のもと利用する3〜6歳の未就学児へ、保護者が許可した声・写真などをもとに、「その場にいない保護者からのAIビデオメッセージ」を届けるハッカソンプロジェクトです。母親専用のプロダクトではなく、`Mama Movie` は主デモ上の例です。

## MVPの体験

子どもの主入力は音声です。大きなマイクボタンをタップして録音を始め、もう一度タップして止めます。録音中は波形、経過時間、「きいているよ」を表示し、停止後は音声認識したテキストを確認して「おくる」または「もういちど」を選べます。マイクの許可がない場合や認識に失敗した場合は、子ども向けの短い文言で再試行を案内します。文章入力は主導線にせず、デモを止めないためのフォールバックとしてのみ残します。

送信後は「おへんじをとどける準備をしているよ」と表示し、返答メディアと字幕がそろってから1つの返答として再生します。現在のアプリはOrcaRouterで`safetyLevel`、`supportMode`、`emotion`と返答文を構造化し、通常返答・保護者アバター返答・安全引き継ぎを監督します。Tavusモードでは、ElevenLabsのクローン音声をEchoセッションへ送り、口の動き・表情・自然な身振りを含む映像をリアルタイム再生します。判定不能時は通常返信へ流さず同席大人へ引き継ぎます。

主デモは、母親が仕事中に父親と過ごしている子どもが、嬉しかったことや寂しい気持ちを声で伝える場面です。その場にいる父親・母親・祖父母などが必要に応じて操作を助け、子どもに寄り添います。「駄々をこねる子を黙らせる」用途ではなく、その場の大人が寄り添う際の気持ちの切り替えを補助します。

利用場面には、ワンオペ中の父親との留守番、ベビーシッターや祖父母の預かり、保育園の延長保育で迎えを待つ時間、就寝前、出張・単身赴任、誕生日・発表会、一時的な入院・別居を想定しています。保育者・シッター・同席家族が操作を補助し、子どもだけで自由利用する設計にはしません。危険・深刻な相談では動画を生成せず、その場にいる信頼できる大人への相談を案内します。

## チーム共通資料

- [資料一覧](docs/README.md)
- [要件定義](docs/hackathon-build/prd.md)
- [開発チェックリスト](docs/hackathon-build/checklist.md)
- [3人チーム開発進行ガイド](docs/team/TEAM_WORKFLOW.md)
- [実装変更一覧](docs/IMPLEMENTATION_CHANGES.md)

## 提出期限

2026年8月15日 15:00 JST

14:30までのGoogleフォーム送信完了をチーム内締切とします。

## 開発体制

開発実装、テスト、資料・記事作成、提出準備はCodexが担当します。人間3人はレビューと意思決定を担当し、レビュー負担は主レビュアー約70%、他2人各約15%を目安とします。

GitHub公開、YouTube公開、Qiita/Zenn公開、Googleフォーム最終送信は、人間の承認後に行います。

## Git運用

- `main`: 統合済みでデモ可能な状態だけを置く
- `feature/core-mvp`: 主担当がコア実装・統合を進める
- `review/ux-safety`: 必要に応じて体験・安全レビューを記録する
- `review/submission`: 必要に応じて記事・提出レビューを記録する

実装と統合はCodexが行い、`main`への反映は人間レビュー後に行います。

APIキーや保護者素材はコミットしません。実値は各自の `.env` で管理し、必要な変数名だけ `.env.example` に記載します。

## 現在の実装

Node.jsアプリとして、次のMUST経路を実装しています。

- 本人同意済みデモ素材のサーバー検証
- 大人向け画面での保護者写真・最大2分（1〜2分推奨）の音声サンプル登録、ElevenLabs Instant Voice Clone、顔・声ごとの明示同意、プレビュー、プロフィール別の永続保存・削除
- Tavus Echoで、返答ごとのElevenLabs音声・表情・身振り・口の動きを同期するリアルタイム映像
- Tavusへの明示同意、非公開Daily通話の短時間トークン、APIによる本人Face作成、音声フォールバック
- 代替経路としてLiveAvatar LITEのリアルタイム映像
- 旧経路として、登録写真からHeyGen Photo AvatarまたはD-ID/Kling動画を非同期準備するプロバイダー境界
- 生成済みMP4・動的読み上げ・字幕を同時再生するLEVEL 1返答と、未生成時のLEVEL 3写真フォールバック
- 大人向け画面からの素材利用停止・再開と、停止中の生成遮断
- 音声録音、15秒自動停止、文字起こしAPI、同席大人による認識文確認
- `POST /api/transcriptions`、`POST /api/responses`、`GET /api/responses/{requestId}`
- `GET /api/health`によるプロバイダーモード確認（秘密値は返さない）
- `POST /api/sampling/video`、`GET /api/sampling/video/{jobId}`によるプロバイダー非依存の非同期動画生成
- 安全度・支援方法・感情の構造化判定と、判定不能を含む安全側への引き継ぎ
- `requestId`と冪等キーによる二重生成防止
- `conversationId`ごとの直近6往復・30分TTLの会話継続
- 返答準備中の安心できる待機表示
- 音声を埋め込んだ事前生成WebM動画・字幕をそろえたLEVEL 2再生
- 生成メディアを用意できない場合の、保護者らしさを外したLEVEL 4中立案内
- 安全時の保護者顔・保護者風音声・通常返信の停止
- 24時間TTL、会話本文を含まない匿名技術ログ
- OrcaRouter structured outputs、OpenAI互換STT、HeyGen/D-ID/Kling Video、LEVEL 1〜4メディアのプロバイダー境界
- 通常・生成失敗・安全・同意不備・冪等性・ログ秘匿を含む自動テスト
- CSP、Permissions Policy、入力長制限、危険・誤認表現の返答拒否

既定起動はキー不要のデモモードです。`VOICE_CLONING_PROVIDER=elevenlabs`を設定した実接続では、大人向け画面から保護者の写真と最大2分（1〜2分推奨）の音声を登録すると、ElevenLabs Instant Voice Cloneの`voice_id`を作成します。Tavusモードの会話時は、OrcaRouterの返答文をElevenLabsの日本語TTSへ送り、24kHz・16-bit・mono PCMへ変換してTavus Echoへ渡します。Tavusに接続できない場合は、登録写真とクローン音声を使うLEVEL 3へ戻ります。

写真、元音声、生成MP4、ElevenLabsの`voice_id`はブラウザが保持するランダムな保護者プロフィールIDごとに分離し、サーバー専用の `.data` へAES-256-GCMで暗号化保存します。APIキーと`voice_id`はブラウザへ返しません。同じブラウザではサーバー再起動後も自動復元され、別プロフィールからは参照できません。素材の再登録・削除・同意停止では生成動画を含む暗号化データと素材URLを失効させ、削除時はElevenLabs上のクローン削除も試みます。TavusのAPIキーもサーバーだけが保持し、ブラウザへ返すのは同意確認後に発行した非公開通話の短時間トークンだけです。

提出準備物:

- [記事下書き](docs/submission/ARTICLE_DRAFT.md)
- [3分デモ台本](docs/submission/DEMO_SCRIPT_3MIN.md)
- [生成済み3分デモ動画の情報](docs/submission/video/README.md)
- [最終レビューチェックリスト](docs/submission/FINAL_REVIEW_CHECKLIST.md)

## 起動

Node.js 20以降で実行します。

```powershell
npm start
```

ブラウザで `http://127.0.0.1:4173` を開きます。マイク権限を使わずに確認する場合は、画面の「デモ音声で進める」を選択します。

実接続する場合は`.env.example`を参考に、Git管理対象外の`.env`へサーバー専用キーを設定します。会話判定は`ROUTER_PROVIDER=orcarouter`、リアルタイム映像は`VIDEO_GENERATION_PROVIDER=tavus`、実STTは必要に応じて`STT_PROVIDER=openai`を指定してください。動画処理は大人向け画面で外部送信同意を確認した場合だけ開始されます。`VIDEO_GENERATION_PROVIDER=disabled`へ戻すとキーが残っていても写真・返信音声を動画サービスへ送信しません。

### ElevenLabs音声クローンの設定

```dotenv
VOICE_CLONING_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=YOUR_SERVER_SIDE_API_KEY
ELEVENLABS_BASE_URL=https://api.elevenlabs.io/v1
ELEVENLABS_MODEL=eleven_multilingual_v2
ELEVENLABS_STABILITY=0.45
ELEVENLABS_SIMILARITY_BOOST=0.85
ELEVENLABS_STYLE=0.2
ELEVENLABS_SPEAKER_BOOST=true
```

保護者素材画面で1〜2分、普段その子に話すときの速さ・抑揚・間で自然に読み上げ、外部送信を含む声の利用同意を確認して登録します。登録完了後に「音声クローン済み」と表示されれば、次の通常返答からクローン音声が使われます。TTS時は録音の話し方を残しやすい既定値として、安定性`0.45`、類似度`0.85`、スタイル`0.2`、話者ブースト有効を使います。APIキーはサーバーだけが参照し、ブラウザやAPIレスポンスへ返しません。

### Tavusの設定

```dotenv
VIDEO_GENERATION_PROVIDER=tavus
TAVUS_API_KEY=YOUR_SERVER_SIDE_API_KEY
TAVUS_BASE_URL=https://tavusapi.com
TAVUS_PAL_ID=YOUR_ECHO_PAL_ID
TAVUS_FACE_ID=YOUR_FALLBACK_FACE_ID
TAVUS_PUBLIC_BASE_URL=https://YOUR_PUBLIC_APP_ORIGIN
TAVUS_MAX_CALL_DURATION_SECONDS=300
```

Tavus Echoはアプリ側のOrcaRouter・ElevenLabsをそのまま使い、Tavusには生成済み音声を渡して顔をリアルタイム描画させます。通話は`require_auth`を有効にした2人限定の非公開Dailyルームで、既定では最長5分です。本人Faceは大人向け画面で明示同意した場合だけ作成し、Tavusが登録写真を取得する短時間URLは30分で失効します。`TAVUS_PUBLIC_BASE_URL`にはTavusから到達可能な公開HTTPSオリジンが必要なため、ローカルだけでは公開テストFaceでの接続確認になります。

### LiveAvatarの設定（代替経路）

```dotenv
VIDEO_GENERATION_PROVIDER=liveavatar
LIVEAVATAR_API_KEY=YOUR_SERVER_SIDE_API_KEY
LIVEAVATAR_BASE_URL=https://api.liveavatar.com
LIVEAVATAR_SANDBOX=true
LIVEAVATAR_AVATAR_ID=
LIVEAVATAR_MAX_SESSION_DURATION_SECONDS=60
```

`LIVEAVATAR_SANDBOX=true`ではクレジットを消費しない公開Wayneアバターで接続を確認できます。本人のLiveAvatarはAPIから自動作成できません。[LiveAvatar管理画面](https://app.liveavatar.com/)で本人同意のもと、通常約2分の連続した本人動画を収録して作成します。完成後にアバターIDを`LIVEAVATAR_AVATAR_ID`へ設定し、`LIVEAVATAR_SANDBOX=false`へ変更してください。身振りの種類と自然さは作成時の本人動画から学習されるため、普段子どもへ話すときの表情・姿勢・手の動きを含めて収録します。

サンドボックスは約1分で終了するため、アプリは残り時間が短いセッションを次の返答前に自動更新します。同じ返答画面から続けて話しても会話履歴は維持されます。接続失敗時は静止画とElevenLabs音声へ戻り、写真を傾ける擬似動画は表示しません。

### HeyGen Avatar IVの設定

```dotenv
VIDEO_GENERATION_PROVIDER=heygen
HEYGEN_API_KEY=YOUR_SERVER_SIDE_API_KEY
HEYGEN_BASE_URL=https://api.heygen.com
HEYGEN_AVATAR_ENGINE=avatar_iv
HEYGEN_RESPONSE_TIMEOUT_SECONDS=180
```

大人向け画面で写真・返信音声の外部送信へ同意し、「本人アバターを準備する」を押します。準備完了後は、通常返答ごとにElevenLabs音声をHeyGenへ一時アップロードし、`supportMode`に応じた短い`motion_prompt`と表現強度を指定します。生成済み返信動画はサーバーへ取り込んでから配信し、HeyGenへ送った一時音声アセットと生成動画は取り込み後に削除を試みます。安全引き継ぎでは本人動画を生成しません。

### D-ID無料トライアルの設定

1. [D-ID Studio](https://studio.d-id.com/)でトライアルアカウントを作成します。
2. StudioのAccount settingsでAPI keyを発行し、一度だけ表示される`API_USERNAME:API_PASSWORD`を安全な場所へ保存します。
3. `.env`へ次を設定してサーバーを再起動します。キーはサーバー専用で、ブラウザへ公開しません。

```dotenv
VIDEO_GENERATION_PROVIDER=did
DID_API_KEY=API_USERNAME:API_PASSWORD
DID_BASE_URL=https://api.d-id.com
```

`DID_API_KEY`にはD-ID Dashboardの値をそのまま指定できます。`Basic ...`へエンコード済みの値も受け付けます。無料トライアルは付与されたトライアルクレジットとD-ID側の利用上限の範囲内であり、無制限または恒久的な無料APIアクセスではありません。トライアルで生成した動画にはD-IDのウォーターマークが入ります。残りクレジットと現行条件はStudioで確認してください。

Klingを使う場合の既定値は`kling/kling-v3`の標準画像-to-動画、標準画質、5秒、音声なしです。動画の縦横比は登録写真から決まります。`VIDEO_REQUEST_TIMEOUT_SECONDS`、`VIDEO_POLL_INTERVAL_SECONDS`、`VIDEO_POLL_TIMEOUT_SECONDS`、`VIDEO_DOWNLOAD_TIMEOUT_SECONDS`、`VIDEO_MAX_BYTES`は両プロバイダー共通です。既存の`KLING_VIDEO_*`タイムアウト・上限設定も後方互換のフォールバックとして利用できます。

Klingが`HTTP 403`を返す場合は、OrcaRouter DashboardでAPIキー個別のCredit limit、ワークスペース予算、プロモーションクレジットの動画モデル適用可否を確認してください。テキスト応答が動いていても、動画モデルまたは特定の生成経路だけ拒否される場合があります。

2026-08-14時点のハッカソン環境では、APIキーが有効、上限`$20`、モデル制限なし、プロモーションクレジット`$19.98`（全モデル対象）であることを確認済みです。動画APIのエラー本文は`insufficient_user_quota`で、通常ウォレット`$0.00`に対して動画の事前確保額が不足していることを示していました。KlingとMiniMax、画像ありと画像なし、`/v1/video/generations`と`/v1/videos`の全組み合わせで同じ結果のため、画像形式・プロンプト・特定モデルではなく、プロモーションクレジットが動画の事前確保に算入されないことが原因です。請求画面では1回限りの最低チャージ額が`$1`で、チャージ後は素材画面の「返信動画をつくる」を押し直すだけで再生成できます。

2026-08-15のライブ確認では、OrcaRouterの`openai/gpt-5.6-luna`とElevenLabsクローン音声まで完走しています。LiveAvatar LITEではサンドボックスの1280×720映像と同一画面の二往復、TavusではEcho PAL・公開テストFace・非公開ルームの作成と終了を確認済みです。

```powershell
node --test
```
