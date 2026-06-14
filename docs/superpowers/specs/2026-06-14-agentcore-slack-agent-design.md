# Bedrock AgentCore + Slack 汎用エージェント — 設計書 (PoC)

- 日付: 2026-06-14
- ステータス: 承認済み（実装計画へ）
- 目的: 個人利用・学習。Slack から呼び出せる、Bedrock AgentCore をバックエンドとした汎用 AI エージェントの PoC を、エンドツーエンドで動く形で構築する。

## 1. 背景とゴール

Slack（将来的には Google Chat 等も）から呼び出せる AI エージェントを構築する。バックエンドのエージェントとコンシューマー（呼び出し元）をプロジェクト内で疎結合に分離し、今後コンシューマーを自由に追加できる構造にする。

最初のイテレーションのゴールは **動く PoC**：Slack でメンション → AgentCore 上のエージェントが応答 → スレッドに返信、までをエンドツーエンドで通す。エージェントは **AgentCore Code Interpreter** を使い、**ファイルを入力とした処理**と**生成ファイルの出力（ダウンロード）**ができる。WebSearch 等のツールは後から追加できる汎用エージェントとする。

### スコープ
- 含む: Slack コンシューマー（ローカル Socket Mode）、AgentCore Runtime 上の Vercel AI SDK エージェント、Code Interpreter ツール、**ファイル入力処理および Code Interpreter 生成ファイルの出力（ダウンロード）対応**、CDK による IaC、コンシューマー⇔エージェントの共通契約。
- 含まない（将来）: AgentCore Memory（長期記憶）、WebSearch ツール、コンシューマーの AWS デプロイ、Google Chat コンシューマー。これらは後から足せる構造に留める。

## 2. 技術選定

| 項目 | 選定 | 理由 |
|---|---|---|
| 言語 | TypeScript（全体） | リポジトリ前提 |
| エージェントフレームワーク | **Vercel AI SDK** | TS ネイティブ。AgentCore Code Interpreter の **組み込み統合**がある。ツール追加が容易 |
| Runtime ラッパ | `bedrock-agentcore` SDK の `BedrockAgentCoreApp` | 任意フレームワークを AgentCore Runtime プロトコルの HTTP サーバ(:8080)に包む |
| ホスティング | AgentCore Runtime（コンテナ / ECR） | TS エージェントはコンテナデプロイが必須 |
| IaC | **AWS CDK** `aws-cdk-lib/aws-bedrockagentcore`（安定版） | Runtime / CodeInterpreterCustom の L2 コンストラクトを TS で利用可能（Runtime/Tools は alpha から安定版へ移動済み。Policy のみ alpha） |
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
                 ├─ uploadInputFiles → buildPrompt（ファイル名一覧をプロンプトに付与）
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
- Code Interpreter を AI SDK の**ツールとして登録**する。呼び出しは必須ではなく、**モデルがユーザー指示に応じて自律的に使うかどうかを判断**する（tool-calling）。単純な会話なら未使用、ファイル処理やコード実行が必要なときに呼ばれる。
- 入力 `AgentRequest` を受ける。`files` がある場合、サンドボックスの `input/` に書き込んだ上で、プロンプト末尾にファイル名一覧を付与して LLM にファイルの存在を認識させる（`buildPrompt`）。モデルが Code Interpreter を選択したらサンドボックス上のファイルを処理する。
- 今後追加するツール（WebSearch 等）も同様に「登録するがモデルが判断して呼ぶ」方針で統一する。
- **ファイル入出力（Code Interpreter）**:
  - 入力: `AgentRequest.files` をサンドボックスの `input/` へ書き込み、プロンプトにファイル名一覧を付与して LLM に認識させる（`buildPrompt`）。モデルが処理に利用。
  - 出力: モデルがサンドボックス内で**生成したファイル**（グラフ画像・変換後ファイル・CSV等）を `output/` に保存する。エージェントは `ls` で列挙後、各ファイルを **`base64 -w0` コマンドで安全にエンコードして読み出し**、`AgentResponse.artifacts` に載せて返す。`readFiles` API は文字列しか返せずバイナリが壊れるため使用しない。コンシューマー側でダウンロード可能にする。
