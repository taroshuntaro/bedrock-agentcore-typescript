# Slack コンシューマーのサーバーレス移行 設計

- 日付: 2026-06-18
- 対象: `apps/consumer-slack`, `infra`
- 参考: `bedrock-kb-gdrive-rag`（HTTP Events API + 2段 Lambda 構成）

## 背景と目的

現在の Slack コンシューマーは `@slack/bolt` の Socket Mode でローカル常駐起動している
（`pnpm --filter @app/consumer-slack dev`）。これをサーバーレス（AWS Lambda）にデプロイする
形式へ移行する。あわせて以下を達成する。

- **常駐プロセス/ローカル起動の廃止** — Socket Mode をやめ HTTP Events API に移行する。
- **アクセスキーの全廃** — AWS 認証は Lambda 実行ロール（IAM Role）の一時クレデンシャルに統一する。
- **Slack トークンの安全な保管** — SSM Parameter Store の SecureString に格納する。

移行は **完全置き換え**。現状の Socket Mode 実装は `backup/socket-mode-consumer` ブランチに退避済み。

## 全体アーキテクチャ

AgentCore 呼び出しは Code Interpreter / Web 検索により長時間化しうる。Slack の 3 秒応答制約を
満たすため、「受信は即応答・重い処理は非同期 worker に委譲」する 2 段 Lambda 構成を採る。

```
Slack Events API (app_mention / message.im)
  → [受信 Lambda] Function URL (authType=NONE, 署名検証で認可)
       署名検証 → decideEvent(challenge / ignore / answer)
       → answer なら worker を非同期 Invoke (InvocationType=Event) → 即 200
  → [応答 Lambda worker] (retryAttempts=0)
       Slack ファイル DL(bot token) → buildAgentRequest
       → invokeAgent(@app/contract, AgentCore Runtime)
       → toSlackMrkdwn → chat.postMessage + files.uploadV2 (WebClient)
  → Slack スレッド/DM に応答
```

## コンポーネント

### apps/consumer-slack（Lambda ハンドラ + 純ロジック）

| ファイル | 種別 | 責務 |
| --- | --- | --- |
| `src/receiver.ts` | ハンドラ(SDK 層) | Function URL イベント受信。署名検証 → `decideEvent` → worker 非同期起動。3 秒以内に必ず応答 |
| `src/worker.ts` | ハンドラ(SDK 層) | 非同期起動される本処理。ファイル DL → `buildAgentRequest` → `invokeAgent` → mrkdwn 変換 → Slack 投稿 |
| `src/slack-verify.ts` | 純ロジック(新規) | HMAC-SHA256 署名検証 + タイムスタンプ窓（±5 分）。`verifySlackSignature` |
| `src/slack-event.ts` | 純ロジック(新規) | `decideEvent`: challenge / ignore / answer の判定。`app_mention` + DM(`message.im`) 対応 |
| `src/mapping.ts` | 純ロジック(再利用・無改修) | `buildAgentRequest`: メンション除去・セッション ID 導出・ファイル整形 |
| `src/format.ts` | 純ロジック(再利用・無改修) | `toSlackMrkdwn`: Markdown → mrkdwn 変換 |

- 削除: `src/app.ts`（Socket Mode 実装）。
- 依存変更: `@slack/bolt` を削除し、`@slack/web-api`（WebClient: `files.uploadV2` の多段アップロードを担当）、
  `@aws-sdk/client-ssm`、`@aws-sdk/client-lambda` を追加。
- `package.json` の `dev` スクリプト（`tsx src/app.ts`）は削除する。ローカル動作確認はユニットテストで担保する。
- 環境変数: `SLACK_APP_TOKEN`（Socket Mode 専用）は廃止。署名検証用に `SLACK_SIGNING_SECRET` 相当を
  Parameter Store から取得する。

### infra（CDK）

| 追加/変更 | 内容 |
| --- | --- |
| `lib/slack-bot-stack.ts`（新規） | 受信/応答 `NodejsFunction` ×2、Function URL、IAM、SSM 読み取り権限 |
| `bin/app.ts`（変更） | `AgentStack` の `runtime.agentRuntimeArn` を prop で `SlackBotStack` に渡す（同一 App 内クロススタック参照）。両スタックは独立デプロイ可能 |
| `package.json`（変更） | `esbuild` を devDependency に追加（`NodejsFunction` のバンドルに使用） |

- `NodejsFunction` はエントリ（`apps/consumer-slack/src/receiver.ts` / `worker.ts`）から esbuild で
  バンドルし、`@app/contract` をワークスペースのシンボリックリンク解決経由で取り込む。
  バンドル設定は参考プロジェクトに倣い `{ minify: true, target: 'node24' }`、ランタイムは `NODEJS_24_X`。
  consumer-slack は ESM のため、出力フォーマットは ESM（`OutputFormat.ESM`）で揃える。

## データフロー詳細

### 受信 Lambda

1. Function URL イベント（payload v2.0）から生ボディを復元（`isBase64Encoded` 対応）。
2. `verifySlackSignature` で HMAC + タイムスタンプ窓を検証。NG は **401**。
3. `decideEvent(rawBody, x-slack-retry-num)` で方針判定。
   - `challenge` → `200` で `{ challenge }` を JSON 返却。
   - `ignore` → `200`（ログのみ）。Slack 再送（`x-slack-retry-num` あり）は常に ignore（二重処理防止）。
   - `answer` → worker を `InvocationType=Event` で非同期起動し `200`。起動失敗時もログのみで `200`。

