# bedrock-agentcore-typescript

## 概要

pnpm モノレポ構成の PoC プロジェクト。Slack（ローカル Socket Mode）から AWS Bedrock AgentCore 上の Vercel AI SDK エージェントを呼び出し、Code Interpreter でファイルの入出力処理ができる汎用エージェントです。コンシューマー（Slack アダプター）とエージェントは `packages/contract` を介して疎結合になっており、他のコンシューマーを追加しても既存のエージェントには依存しません。

本プロジェクトは **`ap-northeast-1`（東京）リージョン**を前提に構築しています。コード・CDK・各種設定の既定リージョンはすべて `ap-northeast-1` です。別リージョンで動かす場合は、`AWS_REGION` 環境変数（および CDK デプロイ時のリージョン）を上書きしてください。なお Bedrock のモデルは東京リージョンから利用可能なグローバル推論プロファイル（`global.anthropic.claude-sonnet-4-6`）を既定としています。

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
- Docker（CDK が `linux/arm64` イメージをビルドします。amd64 ホスト（WSL2 等）では arm64 エミュレーションが必要 → 下記「デプロイ」参照）
- AWS 認証情報設定済み（`aws configure` または環境変数）
- Bedrock の利用したいモデルのアクセス有効化（`ap-northeast-1` で有効化。既定は `global.anthropic.claude-sonnet-4-6`）
- Slack アプリの準備（Socket Mode・トークン取得・スコープ付与など）→ 詳細は [docs/slack-setup.md](docs/slack-setup.md) を参照

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

CDK がリポジトリルートの `Dockerfile` をビルドし、ブートストラップ管理の ECR に push してから Runtime を作成します。手動の `docker build` / `docker push` は不要です（イメージ未 push による Runtime 作成失敗を防ぐため、この方式にしています）。

### 1. CDK ブートストラップ（初回のみ）

スタックは `ap-northeast-1` にデプロイされます。CLI の既定リージョンが異なる場合は明示的に指定してください。

```bash
pnpm --filter @app/infra exec cdk bootstrap aws://<AWS_ACCOUNT_ID>/ap-northeast-1
```

### 2. arm64 エミュレーションの有効化（amd64 ホストのみ・初回のみ）

AgentCore Runtime は `linux/arm64` イメージを要求します。Apple Silicon 等の arm64 ホストでは不要ですが、**amd64 ホスト（WSL2 等）では QEMU エミュレーションの登録**が必要です。

```bash
docker run --privileged --rm tonistiigi/binfmt --install arm64
# 確認: 'aarch64' が出れば OK
docker run --rm --platform linux/arm64 arm64v8/alpine uname -m
```

### 3. デプロイ（ビルド〜push〜Runtime 作成まで一括）

```bash
pnpm --filter @app/infra deploy
```

完了後、出力の `AgentRuntimeArn` を控えておきます（`.env` の `AGENT_RUNTIME_ARN` に設定）。コードを変更したら、再度このコマンドを実行するだけで新しいイメージがビルド・反映されます。

## ローカル起動（Slack コンシューマー）

Slack アプリの作成・トークン取得・スコープ設定は [docs/slack-setup.md](docs/slack-setup.md) を参照してください。以下はトークン取得済みを前提とした起動手順です。

### 1. 環境変数を設定

```bash
cp apps/consumer-slack/.env.example apps/consumer-slack/.env
```

`.env` を編集して以下の値を設定します:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
AWS_REGION=ap-northeast-1
AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:...（デプロイ出力値）
AWS_PROFILE=your-aws-profile  # SSO 利用時は事前に aws sso login が必要
```

### 2. 起動

```bash
pnpm --filter @app/consumer-slack dev
```

### 3. Slack でボットを招待してメンション

ボットをチャンネルに招待し、`@bot ...` でメンションします。ファイル添付も可能です。

## エージェントのモデル設定

既定のモデルは `global.anthropic.claude-sonnet-4-6`（Sonnet 4.6）です。変更する場合は Runtime の環境変数 `AGENT_MODEL_ID` を設定してください。

Code Interpreter は既定の AWS マネージドインタープリタを利用します。`CODE_INTERPRETER_ID` 環境変数で別のインタープリタに上書きできます。

## コンシューマーの追加方法

`apps/consumer-xxx/` を新設し、`@app/contract` の `invokeAgent` と型（`buildAgentRequest` 相当のマッピング）を使って実装します。エージェント内部の実装には依存しないため、任意のコンシューマーを独立して追加できます。

## 動作確認（手動 E2E）

1. `@bot こんにちは` → テキスト応答（Code Interpreter 未使用）
2. CSV を添付して `@bot このデータを棒グラフにして output に保存して` → 説明テキスト＋画像がスレッドに添付（画像は `output/<name>.b64` 経由で返却）
3. ~~同一スレッドで継続メンション → 文脈が保持される~~ **（未実装）** 現状は毎回単発プロンプトとして処理され、スレッド内の過去の会話は参照されません。AgentCore Memory を利用した文脈維持は今後対応予定です