- `BedrockAgentCoreApp` で HTTP(:8080) 化し、リクエスト解析・ストリーミング・セッション管理を委譲。
- 出力: `AgentResponse`（テキスト ＋ 生成物 artifacts）。
- Dockerfile を持ち、ECR へ push。

### 5.3 apps/consumer-slack（Slack アダプター）
- Slack Bolt を Socket Mode で起動（`SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`）。
- `app_mention`（および必要に応じ `message`）を購読。
- 添付ファイルを bot token でダウンロードし base64 化、`AgentFile[]` を構築。
- `deriveSessionId` でセッションID生成 → `contract.invokeAgent` 呼び出し。
- 応答テキストを Slack mrkdwn に変換してスレッドに返信。`AgentResponse.artifacts`（Code Interpreter が生成した出力ファイル）があれば `files.uploadV2` の **`file_uploads` で一括アップロード**してダウンロード可能にする（個別 `uploadV2` の連続呼び出しは同名衝突で一部しか投稿されないため不採用）。
- `contract` のみに依存し、エージェント内部は参照しない。

### 5.4 infra（CDK）
- AgentCore Runtime（`aws-cdk-lib/aws-bedrockagentcore` の `Runtime` L2、`AgentRuntimeArtifact.fromAsset` でリポジトリルートの Dockerfile を直接参照。CDK が自動で Docker ビルド・ECR push・Runtime 作成を行う）。
- Code Interpreter は **AWS 管理の既定インタープリタ（identifier 既定）を利用**し、専用のカスタムリソースは作らない。Runtime 実行ロールに Code Interpreter 利用の IAM 権限を付与（将来、専用化したい場合は `CodeInterpreterCustom` を作成し ID を `CODE_INTERPRETER_ID` で渡す）。
- IAM 実行ロール（Bedrock モデル呼び出し、Code Interpreter 利用権限）。

## 6. 主要な制約・落とし穴（自己レビューで確認）
- **runtimeSessionId は最小33文字・最大256文字**。Slack `thread_ts`（約17文字）は直接使えないため `deriveSessionId` で導出する（修正1）。
- **Code Interpreter は独立リソース**でネットワークモード（Public/VPC）を持つ。CDK で明示作成し IAM を付与する（修正2）。
- TypeScript エージェントは **コンテナデプロイ必須**（Python のような直接コードデプロイは不可）。
- **Code Interpreter の `readFiles` API は文字列しか返せない**ため、バイナリファイル（画像・PDF等）をそのまま読むと壊れる。サンドボックス内で `base64 -w0` コマンドを実行してエンコードしてから読み出す方式で回避している。

### 既知の警告: Slack `files.uploadV2` の filename に拡張子がないと unfurl が不安定（2026-06-15 確認）
- **現象**: `file_uploads` で複数ファイルをまとめてアップロードした際、Slack Bolt が `[WARN] bolt-app filename supplied 'images' may be missing a proper extension. Missing extensions may result in unexpected unfurl behavior when shared` という警告を出すことがある。
- **原因**: `file_uploads` でまとめた場合、Slack 内部で各ファイルの親グループに `images` 等の拡張子なしの名前が割り当てられることがある模様。個別ファイルの `filename`（`a.name`）には拡張子が付いており、これはアプリ側の問題ではなく Slack API / Bolt 側の挙動。
- **影響**: ファイル自体のアップロード・ダウンロードには支障なし。Slack 上でリンク共有した際の unfurl（プレビュー展開）が不安定になる可能性がある。
- **対応方針**: 現時点では機能上の実害がないため静観。Slack API / Bolt のアップデートで改善される可能性がある。実害が出た場合は `file_uploads` の使い方の見直し、または個別アップロードへの回帰（同名衝突対策を別途入れた上で）を検討する。

## 7. メモリ / 拡張方針
- 会話継続は **AgentCore Runtime のセッション（Slack スレッド単位）のみ**。スレッド横断の長期記憶は持たない。