### decideEvent（純ロジック）の判定

`answer` の決定は worker ペイロードに必要な値をすべて含む。

- `app_mention`: `replyThreadTs = thread_ts ?? ts`、`sessionThreadTs = thread_ts ?? ts`。
- DM（`message.im`）: `replyThreadTs = undefined`（スレッド化しない）、
  `sessionThreadTs = channel`（DM チャンネル ID を使い DM 全体を 1 セッションとして継続させる）。
- `bot_id` / `subtype` 付きメッセージは ignore（無限ループ防止）。
- **テキスト空の扱い**: メンション除去後テキストが空でも、添付ファイルがあれば `answer` とする
  （ファイルのみの依頼を処理するため）。テキスト空かつファイルなしのときだけ ignore。

### worker ペイロード（受信 → 応答）

Lambda 非同期 Invoke のペイロード上限 256KB に収めるため、ファイルは**メタデータのみ**渡し、
ダウンロードは worker 側で行う。

```ts
interface WorkerPayload {
  teamId: string
  channel: string
  userId: string
  rawText: string            // メンションを含む生テキスト（除去は mapping 側）
  sessionThreadTs: string    // セッション導出用（DM では channel ID）
  replyThreadTs?: string     // chat.postMessage / uploadV2 の thread_ts（DM では undefined）
  files: { name: string; mimeType: string; urlPrivateDownload: string }[]
}
```

### 応答 Lambda（worker）

1. `files[].urlPrivateDownload` を bot token で認証ダウンロードし base64 化（`AgentFile[]`）。
2. `buildAgentRequest({ teamId, channel, threadTs: sessionThreadTs, userId, rawText, files })`。
   - `mapping.ts` は無改修。`threadTs` スロットに `sessionThreadTs` を渡すことで DM のセッション継続を実現。
3. `invokeAgent(req, { agentRuntimeArn, region })`。`agentRuntimeArn` は環境変数、`region` は `AWS_REGION`。
4. `toSlackMrkdwn` 変換後 `chat.postMessage`（`thread_ts = replyThreadTs`）。
5. 成果物があれば `client.files.uploadV2`（`thread_ts = replyThreadTs`、`file_uploads` で一括）。

## シークレット管理（Parameter Store SecureString）

**重要**: CloudFormation / CDK は SecureString パラメータを「作成」できない
（`AWS::SSM::Parameter` は SecureString 作成に非対応）。よって以下の運用とする。

- デプロイ前に CLI/コンソールで SecureString を**手動作成**する。
  - `/agentcore-slack/slack-bot/signing-secret`
  - `/agentcore-slack/slack-bot/bot-token`
- CDK は上記パラメータ ARN への `ssm:GetParameter` と、暗号化キー（既定 `aws/ssm`）への
  `kms:Decrypt` を Lambda 実行ロールに付与するのみ。
- Lambda はコールドスタート時に `GetParameter`(WithDecryption) で取得し、モジュールスコープにキャッシュする。

## IAM（アクセスキー全廃・実行ロールのみ）

- **受信 Lambda ロール**
  - worker への `lambda:InvokeFunction`
  - signing-secret の `ssm:GetParameter` + `kms:Decrypt`
- **応答 Lambda ロール**
  - bot-token の `ssm:GetParameter` + `kms:Decrypt`
  - runtime ARN スコープの `bedrock-agentcore:InvokeAgentRuntime`

## サイジングと信頼性

| 項目 | 受信 Lambda | 応答 Lambda(worker) |
| --- | --- | --- |
| timeout | 10s | 300s（AgentCore + Code Interpreter + ファイル I/O 想定） |
| memory | 256MB | 1024MB（base64 ファイルバッファ） |
| 同時実行 | `reservedConcurrentExecutions`（公開エンドポイントの課金上限ガード） | 既定 |
| retryAttempts | — | 0（非同期起動の自動リトライ無効化で二重投稿防止） |

- 注意: `reservedConcurrentExecutions` はアカウントの同時実行プールから確保される。
  同時実行クォータが小さいアカウントでは unreserved 最低 100 を割りデプロイ失敗しうる。

## エラーハンドリング

- 受信: 署名 NG→`401`、ignore→`200`、challenge→`200`(JSON)、worker 起動失敗→ログのみ `200`。
  常に 3 秒以内に応答する。
- 応答: 失敗時はスレッド/DM にエラーメッセージを **1 回だけ**投稿。投稿も失敗したらログのみ。

## テスト方針

vitest で純ロジックを SDK モックなしに単体テストする（テストはソースと同じディレクトリに `*.test.ts`）。

- `slack-verify.test.ts`: 正常署名 / 署名不一致 / タイムスタンプ窓外 / ヘッダ不足。
- `slack-event.test.ts`: challenge / 再送 ignore / bot・subtype ignore / app_mention（スレッド）/
  DM（非スレッド・channel セッション）/ テキスト空+ファイルあり→answer / テキスト空+ファイルなし→ignore。
- `mapping.test.ts` / `format.test.ts`: 既存テストを維持。

完了条件: `pnpm test` と `pnpm typecheck` の両方が通ること。

## スコープ外（YAGNI）

- Slack のインタラクティブ機能（ボタン・モーダル・スラッシュコマンド）。
- メッセージのストリーミング更新（`chat.update` による逐次反映）。
- シークレットの自動ローテーション。
- 受信 Lambda での DLQ / 失敗時の再試行設計（再送は一律 ignore する方針のため不要）。
