# Per-reply D-ID lip-sync prototype

OrcaRouterで確定済みの返信文をTTS化し、登録済み保護者写真と同じ音声をD-IDへ渡して、会話ごとの口同期MP4を非同期生成する隔離試作です。完成MP4はD-ID URLのまま返さず、許可ホストから検証取得してAES-256-GCMで暗号化保存し、内部asset参照だけを返します。既存サーバーや画面には接続していません。

## 安全なテスト

テストはHTTP mockと一時ディレクトリだけを使用し、外部APIや有料処理を呼びません。

```powershell
node --test prototypes/per-reply-lipsync/test/clients.test.mjs prototypes/per-reply-lipsync/test/secure-storage.test.mjs prototypes/per-reply-lipsync/test/orchestrator.test.mjs
```

## セキュリティ上の前提

- OrcaRouter/D-IDクライアント、MP4 downloader、暗号鍵は呼び出し側が明示注入します。環境変数や秘密管理システムから鍵を読む処理はこの試作に含めません。
- AES鍵は32-byteの `Uint8Array` だけを受け付けます。ソース、Git、ログ、HTTPレスポンスに鍵を置かないでください。
- downloaderの `allowedHosts` はD-IDが実際に返すCDN hostnameを完全一致で列挙します。wildcard、HTTP、URL credential、443以外のport、redirectは拒否します。
- 保存先directoryは非公開のserver-side領域を明示指定します。平文MP4はメモリ内だけに置き、ディスクには暗号envelopeだけを一時ファイルから原子的renameします。
- asset取得APIはこの試作の範囲外です。実装時は認可済みconversation/profileだけに復号を許可し、AADに同じ `profileId`、`jobKey`、`contentType` を渡します。

## 公開API

`index.mjs` から次をexportします。

- `createOrcaRouterTtsClient`: `POST /v1/audio/speech`
- `createDidClient`: audio upload、AudioScript talk、poll、audio/talk削除
- `createSecureMp4Downloader`: allowlist、HTTPS、MIME、Content-Length、実byte、timeout検証
- `createEncryptedVideoStore`: AES-256-GCM、AAD、atomic save、復号roundtrip
- `createSecureVideoAssetService`: downloaderと暗号storeの合成
- `createPerReplyLipsyncOrchestrator`: 安全・同意ゲート、状態機械、重複排除、cleanup、内部asset返却
- `VIDEO_OWNS_AUDIO_PLAYBACK`: MP4内音声だけを使い、別TTS再生を禁止する契約

入力の `replyText` はOrcaRouter側で内容とrouteが確定済みであることを前提にします。`replyFinal: true`、`conversationId`、対象route、明示的な安全許可がそろわない要求は外部送信前に遮断します。

## OrcaRouter TTSが使えない場合

現在の実装はfail-closedです。検討可能な別routeとして、D-ID TextScriptを明示的に選ぶ案があります。

```json
{
  "script": {
    "type": "text",
    "input": "確定済みの返信文",
    "provider": {
      "type": "microsoft",
      "voice_id": "ja-JP-NanamiNeural"
    }
  }
}
```

これはD-ID側の汎用合成音声であり、登録写真の保護者本人の声を再現しません。写真の同意は声の複製同意を意味しません。親声再現には、対応provider、別個の録音・voice clone同意、本人確認、削除手続き、安全審査が必要です。

詳細設計は `docs/prototypes/per-reply-did-lipsync.md` を参照してください。
