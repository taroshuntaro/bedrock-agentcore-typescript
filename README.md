# bedrock-agentcore-typescript

## 概要

pnpm モノレポ構成の PoC プロジェクト。Slack（ローカル Socket Mode）から AWS Bedrock AgentCore 上の Vercel AI SDK エージェントを呼び出し、Code Interpreter でファイルの入出力処理ができる汎用エージェントです。コンシューマー（Slack アダプター）とエージェントは `packages/contract` を介して疎結合になっており、他のコンシューマーを追加しても既存のエージェントには依存しません。

## 構成

```
.
├── apps/
│   ├── agent/            # AgentCore Runtime 上のエージェント
│   │   │                 # Vercel AI SDK の ToolLoopAgent + CodeInterpreterTools
│   │   │                 # BedrockAgentCoreApp で HTTP エンドポイント化
│   └── consumer-slack/   # Slack Bolt (Socket Mode) アダプター
├── packages/
│   └── contract/         # コンシューマー⇔エージェントの共通契約
│                         # 型・invokeAgent クライアント・deriveSessionId
├── infra/                # AWS CDK スタック
│                         # aws-bedrockagentcore の Runtime / ECR / IAM
└── Dockerfile            # エージェントのコンテナイメージ（リポジトリルート）
```

## 前提条件

- Node.js 20 以上（corepack 経由で pnpm 9 を利用）
- Docker
- AWS 認証情報設定済み（`aws configure` または環境変数）
- Bedrock の利用したいモデルのアクセス有効化
- Slack アプリの準備:
  - Socket Mode 有効化
  - `SLACK_BOT_TOKEN`（`xoxb-...`）と `SLACK_APP_TOKEN`（`xapp-...`）取得済み
  - `app_mention` イベント購読
  - `files:read` / `chat:write` / `files:write` 等のスコープ付与

## セットアップ

```bash
corepack enable
pnpm install
```

テスト実行:

```bash
pnpm test
```

## デプロイ（エージェント）

### 1. CDK ブートストラップ（初回のみ）

```bash
pnpm --filter @app/infra exec cdk bootstrap
```

### 2. CDK スタックをデプロイ（ECR リポジトリ＋Runtime 作成）

```bash
pnpm --filter @app/infra deploy
```

デプロイ完了後、出力に表示される `EcrRepoUri` を控えておきます。

### 3. Docker イメージをビルド

```bash
docker build -t agentcore-agent .
```

### 4. ECR にログイン・タグ付け・プッシュ

```bash
# ECR にログイン（リージョン・アカウント ID を適宜変更）
aws ecr get-login-password --region <AWS_REGION> \
  | docker login --username AWS --password-stdin <AWS_ACCOUNT_ID>.dkr.ecr.<AWS_REGION>.amazonaws.com

# タグ付け
docker tag agentcore-agent:latest <EcrRepoUri>:latest

# プッシュ
docker push <EcrRepoUri>:latest
```

### 5. 再デプロイ（Runtime に最新イメージを反映）

```bash
pnpm --filter @app/infra deploy
```

完了後、出力の `AgentRuntimeArn` を控えておきます。

## ローカル起動（Slack コンシューマー）

### 1. 環境変数を設定

```bash
cp apps/consumer-slack/.env.example apps/consumer-slack/.env
```

`.env` を編集して以下の値を設定します:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
AWS_REGION=us-east-1
AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:...（デプロイ出力値）
```

### 2. 起動

```bash
pnpm --filter @app/consumer-slack dev
```

### 3. Slack でボットを招待してメンション

ボットをチャンネルに招待し、`@bot ...` でメンションします。ファイル添付も可能です。

## エージェントのモデル設定

既定のモデルは `global.anthropic.claude-sonnet-4-20250514-v1:0` です。変更する場合は Runtime の環境変数 `AGENT_MODEL_ID` を設定してください。

Code Interpreter は既定の AWS マネージドインタープリタを利用します。`CODE_INTERPRETER_ID` 環境変数で別のインタープリタに上書きできます。

## コンシューマーの追加方法

`apps/consumer-xxx/` を新設し、`@app/contract` の `invokeAgent` と型（`buildAgentRequest` 相当のマッピング）を使って実装します。エージェント内部の実装には依存しないため、任意のコンシューマーを独立して追加できます。

## 動作確認（手動 E2E）

1. `@bot こんにちは` → テキスト応答（Code Interpreter 未使用）
2. CSV を添付して `@bot このデータを棒グラフにして output に保存して` → 説明テキスト＋画像がスレッドに添付（画像は `output/<name>.b64` 経由で返却）
3. 同一スレッドで継続メンション → 文脈が保持される。別スレッドからメンション → 文脈が分離される
