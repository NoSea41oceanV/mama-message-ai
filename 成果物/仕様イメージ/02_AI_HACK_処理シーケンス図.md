# AI HACK 2026 処理シーケンス図

```mermaid
sequenceDiagram
    actor Child as 子ども
    actor Adult as 同席する大人
    participant Phone as スマホ画面
    participant Server as API・文字起こし
    participant Router as OrcaRouter
    participant Movie as 動画生成
    participant Log as 匿名技術ログ

    Adult->>Phone: 録音開始
    Phone-->>Child: 「おはなししてね」
    Child->>Phone: 声で話す
    Adult->>Phone: 録音停止
    Phone->>Server: 音声送信
    Server->>Server: サーバー側で文字起こし
    Server-->>Phone: 認識文を表示
    Adult->>Phone: 内容を確認して送信
    Phone->>Server: 確認済み文章を送信
    Server->>Router: 安全優先で3ルートを判定
    Router-->>Server: route・reply・safetyを返す
    Server->>Log: 経路・時間・状態だけを記録

    alt instant_reply：通常の会話
        Server-->>Phone: 短い返信を表示して完了
    else generate_mama_movie：特別な出来事
        Server-->>Phone: 短い返信と「動画を準備中」
        Server->>Movie: 許可済み素材で短い動画を依頼
        alt 30秒以内に成功
            Movie-->>Server: 生成動画URL
            Server-->>Phone: AI生成動画として再生
            Server->>Log: 生成成功を記録
        else タイムアウト・生成失敗
            Server-->>Phone: 承認済み固定動画を再生
            opt 固定動画も再生不可
                Server-->>Phone: テキストへ切り替え
            end
            Server->>Log: fallback・失敗を記録
        end
    else safety_escalation：安全上の心配
        Server-->>Phone: 近くの信頼できる大人への相談案内
        Note over Server,Movie: 通常返信も動画生成も行わない
        Server->>Log: 「大人の確認が必要」を記録
    end
```

## 図の前提

- 主な利用場所は家庭で、3〜6歳児と同席する大人が使う。
- スマホ操作は同席する大人が行い、子どもの主入力は音声とする。
- 本物の保護者とのリアルタイム通話ではなく、AIによる応答であることを画面上で示す。
- 生音声と会話本文は技術ログへ残さず、匿名ID・route・model・cost・latency・statusのみを記録する。
- 安全ルートでは保護者になりきらず、通常返信と動画生成を止める。
