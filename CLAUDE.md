# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

- プロジェクト全体像・前提条件: [README.md](README.md)
- Slack アプリのセットアップ手順: [docs/slack-setup.md](docs/slack-setup.md)（※ 現在 Socket Mode 前提のため Events API 版への更新が必要）
- 設計/計画ドキュメント: [docs/superpowers/specs](docs/superpowers/specs) / [docs/superpowers/plans](docs/superpowers/plans)

## プロジェクト概要

pnpm モノレポ構成の PoC。Slack（Events API + サーバーレス Lambda）から AWS Bedrock AgentCore 上の
Vercel AI SDK エージェントを呼び出し、Code Interpreter でファイル入出力ができる汎用エージェント。
リージョンは **`ap-northeast-1` 固定**。モデルの既定は `global.anthropic.claude-sonnet-4-6`。

## 必須コマンドと完了前の検証

**「完了した」「修正した」と言う前に、必ず以下の両方を通すこと。**

```bash
pnpm test             # vitest: 全テスト実行
pnpm typecheck        # 全パッケージの型チェック（tsc --noEmit）
```

単一テストファイルの実行:

```bash
pnpm vitest run apps/agent/src/agent.test.ts
```

CDK デプロイ:

```bash
pnpm --filter @app/infra run deploy    # ビルド〜ECR push〜Runtime 作成まで一括（deploy は pnpm 組み込みコマンドと衝突するため run が必須）
```

Slack サーバーレスコンシューマーのデプロイ（受信/応答 Lambda + Function URL）:

```bash
pnpm --filter @app/infra run deploy   # AgentcoreSlackAgent と AgentcoreSlackBot を作成
```

## コード構成とアーキテクチャ

### ワークスペース構成

| パッケージ | 名前 | 責務 |
| --- | --- | --- |
| `packages/contract` | `@app/contract` | コンシューマー⇔エージェント間の共通契約。Zod スキーマ(AgentRequest/AgentResponse)・`invokeAgent` クライアント・`deriveSessionId` |
| `apps/agent` | `@app/agent` | AgentCore Runtime 上のエージェント。Vercel AI SDK の ToolLoopAgent + CodeInterpreterTools + Web 検索ツール(Tavily) を `BedrockAgentCoreApp` で HTTP 化。画像/PDF はマルチモーダル(vision)入力として直接処理する |
| `apps/consumer-slack` | `@app/consumer-slack` | Slack Events API（Function URL）を受ける受信/応答 2段 Lambda。受信 Lambda が Slack 署名検証＋即時 ACK、応答 Lambda が `@app/contract` 経由でエージェント呼び出し → mrkdwn 変換して投稿 |
| `infra` | `@app/infra` | AWS CDK スタック。リポジトリルートの Dockerfile を `linux/arm64` でビルドし ECR push → AgentCore Runtime を作成 |

### データフロー

```
Slack (app_mention / DM)
  → 受信 Lambda (Function URL, authType NONE):
      verifySlackSignature → x-slack-retry-num を ignore → 応答 Lambda を非同期 Invoke（InvocationType=Event）で起動 → 200 ACK
  → 応答 Lambda:
      decideEvent → downloadSlackFiles → buildAgentRequest (mapping.ts)
      → contract: invokeAgent → BedrockAgentCoreClient → InvokeAgentRuntime
      → agent (AgentCore Runtime 上):
          buildMessages(画像/PDF を vision パート化 + 全ファイル一覧) → ToolLoopAgent.generate
            （tools: Code Interpreter + web_search + loadAttachments）
          → コードでの処理が必要なときだけ loadAttachments で input/ に取り込み
          → サンドボックスを使った場合のみ collectOutputArtifacts で output/ を回収
      → toSlackMrkdwn(text) + files.uploadV2(artifacts)
  → Slack スレッドに応答
```

### 疎結合の設計

コンシューマーとエージェントは `@app/contract` の型と `invokeAgent` 関数だけを共有する。
コンシューマーはエージェントの内部実装（ToolLoopAgent・CodeInterpreter 等）に依存しない。
新しいコンシューマーは `apps/consumer-xxx/` を新設し、`@app/contract` を使うだけで追加できる。

