# bedrock-agentcore-typescript

## 概要

pnpm モノレポ構成の PoC プロジェクト。Slack（Events API + サーバーレス Lambda）から AWS Bedrock AgentCore 上の Vercel AI SDK エージェントを呼び出す、汎用エージェントです。エージェントは次の能力を持ちます。

- **Code Interpreter**：ファイルを入力としたコード実行・データ処理と、生成ファイルの出力（ダウンロード）。
- **マルチモーダル入力**：添付された画像 / PDF をモデルの vision 入力として直接「見せる」。
- **Web 検索**：Tavily を用いた外部検索ツール（`web_search`）で最新情報・事実確認に対応。

コンシューマー（Slack アダプター）とエージェントは `packages/contract` を介して疎結合になっており、他のコンシューマーを追加しても既存のエージェントには依存しません。

本プロジェクトは **`ap-northeast-1`（東京）リージョン**を前提に構築しています。コード・CDK・各種設定の既定リージョンはすべて `ap-northeast-1` です。別リージョンで動かす場合は、`AWS_REGION` 環境変数（および CDK デプロイ時のリージョン）を上書きしてください。なお Bedrock のモデルは東京リージョンから利用可能なグローバル推論プロファイル（`global.anthropic.claude-sonnet-4-6`）を既定としています。

## エージェントの機能

エージェントは Vercel AI SDK の `ToolLoopAgent` に複数のツールを持たせ、LLM が状況に応じて使い分けます。

| 機能 | 内容 | 関連ツール / 実装 |
| --- | --- | --- |
| ファイル処理 | Code Interpreter サンドボックスでのコード実行・グラフ生成・データ変換など | `CodeInterpreterTools`（`executeCode` 等） |
| マルチモーダル | 画像（png/jpeg/gif/webp）・PDF を vision 入力として直接モデルに渡す | `buildMessages` / `partitionFiles` |
| Web 検索 | クエリを Tavily に投げ、合成回答＋上位ソースを返す | `web_search`（`webSearch.ts`） |
| 添付の取り込み | 添付ファイルをコードで処理したいときだけサンドボックスへ展開 | `loadAttachments` |

### 入力ファイルの扱い（lazy）

添付された**画像 / PDF は常に vision としてモデルに直接渡され**、「この画像は何？」のような質問はサンドボックスを起動せずに答えます。ファイルを**コードで加工・解析する必要があるときだけ**、モデルが `loadAttachments` ツールを呼んで `input/` に取り込みます。テキスト系ファイル（CSV/JSON 等）はファイル名一覧として提示され、内容が必要なら `loadAttachments` 後に Code Interpreter で読み込みます。これにより、純粋な vision クエリや Web 検索のみのクエリでは Code Interpreter セッションを無駄に起動しません。

> マルチモーダルは `AGENT_MODEL_ID` が **vision 対応の Claude モデル**であることを前提とします（既定の `global.anthropic.claude-sonnet-4-6` は対応）。非対応モデルを使う場合は `PDF_VISION_ENABLED=false` 等で画像/PDF を一覧表示のみに倒してください。

## 構成

