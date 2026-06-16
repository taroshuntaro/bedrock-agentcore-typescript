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
# AWS 認証情報の取得に使うプロファイル（SSO 利用時は事前に aws sso login が必要）
AWS_PROFILE=your-aws-profile
```

> コンシューマーは AWS 認証情報を使って AgentCore Runtime を呼び出します。`.env` の `AWS_PROFILE` で使用プロファイルを指定し、SSO の場合は事前に `aws sso login --profile <名前>` を実行しておいてください。環境変数やインスタンスロール等で認証情報を渡す場合は `AWS_PROFILE` は不要です。`Could not load credentials from any providers` が出る場合は、この設定漏れか SSO セッション切れが原因です。

## 7. 起動

```bash
pnpm --filter @app/consumer-slack dev
```

`⚡️ Slack consumer (Socket Mode) running` が表示されれば接続成功です。

## 8. 動作確認

1. チャンネルに bot を招待（`/invite @<bot名>`）
2. `@<bot名> こんにちは` でメンション → スレッドに応答が返る（ツール未使用）
3. `@<bot名> 最新の TypeScript のリリース状況を調べて` → Web 検索（`web_search`）で回答＋引用 URL が返る（要 `TAVILY_API_KEY`・下記注記参照）
4. 画像を添付して `@<bot名> この画像に何が写っている？` → 画像を直接読み取って回答（Code Interpreter 未使用）
5. CSV などを添付して `@<bot名> このデータを棒グラフにして output に保存して` → 説明テキスト＋生成画像がスレッドに添付される
6. ~~同一スレッドで続けてメンションすると文脈が保持される~~ **（未実装）** 現状は毎回単発プロンプトとして処理され、スレッド内の過去の会話は参照されません。今後 AgentCore Memory で対応予定です
7. 応答しない場合は、起動したコンシューマープロセスのコンソールログを確認する

> **Web 検索（`web_search`）について**: Tavily API キーが必要です。キーは Slack 側ではなく**エージェントのデプロイ時**に環境変数 `TAVILY_API_KEY` として注入します（[../README.md](../README.md) のデプロイ手順を参照）。未設定の場合、検索は実行時に「検索に失敗しました: …」という文字列を返すだけで、他の応答は継続します。
>
> **画像/PDF の入力について**: 添付された画像・PDF はモデルが直接「見て」回答します（vision 入力）。`files:read` スコープがあれば追加設定は不要です。vision 対応モデル（既定の Claude Sonnet 4.6 は対応）であることが前提です。

## 制約

- **スレッド単位の文脈保持（未実装）**: 同一スレッド＝同一 `sessionId` としてセッションは分離されますが、会話履歴の保持・再投入は未実装のため、毎回単発のメッセージとして処理されます。AgentCore Memory を利用した文脈維持は今後対応予定です。
- **DM 非対応**: 現状は `app_mention`（チャンネルでのメンション）のみ対応です。
- **ローカル常駐**: Socket Mode のため、コンシューマープロセスが起動している間だけ応答します（将来 AWS 等への常駐デプロイは可能）。