### 既知の制約: スレッド内マルチターン会話は未実装（2026-06-14 追記）
- **設計意図**: 同一スレッド＝同一 `sessionId` とし、スレッド内では会話文脈を保持する（マルチターン会話）。本節および手動 E2E 検証の項目3「同一スレッドで続けて質問 → 文脈が保持されている」が想定。
- **実態**: 未実装。`apps/agent/src/agent.ts` の `runAgent` は今回のメッセージ本文（`req.text`）のみを単発プロンプトで LLM に渡しており、過去メッセージの保持・再投入を一切行っていない。よって `sessionId` が同じでも LLM は毎回そのメッセージしか見ず、文脈は continued しない。
- **原因（設計上の誤った前提）**: 「同一 `runtimeSessionId` を渡せば AgentCore Runtime が会話文脈を自動保持する」という前提が誤り。`runtimeSessionId` が提供するのはセッションの分離・同一コンテナへのルーティング（セッションアフィニティ）であって、LLM への会話履歴の自動注入ではない。**会話履歴の保持・再投入はアプリケーション側の責務**。
- **今後の対応方針: AgentCore Memory を採用する**（プロセス内 Map 保持は不採用）。
  - 理由: プロセス内 `Map` 保持はコンテナ揮発（アイドルで停止＝履歴消失）・スケールアウト時の別コンテナへのルーティング・再起動での消失・メモリ無限増加といった問題があり、「スレッドを開けば常に文脈が続く」という設計ゴールを満たせない。AgentCore Memory なら `sessionId` 単位で履歴を永続化でき、これらに耐える。
  - 実装の概要: `sessionId` をキーに会話履歴を AgentCore Memory に保存し、`runAgent` で「過去履歴＋今回メッセージ」を構築して LLM に渡す。`agent.ts` の `generate(prompt)` を `messages` 配列を受け取る形（`agent.generate({ messages })`）に変更し、ユーザー発話とアシスタント応答（ツール呼び出し含む）の双方を履歴へ追記する。
  - 対応時期: 未着手（本イテレーションのスコープ外）。

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

## 10. コスト概算（個人利用・概算）

料金は消費ベース（東京/us 想定、無料枠未考慮、実コストはモデル・リージョン・トークン量で変動）。

### レート
| 対象 | レート | 課金特性 |
|---|---|---|
| Runtime（CPU） | $0.0895 / vCPU時 | 秒単位。**I/O待ち（LLM応答待ち）中はCPU課金なし** |
| Runtime（メモリ） | $0.00945 / GB時 | 最小128MB |
| Code Interpreter | 同上（CPU/メモリ） | メモリはセッション期間中ピーク量、CPUは実行中のみ |
| アイドル時 | **$0** | 常時課金なし |
| Bedrock トークン | モデル次第（別建て） | 入出力トークンに課金。**支配的コスト** |

### 月100リクエスト程度の試算
- AgentCore Runtime 計算: ≈ $0.03 / 月
- Code Interpreter（3割起動想定）: ≈ $0.01 / 月
- Bedrock トークン（例: Sonnet系）: ≈ $5 / 月（Haiku系ならさらに安い）
- ECR イメージ保管: ≈ $0.1 / 月、CloudWatch/転送はごく少額
- Slack コンシューマー（フェーズ1ローカル）: $0

**合計 ≈ 月 $5〜6、ほぼ全額が Bedrock トークン代。** AgentCore 計算リソースは数セント〜十数セント。最大の利点はアイドル課金なし。主なコストレバーはモデル選定とトークン量。

## 11. 環境変数（想定）
- consumer-slack: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `AGENT_RUNTIME_ARN`, `AWS_REGION`。
- agent: `AWS_REGION`, `AGENT_MODEL_ID`（既定 `global.anthropic.claude-sonnet-4-6`）、`CODE_INTERPRETER_ID`（任意。未設定なら AWS 管理の既定インタープリタ）。

## 参考
- [Get started with the AgentCore starter toolkit in TypeScript](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-toolkit-typescript.html)
- [aws/bedrock-agentcore-sdk-typescript](https://github.com/aws/bedrock-agentcore-sdk-typescript)
- [aws-cdk-lib/aws-bedrockagentcore（安定版コンストラクト）](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrockagentcore-readme.html)
- [bedrock-agentcore-samples-typescript（Vercel AI SDK + Code Interpreter 例）](https://github.com/awslabs/bedrock-agentcore-samples-typescript/tree/main/primitives/tools/code-interpreter)
- [InvokeAgentRuntime API](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-invoke-agent.html)