### テスト方針

純ロジックを切り出して SDK をモックせずに単体テストする。テストファイルはソースと同じディレクトリに `*.test.ts` として配置する（例: `agent.ts` → `agent.test.ts`）。vitest の設定で `cdk.out/` は除外済み。

## コーディング規約

### 言語

**コメント・コミットメッセージ・ドキュメント・テスト名はすべて日本語**で書く。

### ソースコメント規約

1. **ファイル冒頭に概要ブロック** — そのファイルの責務を `// ====` の囲みで記述
2. **関数・型・定数の直前に一行コメント** — 何をするか / 何を表すか
3. **関数内の処理ブロックの先頭に一行コメント** — そのブロックが何をしているか
4. **型のフィールドには行末コメント** で各項目の意味を補足

### コミット規約

Conventional Commits + 日本語説明。スコープにはパッケージ名を使う。

- `feat(agent):` / `fix(consumer-slack):` / `docs(design):` / `chore:`
- 1 コミット 1 関心事。無関係な変更を混ぜない。

## 重要な制約・落とし穴

- **CodeInterpreter の失敗は例外ではなく `"Error: ..."` 文字列で返る** — `isErrorResult()` で判定する（`codeInterpreter.ts`）。
- **バイナリ出力は Code Interpreter サンドボックス内で `base64 -w0` してから読み出す** — `readFiles` は文字列しか返せずバイナリが壊れるため。
- **Dockerfile はリポジトリルートに置く** — CDK の `AgentRuntimeArtifact.fromAsset` がルートをビルドコンテキストに指定するため。`pnpm --filter @app/agent... --frozen-lockfile` でエージェント関連だけインストールする。
- **AgentCore Runtime は `linux/arm64` 専用** — amd64 ホスト（WSL2 等）では QEMU エミュレーション登録（`docker run --privileged --rm tonistiigi/binfmt --install arm64`）が必要。
- **Slack 応答は Markdown → mrkdwn 変換が必要** — Agent は通常の Markdown を返すが、Slack はそのまま表示できないため `toSlackMrkdwn`（slackify-markdown）で変換する。
- **複数ファイル投稿は `file_uploads` でまとめる** — 個別に `uploadV2` を連続呼び出しすると一部しか投稿されない。
- **`invokeAgent` はネットワーク呼び出しのみリトライする** — レスポンスのパース失敗は即エラー（無駄なリトライを防ぐ）。
- **sessionId は SHA-256 ハッシュ（64 文字）** — AgentCore の runtimeSessionId 制約（33-256 文字）を満たす。同一 Slack スレッドなら同一セッション、別スレッドなら別セッションになる。
- **マルチモーダル入力は vision 対応モデル前提** — `AGENT_MODEL_ID` が vision 対応 Claude であることを前提とする（既定の `global.anthropic.claude-sonnet-4-6` は対応）。非対応モデルに切り替える場合は `PDF_VISION_ENABLED=false` 等で画像/PDF を listingOnly（一覧表示のみ）に倒す必要がある。
- **`TAVILY_API_KEY` を必ずデプロイ前に設定する** — `pnpm --filter @app/infra run deploy` の前に環境変数として設定すること。未設定だと Web 検索が実行時に静かに失敗する（例外ではなく LLM にエラー文字列として返る）。
- **画像/PDF のサンドボックス取り込みは lazy** — 添付の画像/PDF は vision パートとして LLM に直接渡し、Code Interpreter サンドボックスへの書き込みは LLM が `loadAttachments` ツールを呼んだときだけ行う。
- **SSM SecureString は CDK で作成できない** — `/agentcore-slack/slack-bot/signing-secret` と `/agentcore-slack/slack-bot/bot-token` はデプロイ前に `aws ssm put-parameter --type SecureString` で手動作成する。CDK は参照と読み取り権限付与のみ。
- **Slack コンシューマーはアクセスキー不要** — Lambda 実行ロールの一時クレデンシャルで AgentCore を呼ぶ。受信は署名検証で認可し、再送（x-slack-retry-num）は一律 ignore する。
