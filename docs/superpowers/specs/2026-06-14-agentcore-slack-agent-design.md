# Bedrock AgentCore + Slack 汎用エージェント — 設計書 (PoC)

- 日付: 2026-06-14
- ステータス: 承認済み（実装計画へ）
- 目的: 個人利用・学習。Slack から呼び出せる、Bedrock AgentCore をバックエンドとした汎用 AI エージェントの PoC を、エンドツーエンドで動く形で構築する。

## 1. 背景とゴール

Slack（将来的には Google Chat 等も）から呼び出せる AI エージェントを構築する。バックエンドのエージェントとコンシューマー（呼び出し元）をプロジェクト内で疎結合に分離し、今後コンシューマーを自由に追加できる構造にする。

最初のイテレーションのゴールは **動く PoC**：Slack でメンション → AgentCore 上のエージェントが応答 → スレッドに返信、までをエンドツーエンドで通す。エージェントは **AgentCore Code Interpreter** を使い、**ファイルを入力とした処理**ができる。WebSearch 等のツールは後から追加できる汎用エージェントとする。

### スコープ
- 含む: Slack コンシューマー（ローカル Socket Mode）、AgentCore Runtime 上の Vercel AI SDK エージェント、Code Interpreter ツール、ファイル入力処理、CDK による IaC、コンシューマー⇔エージェントの共通契約。
- 含まない（将来）: AgentCore Memory（長期記憶）、WebSearch ツール、コンシューマーの AWS デプロイ、Google Chat コンシューマー。これらは後から足せる構造に留める。

## 2. 技術選定

| 項目 | 選定 | 理由 |
|---|---|---|
| 言語 | TypeScript（全体） | リポジトリ前提 |
| エージェントフレームワーク | **Vercel AI SDK** | TS ネイティブ。AgentCore Code Interpreter の **組み込み統合**がある。ツール追加が容易 |
| Runtime ラッパ | `bedrock-agentcore` SDK の `BedrockAgentCoreApp` | 任意フレームワークを AgentCore Runtime プロトコルの HTTP サーバ(:8080)に包む |
| ホスティング | AgentCore Runtime（コンテナ / ECR） | TS エージェントはコンテナデプロイが必須 |
| IaC | **AWS CDK** `@aws-cdk/aws-bedrock-agentcore-alpha` | Runtime / CodeInterpreter の L2 コンストラクトを TS で利用可能 |
| Slack 接続 | Slack Bolt（Socket Mode） | 公開エンドポイント不要。ローカルで反復が速い |
| モノレポ | pnpm workspaces | 案1（3層構成）。コンシューマー追加・将来の app 単位デプロイに素直 |

## 3. リポジトリ構成（案1: pnpm モノレポ 3層）

```
apps/
  agent/            # AgentCore Runtime に載せるエージェント（Vercel AI SDK + bedrock-agentcore）
  consumer-slack/   # Slack Bolt(Socket Mode) アダプター
packages/
  contract/         # コンシューマー⇔エージェントの共通インターフェース（型 + 呼び出しクライアント）
infra/              # CDK（AgentCore Runtime / ECR / Code Interpreter / IAM）
```

依存方向: `consumer-slack → contract`、`agent → contract`（型のみ）。コンシューマーはエージェント内部に依存しない。

## 4. アーキテクチャ / データフロー

```
Slack(thread, file)
  → apps/consumer-slack (Bolt, Socket Mode, ローカル)
      ├─ ファイルDL（bot token）
      ├─ セッションID導出（team:channel:thread → 33〜256文字）
      └─ packages/contract のクライアントで InvokeAgentRuntime
          → apps/agent (AgentCore Runtime / コンテナ)
               BedrockAgentCoreApp(:8080) でラップした Vercel AI SDK エージェント
                 └─ tool: Code Interpreter（組み込み統合）でファイル処理・コード実行
          ← テキスト応答（＋生成物 artifacts）
  ← スレッドへ返信
```

## 5. コンポーネント設計

### 5.1 packages/contract（唯一の結合点）
- 役割: コンシューマーとエージェント間の安定した呼び出し契約。型と、AgentCore Runtime を呼ぶ薄いクライアント。
- 型:
  - `AgentRequest { sessionId: string; userId: string; text: string; files?: AgentFile[] }`
  - `AgentFile { name: string; mimeType: string; data: string /* base64 */ }`
  - `AgentResponse { text: string; artifacts?: AgentArtifact[] }`
  - `AgentArtifact { name: string; mimeType: string; data: string /* base64 */ }`