```
.
├── apps/
│   ├── agent/            # AgentCore Runtime 上のエージェント
│   │   │                 # Vercel AI SDK の ToolLoopAgent
│   │   │                 #   + CodeInterpreterTools（ファイル処理）
│   │   │                 #   + web_search（Tavily 検索）
│   │   │                 #   + loadAttachments（添付の遅延取り込み）
│   │   │                 #   + 画像/PDF の vision 入力
│   │   │                 # BedrockAgentCoreApp で HTTP エンドポイント化
│   └── consumer-slack/   # Slack Events API (Function URL) アダプター
│                         # 受信 Lambda（署名検証・即時 ACK）+
│                         # 応答 Lambda（エージェント呼び出し・投稿）
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
- Bedrock の利用したいモデルのアクセス有効化（`ap-northeast-1` で有効化。既定は vision 対応の `global.anthropic.claude-sonnet-4-6`）
- **Tavily API キー**（Web 検索を使う場合）。[tavily.com](https://tavily.com) で取得し、デプロイ時に `TAVILY_API_KEY` として渡します（無料枠あり）
- Slack アプリの準備（Events API・スコープ付与・SSM SecureString 登録など）→ 詳細は下記「Slack コンシューマーのデプロイ」を参照

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

### 3. Tavily API キーを環境変数に設定（Web 検索を使う場合）

`TAVILY_API_KEY` は**デプロイ時のシェル環境変数**から Runtime に注入されます（値はリポジトリにコミットしません）。デプロイ前に設定してください。

```bash
export TAVILY_API_KEY=tvly-...
```

> 未設定のままデプロイすると、Web 検索は**実行時に静かに失敗**します（例外ではなく「検索に失敗しました: …」という文字列がモデルに返り、応答は継続します）。Web 検索を使わない場合は未設定でも他の機能は動作します。

### 4. デプロイ（ビルド〜push〜Runtime 作成まで一括）

```bash
pnpm --filter @app/infra run deploy
```

> `deploy` は pnpm の組み込みコマンドと名前が衝突するため、`run` を省略すると `ERR_PNPM_INVALID_DEPLOY_TARGET` になります。

完了後、出力の `AgentRuntimeArn` を控えておきます（`.env` の `AGENT_RUNTIME_ARN` に設定）。コードを変更したら、再度このコマンドを実行するだけで新しいイメージがビルド・反映されます。

## Slack コンシューマーのデプロイ

Slack コンシューマーは **Events API + Function URL** で動作するサーバーレス構成です。受信 Lambda が Slack の署名検証と即時 ACK を行い、応答 Lambda がエージェントを呼び出して結果を投稿します。ローカル常駐プロセスは不要で、アクセスキーも不要（Lambda 実行ロールの一時クレデンシャルを使用）です。

### 1. Slack アプリの作成とスコープ付与

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create an App** → **From scratch** でアプリを作成
2. **OAuth & Permissions** → **Bot Token Scopes** に以下を追加:
   - `app_mentions:read`（チャンネルでのメンション受信）
   - `im:history`（DM の受信）
   - `chat:write`（返信の投稿）
   - `files:read`（添付ファイルのダウンロード）
   - `files:write`（生成物ファイルのアップロード）
3. **Install to Workspace** でインストールし、**Bot User OAuth Token**（`xoxb-` で始まる）を控える

### 2. SSM SecureString の手動作成（デプロイ前）

CDK は SecureString パラメータを作成できないため、デプロイ前に手動で登録します。

```bash
aws ssm put-parameter --region ap-northeast-1 --type SecureString \
  --name /agentcore-slack/slack-bot/signing-secret --value '<Signing Secret>'
aws ssm put-parameter --region ap-northeast-1 --type SecureString \
  --name /agentcore-slack/slack-bot/bot-token --value 'xoxb-...'
```

> Signing Secret は Slack アプリの **Basic Information → App Credentials → Signing Secret** で確認できます。

### 3. デプロイ

```bash
pnpm --filter @app/infra run deploy
```

デプロイ完了後、出力の `SlackEventsUrl` を控えます。

### 4. Event Subscriptions の設定

1. Slack アプリの **Event Subscriptions** → **Enable Events** を **On**
2. **Request URL** にデプロイ出力の `SlackEventsUrl` を入力し、Verified になることを確認
3. **Subscribe to bot events** に以下を追加して保存:
   - `app_mention`（チャンネルでのメンション）
   - `message.im`（DM）
4. 保存後に再インストールを求められたら従う

### 5. Slack でボットを招待してメンション

ボットをチャンネルに招待し、`@bot ...` でメンションします。DM も直接送信できます。ファイル添付（画像・PDF・CSV など）も可能です。

## エージェントの環境変数

Runtime の挙動は以下の環境変数で制御します（CDK の `environmentVariables` 経由で注入）。

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `AGENT_MODEL_ID` | `global.anthropic.claude-sonnet-4-6` | 使用するモデル ID。マルチモーダルを使うなら **vision 対応 Claude** であること |
| `AWS_REGION` | `ap-northeast-1` | リージョン |
| `TAVILY_API_KEY` | （なし） | Web 検索用の Tavily API キー。未設定だと検索が実行時に失敗する |
| `PDF_VISION_ENABLED` | `true` | `false` にすると PDF を vision に渡さず一覧表示のみにする（プロバイダ未対応・トークン節約時） |
| `CODE_INTERPRETER_ID` | （AWS マネージド） | 別の Code Interpreter に上書きする場合に指定 |

## コンシューマーの追加方法

`apps/consumer-xxx/` を新設し、`@app/contract` の `invokeAgent` と型（`buildAgentRequest` 相当のマッピング）を使って実装します。エージェント内部の実装には依存しないため、任意のコンシューマーを独立して追加できます。

## 動作確認（手動 E2E）

1. `@bot こんにちは` → テキスト応答（ツール未使用）
2. bot への DM で `こんにちは` → DM スレッドに応答（`message.im` 購読）
3. `@bot 最新の TypeScript のリリース状況を調べて` → `web_search` で検索し、回答＋引用 URL を返す
4. 画像を添付して `@bot この画像に何が写っている？` → 画像を直接読み取って回答（サンドボックス未使用）
5. CSV を添付して `@bot このデータを棒グラフにして output に保存して` → `loadAttachments` で取り込み、Code Interpreter で処理。説明テキスト＋生成画像がスレッドに添付（画像は `output/<name>` 経由で返却）
6. ~~同一スレッドで継続メンション → 文脈が保持される~~ **（未実装）** 現状は毎回単発プロンプトとして処理され、スレッド内の過去の会話は参照されません。AgentCore Memory を利用した文脈維持は今後対応予定です
