# Slack bot 構築手順

Slack のメンションから AgentCore 上のエージェントに質問できる bot のセットアップ手順。

本プロジェクトの Slack コンシューマーは **Socket Mode** で動作し、ローカル（または任意のサーバー）で常駐プロセスとして起動します。Slack 側に公開 URL を登録する必要はなく、署名検証やリクエスト URL の検証も不要です。

前提として、エージェント本体（AgentCore Runtime）がデプロイ済みで `AgentRuntimeArn` を取得していること（[../README.md](../README.md) のデプロイ手順）。

> Socket Mode では **2 種類のトークン**が必要です。
> - **Bot User OAuth Token**（`xoxb-` で始まる）… API 呼び出し用 → `SLACK_BOT_TOKEN`
> - **App-Level Token**（`xapp-` で始まる）… Socket Mode のコネクション用 → `SLACK_APP_TOKEN`

## 1. Slack アプリの作成

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create an App** → **From scratch**
2. アプリ名（例: `agentcore-slack-agent`）と導入先ワークスペースを選んで作成

## 2. Socket Mode の有効化と App-Level Token の発行

1. 左メニュー **Settings → Socket Mode** → **Enable Socket Mode** を **On**
2. App-Level Token の発行を求められるので、トークン名（例: `socket`）を入力し、スコープ **`connections:write`** を付与して生成
3. 生成された **`xapp-` で始まるトークン**を控える（→ 後で `SLACK_APP_TOKEN` に設定）

> App-Level Token は後から **Settings → Basic Information → App-Level Tokens** でも発行・確認できます。

## 3. 権限（スコープ）の設定とインストール

1. **OAuth & Permissions** → Scopes → **Bot Token Scopes** に以下を追加:
   - `app_mentions:read`（メンションの受信）
   - `chat:write`（返信の投稿）
   - `files:read`（添付ファイルのダウンロード）
   - `files:write`（生成物ファイルのアップロード）
2. ページ上部の **Install to Workspace** でインストールし、
   **Bot User OAuth Token**（`xoxb-` で始まる）を控える（→ 後で `SLACK_BOT_TOKEN` に設定）

## 4. イベント購読

1. **Event Subscriptions** → **Enable Events** を **On**
   （Socket Mode が有効なため Request URL の入力は不要）
2. **Subscribe to bot events** に以下を追加して保存:
   - `app_mention`
3. 保存後に再インストールを求められたら従う（スコープ変更時も同様）

> 本プロジェクトのコンシューマーは `app_mention` のみを処理します。DM には対応していません。

## 5. Bedrock モデルのアクセス（アカウントで初回のみ）

エージェントは既定で Anthropic の **Claude Sonnet 4.6**（推論プロファイル `global.anthropic.claude-sonnet-4-6`）を `ap-northeast-1` から呼び出します。Anthropic などサードパーティモデルは、アカウントで初めて invoke した時点で AWS Marketplace のサブスクリプション（モデル合意）が自動確定されますが、**Anthropic モデルのみ追加でユースケースフォームの提出が必要**です。

- **ユースケースフォームの提出（Anthropic のみ・アカウントで 1 回）**: Bedrock コンソールのモデルカタログで Anthropic モデルを選ぶとフォームが表示されます。提出すると即時で利用可能になります。
- **初回 invoke する IAM アイデンティティに Marketplace 権限が必要**（自動サブスクリプションは呼び出し元の権限で実行されるため）。Runtime の実行ロールが初回呼び出しを行う場合は、そのロールに以下を一時的に付与しておくと確実です（確定後は不要）:

  ```json
  {
    "Effect": "Allow",
    "Action": [
      "aws-marketplace:Subscribe",
      "aws-marketplace:Unsubscribe",
      "aws-marketplace:ViewSubscriptions"
    ],
    "Resource": "*"
  }
  ```

- アカウントに有効な支払い方法が設定されていること。

> **ハマりどころ**: サブスクリプション確定前の猶予期間（最大 15 分）は呼び出しが一時的に成功することがあります。「1 回目は動いたのに 2 回目以降 `AccessDeniedException`（`aws-marketplace:Subscribe ... not authorized`）になる」場合は、呼び出し元の Marketplace 権限不足で確定に失敗しています。権限を付与して再度 invoke し、反映まで数分待ってください。

## 6. 環境変数の設定

手順 2〜3 で控えたトークンと、デプロイ時に出力された `AgentRuntimeArn` を `.env` に設定します。

```bash
cp apps/consumer-slack/.env.example apps/consumer-slack/.env
```

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
AWS_REGION=ap-northeast-1
AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:ap-northeast-1:...（デプロイ出力値）
```

> コンシューマーは AWS 認証情報を使って AgentCore Runtime を呼び出します。ローカル起動時は `aws sso login` 等でプロファイルを有効化しておいてください（`AWS_PROFILE` 環境変数で切り替え可能）。

## 7. 起動

```bash
pnpm --filter @app/consumer-slack dev
```

`⚡️ Slack consumer (Socket Mode) running` が表示されれば接続成功です。

## 8. 動作確認

1. チャンネルに bot を招待（`/invite @<bot名>`）
2. `@<bot名> こんにちは` でメンション → スレッドに応答が返る（Code Interpreter 未使用）
3. CSV などを添付して `@<bot名> このデータを棒グラフにして output に保存して` → 説明テキスト＋生成画像がスレッドに添付される
4. 同一スレッドで続けてメンションすると文脈が保持される。別スレッドからのメンションは文脈が分離される
5. 応答しない場合は、起動したコンシューマープロセスのコンソールログを確認する

## 制約

- **スレッド単位の文脈保持**: 会話の継続は Slack スレッド単位（`thread_ts`）で分離されます。長期記憶は持ちません。
- **DM 非対応**: 現状は `app_mention`（チャンネルでのメンション）のみ対応です。
- **ローカル常駐**: Socket Mode のため、コンシューマープロセスが起動している間だけ応答します（将来 AWS 等への常駐デプロイは可能）。