- クライアント: `invokeAgent(req: AgentRequest): Promise<AgentResponse>` — 内部で `InvokeAgentRuntime` を呼ぶ。軽い指数バックオフのリトライを内包。
- セッションID導出ユーティリティ: `deriveSessionId(parts: string[]): string` — `team_id:channel_id:thread_ts` を決定的に整形/ハッシュし **33〜256文字**を満たす文字列を返す（同一スレッド＝同一セッション）。Slack 生IDは33文字未満になり得るため直接使用しない。

### 5.2 apps/agent（AgentCore Runtime エージェント）
- Vercel AI SDK でエージェントループを構成。Bedrock プロバイダ経由でモデルを利用。
- Code Interpreter を AI SDK のツールとして登録（組み込み統合を利用）。
- 入力 `AgentRequest` を受け、`files` があれば Code Interpreter サンドボックスへ書き込み → モデルがコードを生成・実行して処理。
- `BedrockAgentCoreApp` で HTTP(:8080) 化し、リクエスト解析・ストリーミング・セッション管理を委譲。
- 出力: `AgentResponse`（テキスト、必要なら生成物 artifacts）。
- Dockerfile を持ち、ECR へ push。

### 5.3 apps/consumer-slack（Slack アダプター）
- Slack Bolt を Socket Mode で起動（`SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`）。
- `app_mention`（および必要に応じ `message`）を購読。
- 添付ファイルを bot token でダウンロードし base64 化、`AgentFile[]` を構築。
- `deriveSessionId` でセッションID生成 → `contract.invokeAgent` 呼び出し。
- 応答テキストを元スレッドに返信。artifacts があれば Slack にファイルアップロード。
- `contract` のみに依存し、エージェント内部は参照しない。

### 5.4 infra（CDK）
- ECR リポジトリ（agent イメージ）。
- AgentCore Runtime（ECR イメージ参照、`@aws-cdk/aws-bedrock-agentcore-alpha` の Runtime L2）。
- Code Interpreter（CodeInterpreter L2、ネットワークは Public network モード = 既定）。
- IAM 実行ロール（Bedrock モデル呼び出し、Code Interpreter 利用権限）。

## 6. 主要な制約・落とし穴（自己レビューで確認）
- **runtimeSessionId は最小33文字・最大256文字**。Slack `thread_ts`（約17文字）は直接使えないため `deriveSessionId` で導出する（修正1）。
- **Code Interpreter は独立リソース**でネットワークモード（Public/VPC）を持つ。CDK で明示作成し IAM を付与する（修正2）。
- TypeScript エージェントは **コンテナデプロイ必須**（Python のような直接コードデプロイは不可）。

## 7. メモリ / 拡張方針
- 会話継続は **AgentCore Runtime のセッション（Slack スレッド単位）のみ**。スレッド横断の長期記憶は持たない。
- 拡張ポイント:
  - 新コンシューマー = `apps/consumer-xxx/` を1つ追加（`contract` 準拠）。
  - WebSearch 等 = `apps/agent` にツール追加。
  - 長期記憶 = AgentCore Memory を後から追加。
  - AWS デプロイ = `consumer-slack` を Events API + Lambda 等へ切替（`contract` は不変）。

## 8. エラーハンドリング
- Runtime 呼び出し失敗: `contract` クライアントで軽い指数バックオフのリトライ。最終失敗時はスレッドに簡潔なエラーメッセージを返信。
- ファイルDL失敗・サイズ超過: ユーザーにスレッドで通知し処理中断。
- Code Interpreter 実行エラー: エージェントが要約してテキスト応答に含める。

## 9. テスト方針（PoC）
- `packages/contract`: `deriveSessionId`（長さ・決定性）とスキーマの単体テスト。
- `apps/agent`: Code Interpreter でファイルを処理して結果を返すスモークテスト1本。
- `apps/consumer-slack`: イベント → `AgentRequest` 変換のマッピング単体テスト（Slack/Runtime はモック）。

## 10. 環境変数（想定）
- consumer-slack: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `AGENT_RUNTIME_ARN`, `AWS_REGION`。
- agent: `AWS_REGION`, モデルID, Code Interpreter 識別子。

## 参考
- [Get started with the AgentCore starter toolkit in TypeScript](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-toolkit-typescript.html)
- [aws/bedrock-agentcore-sdk-typescript](https://github.com/aws/bedrock-agentcore-sdk-typescript)
- [@aws-cdk/aws-bedrock-agentcore-alpha](https://www.npmjs.com/package/@aws-cdk/aws-bedrock-agentcore-alpha)
- [InvokeAgentRuntime API](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-invoke-agent.html)
