# Slack コンシューマーのサーバーレス移行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slack コンシューマーを Socket Mode 常駐から HTTP Events API + 2段 Lambda 構成へ移行し、アクセスキーを廃して実行ロールに統一する。

**Architecture:** 受信 Lambda（Function URL・署名検証・即 200 応答）が応答 Lambda（worker）を非同期起動し、worker が Slack ファイル DL → `invokeAgent`（AgentCore Runtime）→ mrkdwn 変換 → Slack 投稿を行う。署名検証とイベント判定は SDK 非依存の純ロジックとして切り出し、vitest で単体テストする。

**Tech Stack:** TypeScript (ESM), AWS Lambda (NODEJS_24_X), AWS CDK (`aws-cdk-lib`), `@slack/web-api`, `@aws-sdk/client-ssm`, `@aws-sdk/client-lambda`, SSM Parameter Store SecureString, vitest, pnpm workspace。

## Global Constraints

- リージョンは **`ap-northeast-1` 固定**。
- コメント・コミットメッセージ・テスト名はすべて**日本語**。Conventional Commits + 日本語説明、スコープにパッケージ名。
- ソースコメント規約: ファイル冒頭に `// ====` 概要ブロック、関数/型/定数の直前に一行コメント、処理ブロック先頭に一行コメント、型フィールドに行末コメント。
- テストはソースと同じディレクトリに `*.test.ts` として配置。純ロジックは SDK をモックせず単体テストする。
- 完了条件: `pnpm test` と `pnpm typecheck` の両方が通ること。
- Node ランタイムは Lambda が `NODEJS_24_X`、バンドルは `{ minify: true, target: 'node24' }`、出力フォーマットは ESM。
- SSM SecureString パラメータ名: `/agentcore-slack/slack-bot/signing-secret` / `/agentcore-slack/slack-bot/bot-token`。
- worker ペイロードは Lambda 非同期 Invoke の 256KB 上限を超えないよう、ファイルは**メタデータのみ**渡す。
- 既存の純ロジック `apps/consumer-slack/src/mapping.ts` / `format.ts` は**無改修**で再利用する。

---

## File Structure

- `apps/consumer-slack/src/slack-verify.ts`（新規・純ロジック）+ `.test.ts` — HMAC 署名検証。
- `apps/consumer-slack/src/slack-event.ts`（新規・純ロジック）+ `.test.ts` — `decideEvent`（challenge/ignore/answer 判定、app_mention + DM）。
- `apps/consumer-slack/src/receiver.ts`（新規・SDK 層ハンドラ） — 署名検証 → decideEvent → worker 非同期起動。
- `apps/consumer-slack/src/worker.ts`（新規・SDK 層ハンドラ） — ファイル DL → invokeAgent → Slack 投稿。
- `apps/consumer-slack/src/app.ts`（削除） — Socket Mode 実装。
- `apps/consumer-slack/package.json`（変更） — 依存差し替え・スクリプト整理。
- `apps/consumer-slack/.env.example`（変更） — Socket Mode 用変数を除去。
- `infra/lib/slack-bot-stack.ts`（新規） — Lambda ×2・Function URL・IAM・SSM 読み取り権限。
- `infra/bin/app.ts`（変更） — `SlackBotStack` を `AgentStack` の runtime ARN で配線。
- `infra/package.json`（変更） — `esbuild` を devDependency に追加。
- `README.md` / `CLAUDE.md`（変更） — デプロイ/起動手順とデータフローを更新。

---

## Task 1: 依存とエントリの整理（Socket Mode 撤去）

**Files:**
- Modify: `apps/consumer-slack/package.json`
- Modify: `apps/consumer-slack/.env.example`
- Delete: `apps/consumer-slack/src/app.ts`

**Interfaces:**
- Consumes: なし
- Produces: 以後のタスクで使う依存（`@slack/web-api` / `@aws-sdk/client-ssm` / `@aws-sdk/client-lambda`）が利用可能になる。

- [ ] **Step 1: Socket Mode のエントリを削除**

```bash
git rm apps/consumer-slack/src/app.ts
```

- [ ] **Step 2: package.json を編集**

`apps/consumer-slack/package.json` を以下に置き換える（`@slack/bolt` と `dev` スクリプトを除去、新規依存を追加）。

```json
{
  "name": "@app/consumer-slack",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@app/contract": "workspace:*",
    "@aws-sdk/client-lambda": "^3.0.0",
    "@aws-sdk/client-ssm": "^3.0.0",
    "@slack/web-api": "^7.0.0",
    "slackify-markdown": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0"
  }
}
```

- [ ] **Step 3: .env.example を更新**

`apps/consumer-slack/.env.example` を以下に置き換える（Socket Mode の `SLACK_APP_TOKEN` を除去。ローカル直接起動はしなくなるため AWS_PROFILE 等の記述も整理）。

```
# Lambda 実行時は実行ロールから認証情報が供給されるため、これらの値の設定は不要。
# デプロイ後の手動投入は SSM SecureString パラメータに対して行う:
#   /agentcore-slack/slack-bot/signing-secret  (Slack App の Signing Secret)
#   /agentcore-slack/slack-bot/bot-token        (xoxb- で始まる Bot User OAuth Token)
```

- [ ] **Step 4: 依存をインストールして型チェック**

Run: `pnpm install && pnpm --filter @app/consumer-slack typecheck`
Expected: インストール成功。`app.ts` 参照が無くなったため typecheck はエラーなく通る（この時点で他の新規ファイルは未作成だが consumer-slack に残るのは mapping/format のみ）。

- [ ] **Step 5: Commit**

```bash
git add apps/consumer-slack/package.json apps/consumer-slack/.env.example pnpm-lock.yaml
git commit -m "chore(consumer-slack): Socket Mode を撤去し依存を Lambda 向けに差し替え"
```

---

## Task 2: slack-verify.ts（署名検証・純ロジック）

**Files:**
- Create: `apps/consumer-slack/src/slack-verify.ts`
- Test: `apps/consumer-slack/src/slack-verify.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `type VerifyResult = { ok: true } | { ok: false; reason: string }`
  - `function verifySlackSignature(params: { signingSecret: string; body: string; timestamp: string | undefined; signature: string | undefined; nowEpochSec?: number }): VerifyResult`

- [ ] **Step 1: 失敗するテストを書く**

`apps/consumer-slack/src/slack-verify.test.ts`:

```ts
// =============================================================================
// verifySlackSignature の署名検証・タイムスタンプ窓・ヘッダ欠落の単体テスト。
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifySlackSignature } from './slack-verify'

// テスト用に正しい署名を生成するヘルパ。
function sign(secret: string, ts: string, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`
}

describe('verifySlackSignature', () => {
  const secret = 'shhh'
  const body = '{"type":"event_callback"}'
  const now = 1_700_000_000

  it('正しい署名とタイムスタンプを受理する', () => {
    const ts = String(now)
    const res = verifySlackSignature({ signingSecret: secret, body, timestamp: ts, signature: sign(secret, ts, body), nowEpochSec: now })
    expect(res).toEqual({ ok: true })
  })

  it('署名が一致しない場合は拒否する', () => {
    const ts = String(now)
    const res = verifySlackSignature({ signingSecret: secret, body, timestamp: ts, signature: 'v0=deadbeef', nowEpochSec: now })
    expect(res.ok).toBe(false)
  })

  it('タイムスタンプが許容窓(±5分)を超える場合は拒否する', () => {
    const ts = String(now - 600)
    const res = verifySlackSignature({ signingSecret: secret, body, timestamp: ts, signature: sign(secret, ts, body), nowEpochSec: now })
    expect(res.ok).toBe(false)
  })

  it('必須ヘッダが欠落している場合は拒否する', () => {
    const res = verifySlackSignature({ signingSecret: secret, body, timestamp: undefined, signature: undefined, nowEpochSec: now })
    expect(res.ok).toBe(false)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run apps/consumer-slack/src/slack-verify.test.ts`
Expected: FAIL（`verifySlackSignature` が未定義 / import 解決失敗）。

- [ ] **Step 3: 実装を書く**

`apps/consumer-slack/src/slack-verify.ts`:

```ts
// =============================================================================
// Slack リクエストの署名検証を行う純ロジック層。
// HMAC-SHA256 による署名比較に加え、タイムスタンプの新しさを確認して
// リプレイ攻撃を防ぐ。SDK 呼び出しは一切含まない。
// =============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto'

// 検証結果(失敗時は理由を持つ)
export type VerifyResult = { ok: true } | { ok: false; reason: string }

// 許容する時刻ずれ(秒)。これを超えるリクエストはリプレイ攻撃とみなす。
const MAX_CLOCK_SKEW_SEC = 300

// Slack の署名仕様(v0)に従い、リクエストの正当性を検証する。
export function verifySlackSignature(params: {
  signingSecret: string          // Slack アプリの signing secret
  body: string                   // 生のリクエストボディ(JSON 解析前)
  timestamp: string | undefined  // x-slack-request-timestamp ヘッダ
  signature: string | undefined  // x-slack-signature ヘッダ
  nowEpochSec?: number           // テスト用に現在時刻(epoch 秒)を注入可能
}): VerifyResult {
  const { signingSecret, body, timestamp, signature } = params
  // 必須ヘッダの存在チェック。
  if (!timestamp || !signature) return { ok: false, reason: 'ヘッダ不足' }
  // タイムスタンプ窓チェック(±5 分)。
  const now = params.nowEpochSec ?? Math.floor(Date.now() / 1000)
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_SEC) {
    return { ok: false, reason: 'タイムスタンプが許容範囲外' }
  }
  // HMAC-SHA256 で署名を再計算して比較(タイミング攻撃対策に timingSafeEqual を使う)。
  const base = `v0:${timestamp}:${body}`
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  // timingSafeEqual は等長バッファ必須のため長さ不一致は先に弾く。
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: '署名不一致' }
  }
  return { ok: true }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run apps/consumer-slack/src/slack-verify.test.ts`
Expected: PASS（4 件）。

- [ ] **Step 5: Commit**

```bash
git add apps/consumer-slack/src/slack-verify.ts apps/consumer-slack/src/slack-verify.test.ts
git commit -m "feat(consumer-slack): Slack 署名検証の純ロジックを追加"
```

---

## Task 3: slack-event.ts（イベント判定・純ロジック）

**Files:**
- Create: `apps/consumer-slack/src/slack-event.ts`
- Test: `apps/consumer-slack/src/slack-event.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `interface SlackFileRef { name: string; mimeType: string; urlPrivateDownload: string }`
  - `interface AnswerDecision { action: 'answer'; teamId: string; channel: string; userId: string; rawText: string; sessionThreadTs: string; replyThreadTs?: string; files: SlackFileRef[] }`
  - `type EventDecision = { action: 'challenge'; challenge: string } | { action: 'ignore'; reason: string } | AnswerDecision`
  - `function decideEvent(rawBody: string, retryNum: string | undefined): EventDecision`

- [ ] **Step 1: 失敗するテストを書く**

`apps/consumer-slack/src/slack-event.test.ts`:

```ts
// =============================================================================
// decideEvent の判定(challenge / 再送 / bot・subtype / app_mention / DM /
// テキスト空+ファイル有無)の単体テスト。
// =============================================================================
import { describe, it, expect } from 'vitest'
import { decideEvent } from './slack-event'

// event_callback 形式のボディを組み立てるヘルパ。
function callback(event: Record<string, unknown>, teamId = 'T1'): string {
  return JSON.stringify({ type: 'event_callback', team_id: teamId, event })
}

describe('decideEvent', () => {
  it('url_verification には challenge を返す', () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' })
    expect(decideEvent(body, undefined)).toEqual({ action: 'challenge', challenge: 'abc' })
  })

  it('再送(retryNum あり)は無視する', () => {
    expect(decideEvent(callback({ type: 'app_mention', text: 'x' }), '1').action).toBe('ignore')
  })

  it('bot 発言やサブタイプ付きメッセージは無視する', () => {
    expect(decideEvent(callback({ type: 'message', bot_id: 'B1', channel_type: 'im' }), undefined).action).toBe('ignore')
    expect(decideEvent(callback({ type: 'message', subtype: 'message_changed', channel_type: 'im' }), undefined).action).toBe('ignore')
  })

  it('app_mention はスレッド返信(replyThreadTs = thread_ts ?? ts)で answer になる', () => {
    const d = decideEvent(callback({ type: 'app_mention', text: '<@U1> hi', channel: 'C1', user: 'U9', ts: '111.1' }), undefined)
    expect(d).toMatchObject({
      action: 'answer', teamId: 'T1', channel: 'C1', userId: 'U9',
      rawText: '<@U1> hi', sessionThreadTs: '111.1', replyThreadTs: '111.1', files: [],
    })
  })

  it('DM(message.im) は非スレッド・channel をセッションキーにして answer になる', () => {
    const d = decideEvent(callback({ type: 'message', channel_type: 'im', text: 'hi', channel: 'D1', user: 'U9', ts: '222.2' }), undefined)
    expect(d).toMatchObject({ action: 'answer', channel: 'D1', sessionThreadTs: 'D1', files: [] })
    expect((d as { replyThreadTs?: string }).replyThreadTs).toBeUndefined()
  })

  it('テキストが空でもファイルがあれば answer にする', () => {
    const files = [{ name: 'a.csv', mimetype: 'text/csv', url_private_download: 'https://x/a.csv' }]
    const d = decideEvent(callback({ type: 'app_mention', text: '<@U1>', channel: 'C1', user: 'U9', ts: '1.1', files }), undefined)
    expect(d.action).toBe('answer')
    expect((d as { files: unknown[] }).files).toEqual([{ name: 'a.csv', mimeType: 'text/csv', urlPrivateDownload: 'https://x/a.csv' }])
  })

  it('テキスト空かつファイル無しは無視する', () => {
    const d = decideEvent(callback({ type: 'app_mention', text: '<@U1>', channel: 'C1', user: 'U9', ts: '1.1' }), undefined)
    expect(d.action).toBe('ignore')
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run apps/consumer-slack/src/slack-event.test.ts`
Expected: FAIL（`decideEvent` 未定義）。

- [ ] **Step 3: 実装を書く**

`apps/consumer-slack/src/slack-event.ts`:

```ts
// =============================================================================
// Slack Events API のリクエストボディから「どう処理すべきか」を判定する純ロジック層。
// challenge 応答 / 無視(再送・bot 発言など) / 回答(answer)の 3 択に分類し、
// SDK 呼び出しは一切含まない。app_mention とボットとの DM(message.im) を対象とする。
// =============================================================================

// worker に渡すファイル参照(本体はダウンロードせずメタデータのみ)。
export interface SlackFileRef {
  name: string               // ファイル名
  mimeType: string           // MIME タイプ
  urlPrivateDownload: string // bot トークンで認証して取得する非公開 URL
}

// 応答 Lambda に委譲する決定。worker ペイロードに必要な値をすべて含む。
export interface AnswerDecision {
  action: 'answer'
  teamId: string             // Slack ワークスペース ID(セッション導出の一部)
  channel: string            // 返信先チャンネル(DM 含む)
  userId: string             // 発言者の ID
  rawText: string            // メンションを含む生テキスト(除去は mapping 側)
  sessionThreadTs: string    // セッション導出用(DM では channel ID)
  replyThreadTs?: string     // 返信の thread_ts(DM では undefined=非スレッド)
  files: SlackFileRef[]      // 添付ファイルのメタデータ一覧
}

// イベントの処理方針を表す判別共用体。
export type EventDecision =
  | { action: 'challenge'; challenge: string } // URL 検証に応答する
  | { action: 'ignore'; reason: string }       // 処理せず 200 を返す
  | AnswerDecision                             // 応答 Lambda に委譲する

// Slack のファイルオブジェクト配列を SlackFileRef[] に正規化する。
function toFileRefs(files: unknown): SlackFileRef[] {
  if (!Array.isArray(files)) return []
  return files
    .map((f) => ({ name: String(f?.name ?? ''), mimeType: String(f?.mimetype ?? ''), urlPrivateDownload: String(f?.url_private_download ?? '') }))
    .filter((f) => f.urlPrivateDownload !== '')
}

// メンション(<@UXXXX>)を除去したテキストが実質空かどうかを判定する。
function isTextEmpty(rawText: string): boolean {
  return rawText.replace(/<@[^>]+>/g, '').trim() === ''
}

// 生ボディと再送ヘッダ(x-slack-retry-num)から処理方針を判定する。
export function decideEvent(rawBody: string, retryNum: string | undefined): EventDecision {
  // Slack の再送は無視する(初回で処理済みのため。二重応答防止)。
  if (retryNum !== undefined) return { action: 'ignore', reason: `再送 (retry=${retryNum})` }

  // ボディの JSON 解析(不正な形式は無視)。
  let body: any
  try {
    body = JSON.parse(rawBody)
  } catch {
    return { action: 'ignore', reason: 'JSON 解析失敗' }
  }

  // Events URL 登録時の URL 検証(challenge をそのまま返す必要がある)。
  if (body?.type === 'url_verification' && typeof body.challenge === 'string') {
    return { action: 'challenge', challenge: body.challenge }
  }
  if (body?.type !== 'event_callback' || !body.event) {
    return { action: 'ignore', reason: '対象外タイプ' }
  }

  const ev = body.event
  const teamId = String(body.team_id ?? 'unknown')
  // bot 自身の発言・サブタイプ付きメッセージは無視(無限ループ防止)。
  if (ev.bot_id || ev.subtype) return { action: 'ignore', reason: 'bot またはサブタイプ付きメッセージ' }

  const rawText = String(ev.text ?? '')
  const files = toFileRefs(ev.files)
  // メンションのみ等でテキストが空でも、添付ファイルがあれば処理する。
  if (isTextEmpty(rawText) && files.length === 0) {
    return { action: 'ignore', reason: 'テキスト空かつファイル無し' }
  }

  // チャンネルでのメンション: スレッドで返信し、セッションもスレッド単位にする。
  if (ev.type === 'app_mention') {
    const threadTs = String(ev.thread_ts ?? ev.ts)
    return { action: 'answer', teamId, channel: String(ev.channel), userId: String(ev.user), rawText, sessionThreadTs: threadTs, replyThreadTs: threadTs, files }
  }

  // bot との DM: 非スレッド返信。DM 全体を 1 セッションにするため channel をセッションキーにする。
  if (ev.type === 'message' && ev.channel_type === 'im') {
    return { action: 'answer', teamId, channel: String(ev.channel), userId: String(ev.user), rawText, sessionThreadTs: String(ev.channel), replyThreadTs: undefined, files }
  }

  return { action: 'ignore', reason: `対象外イベント (${ev.type})` }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run apps/consumer-slack/src/slack-event.test.ts`
Expected: PASS（7 件）。

- [ ] **Step 5: Commit**

```bash
git add apps/consumer-slack/src/slack-event.ts apps/consumer-slack/src/slack-event.test.ts
git commit -m "feat(consumer-slack): Slack イベント判定(app_mention/DM)の純ロジックを追加"
```

---

## Task 4: worker.ts（応答 Lambda ハンドラ）

**Files:**
- Create: `apps/consumer-slack/src/worker.ts`

**Interfaces:**
- Consumes:
  - `@app/contract` の `invokeAgent(req, { agentRuntimeArn, region })`、型 `AgentFile`。
  - `./mapping` の `buildAgentRequest({ teamId, channel, threadTs, userId, rawText, files })`。
  - `./format` の `toSlackMrkdwn(markdown)`。
  - `./slack-event` の `SlackFileRef`。
- Produces:
  - `interface WorkerPayload { teamId: string; channel: string; userId: string; rawText: string; sessionThreadTs: string; replyThreadTs?: string; files: SlackFileRef[] }`
  - `async function handler(event: WorkerPayload): Promise<void>`

> このタスクは SDK 呼び出しのオーケストレーションが中心で、純ロジック(mapping/format/slack-event)は既存テストで担保済みのため、worker 自体の単体テストは設けない（参考プロジェクトの worker と同方針）。検証は `pnpm typecheck`。

- [ ] **Step 1: 実装を書く**

`apps/consumer-slack/src/worker.ts`:

```ts
// =============================================================================
// Slack への応答ハンドラ(SDK 呼び出し層)。受信 Lambda から非同期起動され、
// 添付ファイルをダウンロード → invokeAgent(AgentCore Runtime)→ mrkdwn 変換 →
// Slack 投稿(テキスト + 成果物)を行う。非同期起動の自動リトライは 0 のため、
// エラー通知はここで 1 回だけ行う。
// =============================================================================
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { WebClient } from '@slack/web-api'
import { invokeAgent, type AgentFile } from '@app/contract'
import { buildAgentRequest } from './mapping'
import { toSlackMrkdwn } from './format'
import type { SlackFileRef } from './slack-event'

// 受信 Lambda から非同期 Invoke で渡される処理依頼。
export interface WorkerPayload {
  teamId: string             // Slack ワークスペース ID
  channel: string            // 返信先チャンネル(DM 含む)
  userId: string             // 発言者の ID
  rawText: string            // メンションを含む生テキスト
  sessionThreadTs: string    // セッション導出用(DM では channel ID)
  replyThreadTs?: string     // 返信の thread_ts(DM では undefined)
  files: SlackFileRef[]      // 添付ファイルのメタデータ一覧
}

// AWS SDK クライアント(コールドスタート時に 1 度だけ生成して再利用)。
const region = process.env.AWS_REGION ?? 'ap-northeast-1'
const ssm = new SSMClient({ region })
const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN!

// bot token のキャッシュ(コールドスタート後は再利用)。
let cachedBotToken: string | undefined

// SSM SecureString から bot token を復号取得する。
async function getBotToken(): Promise<string> {
  if (cachedBotToken) return cachedBotToken
  const out = await ssm.send(new GetParameterCommand({ Name: process.env.SLACK_BOT_TOKEN_PARAM!, WithDecryption: true }))
  const value = out.Parameter?.Value
  if (!value) throw new Error('SSM に bot token がありません')
  cachedBotToken = value
  return value
}

// Slack のファイルメタデータを bot トークンで認証ダウンロードし base64 AgentFile 化する。
async function downloadFiles(files: SlackFileRef[], token: string): Promise<AgentFile[]> {
  const out: AgentFile[] = []
  for (const f of files) {
    const res = await fetch(f.urlPrivateDownload, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) continue
    const buf = Buffer.from(await res.arrayBuffer())
    out.push({ name: f.name, mimeType: f.mimeType, data: buf.toString('base64') })
  }
  return out
}

// ハンドラ本体。失敗時はエラーメッセージを 1 回だけ投稿し、それも失敗したらログのみ。
export async function handler(event: WorkerPayload): Promise<void> {
  const token = await getBotToken()
  const web = new WebClient(token)
  try {
    // 添付ファイルをダウンロードして AgentRequest を組み立てる。
    const files = await downloadFiles(event.files, token)
    const req = buildAgentRequest({
      teamId: event.teamId,
      channel: event.channel,
      threadTs: event.sessionThreadTs,
      userId: event.userId,
      rawText: event.rawText,
      files,
    })
    // AgentCore Runtime を呼び出す。
    const res = await invokeAgent(req, { agentRuntimeArn, region })
    // Markdown を Slack mrkdwn に変換して投稿する。
    await web.chat.postMessage({ channel: event.channel, thread_ts: event.replyThreadTs, text: toSlackMrkdwn(res.text ?? '') || '(空の応答)' })
    // 成果物があれば file_uploads でまとめて 1 回でアップロードする。
    const artifacts = res.artifacts ?? []
    if (artifacts.length > 0) {
      await web.files.uploadV2({
        channel_id: event.channel,
        thread_ts: event.replyThreadTs,
        file_uploads: artifacts.map((a) => ({ filename: a.name, file: Buffer.from(a.data, 'base64') })),
      })
    }
  } catch (e) {
    console.error(`応答処理に失敗: ${(e as Error).message}`)
    try {
      await web.chat.postMessage({ channel: event.channel, thread_ts: event.replyThreadTs, text: `エラーが発生しました: ${(e as Error).message}` })
    } catch (e2) {
      console.error(`エラーメッセージの投稿にも失敗: ${(e2 as Error).message}`)
    }
  }
}
```

- [ ] **Step 2: 型チェック**

Run: `pnpm --filter @app/consumer-slack typecheck`
Expected: エラーなし。

- [ ] **Step 3: Commit**

```bash
git add apps/consumer-slack/src/worker.ts
git commit -m "feat(consumer-slack): 応答 Lambda worker(ファイルDL→invokeAgent→Slack投稿)を追加"
```

---

## Task 5: receiver.ts（受信 Lambda ハンドラ）

**Files:**
- Create: `apps/consumer-slack/src/receiver.ts`

**Interfaces:**
- Consumes:
  - `./slack-verify` の `verifySlackSignature`。
  - `./slack-event` の `decideEvent`、`AnswerDecision`。
  - `./worker` の `WorkerPayload`。
- Produces:
  - `async function handler(event: FunctionUrlEvent): Promise<HttpResponse>`（Function URL 用ハンドラ）

> SDK オーケストレーション中心のため単体テストは設けない（純ロジックは Task 2/3 で担保）。検証は `pnpm typecheck`。

- [ ] **Step 1: 実装を書く**

`apps/consumer-slack/src/receiver.ts`:

```ts
// =============================================================================
// Slack Events API の受信ハンドラ(SDK 呼び出し層)。Function URL 経由で受け、
// 署名検証 → イベント判定(純ロジック)→ 応答 Lambda の非同期起動だけを行い、
// Slack の 3 秒制約内に必ず応答を返す。重い処理は worker.ts に委譲する。
// 再送はすべて弾く方針のため、起動失敗時も 500 にせずログのみで 200 を返す。
// =============================================================================
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { verifySlackSignature } from './slack-verify'
import { decideEvent } from './slack-event'
import type { WorkerPayload } from './worker'

// Lambda Function URL(payload v2.0)のイベントのうち、本処理で使う部分だけの型。
interface FunctionUrlEvent {
  headers: Record<string, string | undefined> // ヘッダ名は小文字に正規化されている
  body?: string                                // リクエストボディ
  isBase64Encoded?: boolean                    // ボディが base64 化されているか
}

// Function URL へ返す HTTP レスポンス。
interface HttpResponse {
  statusCode: number // HTTP ステータスコード
  body?: string      // レスポンスボディ
}

// AWS SDK クライアント(コールドスタート時に 1 度だけ生成して再利用)。
const region = process.env.AWS_REGION ?? 'ap-northeast-1'
const ssm = new SSMClient({ region })
const lambdaClient = new LambdaClient({ region })

// signing secret のキャッシュ(コールドスタート後は再利用)。
let cachedSigningSecret: string | undefined

// SSM SecureString から signing secret を復号取得する。
async function getSigningSecret(): Promise<string> {
  if (cachedSigningSecret) return cachedSigningSecret
  const out = await ssm.send(new GetParameterCommand({ Name: process.env.SLACK_SIGNING_SECRET_PARAM!, WithDecryption: true }))
  const value = out.Parameter?.Value
  if (!value) throw new Error('SSM に signing secret がありません')
  cachedSigningSecret = value
  return value
}

// ハンドラ本体。3 秒制約内に必ず 200/401 を返す。
export async function handler(event: FunctionUrlEvent): Promise<HttpResponse> {
  // 生ボディを復元する(署名検証は加工前のボディに対して行う必要がある)。
  const body = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '')

  // 署名検証(HMAC + タイムスタンプ窓)。NG は 401 で終了。
  const verify = verifySlackSignature({
    signingSecret: await getSigningSecret(),
    body,
    timestamp: event.headers['x-slack-request-timestamp'],
    signature: event.headers['x-slack-signature'],
  })
  if (!verify.ok) {
    console.warn(`署名検証 NG: ${verify.reason}`)
    return { statusCode: 401 }
  }

  // イベント判定(challenge / 無視 / 回答)。
  const decision = decideEvent(body, event.headers['x-slack-retry-num'])
  // challenge は JSON でラップして返す(Function URL の既定 Content-Type が application/json のため)。
  if (decision.action === 'challenge') {
    return { statusCode: 200, body: JSON.stringify({ challenge: decision.challenge }) }
  }
  if (decision.action === 'ignore') {
    console.log(`無視: ${decision.reason}`)
    return { statusCode: 200 }
  }

  // 応答 Lambda を非同期起動(失敗してもログのみ。再送は弾く方針のため再試行しない)。
  const payload: WorkerPayload = {
    teamId: decision.teamId,
    channel: decision.channel,
    userId: decision.userId,
    rawText: decision.rawText,
    sessionThreadTs: decision.sessionThreadTs,
    replyThreadTs: decision.replyThreadTs,
    files: decision.files,
  }
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: process.env.WORKER_FUNCTION_NAME!,
      InvocationType: 'Event',
      Payload: JSON.stringify(payload),
    }))
  } catch (e) {
    console.error(`応答 Lambda の起動失敗: ${(e as Error).message}`)
  }
  return { statusCode: 200 }
}
```

- [ ] **Step 2: 型チェックと全テスト**

Run: `pnpm --filter @app/consumer-slack typecheck && pnpm test`
Expected: typecheck エラーなし。`pnpm test` は slack-verify(4) / slack-event(7) / mapping / format がすべて PASS。

- [ ] **Step 3: Commit**

```bash
git add apps/consumer-slack/src/receiver.ts
git commit -m "feat(consumer-slack): 受信 Lambda receiver(署名検証→worker 非同期起動)を追加"
```

---

## Task 6: infra に SlackBotStack を追加して配線

**Files:**
- Create: `infra/lib/slack-bot-stack.ts`
- Modify: `infra/bin/app.ts`
- Modify: `infra/package.json`

**Interfaces:**
- Consumes: `AgentStack` の `runtime.agentRuntimeArn`（`agent-stack.ts` の CfnOutput で公開済みの値）。
- Produces: `class SlackBotStack extends Stack`（コンストラクタ props に `agentRuntimeArn: string`）。

- [ ] **Step 1: AgentStack が ARN を public プロパティで渡せるようにする**

`infra/lib/agent-stack.ts` を編集し、`runtime` の ARN を読めるよう public フィールドを追加する。クラス内のフィールド宣言を追加し、`runtime` 作成直後に代入する。

`export class AgentStack extends Stack {` の直後に追加:

```ts
  // SlackBotStack から参照するための AgentCore Runtime ARN。
  public readonly agentRuntimeArn: string
```

`const runtime = new agentcore.Runtime(...)` の `})` の直後（IAM 付与より前）に追加:

```ts
    // 他スタックが参照できるよう ARN を公開する。
    this.agentRuntimeArn = runtime.agentRuntimeArn
```

- [ ] **Step 2: SlackBotStack を作成**

`infra/lib/slack-bot-stack.ts`:

```ts
// =============================================================================
// Slack コンシューマーをサーバーレス化する CDK スタック。
// 受信 Lambda(Function URL・3 秒制約内応答)と応答 Lambda(AgentCore 呼び出し + Slack 投稿)
// の 2 段構成。Slack トークンは事前手動作成済みの SSM SecureString から読み取る。
// AgentStack とは独立に `cdk deploy SlackBot` で選択デプロイできる。
// =============================================================================
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Stack, type StackProps, Duration, CfnOutput } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs'
import { OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'

// このファイル(infra/lib)から見たリポジトリルート。Lambda エントリの基点。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// SlackBotStack のデプロイ時パラメータ。
export interface SlackBotStackProps extends StackProps {
  readonly agentRuntimeArn: string // 呼び出し先 AgentCore Runtime の ARN
}

// 事前手動作成する SSM SecureString パラメータ名(CFn は SecureString を作成できないため参照のみ)。
const SIGNING_SECRET_PARAM = '/agentcore-slack/slack-bot/signing-secret'
const BOT_TOKEN_PARAM = '/agentcore-slack/slack-bot/bot-token'

// Slack サーバーレスコンシューマー一式を定義するスタック。
export class SlackBotStack extends Stack {
  constructor(scope: Construct, id: string, props: SlackBotStackProps) {
    super(scope, id, props)

    // SSM SecureString パラメータの ARN(読み取り権限のスコープに使う)。
    const paramArn = (name: string) => `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`

    // NodejsFunction 共通のバンドル設定。ESM 出力・minify・node24 ターゲット。
    const commonBundling = { minify: true, target: 'node24', format: OutputFormat.ESM }
    const depsLockFilePath = path.join(repoRoot, 'pnpm-lock.yaml')

    // --- 応答 Lambda(ファイル DL → invokeAgent → Slack 投稿) ---
    // 非同期起動の自動リトライは 0(失敗時の二重投稿防止)。AgentCore + Code Interpreter
    // を待つため timeout を長く、base64 バッファ用に memory も大きめに取る。
    const workerFn = new lambdaNode.NodejsFunction(this, 'WorkerFunction', {
      entry: path.join(repoRoot, 'apps/consumer-slack/src/worker.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: Duration.seconds(300),
      memorySize: 1024,
      retryAttempts: 0,
      depsLockFilePath,
      environment: {
        AGENT_RUNTIME_ARN: props.agentRuntimeArn,
        SLACK_BOT_TOKEN_PARAM: BOT_TOKEN_PARAM,
      },
      bundling: commonBundling,
    })
    // bot token の読み取り(SecureString 復号含む)。
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [paramArn(BOT_TOKEN_PARAM)],
    }))
    // AgentCore Runtime の呼び出し。
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [props.agentRuntimeArn, `${props.agentRuntimeArn}/*`],
    }))
    // SecureString 復号用 KMS。既定の aws/ssm キー経由のみに限定する。
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    }))

    // --- 受信 Lambda(署名検証 → 応答 Lambda の非同期起動) ---
    // 公開エンドポイントのため reserved concurrency で同時実行を絞る。
    const receiverFn = new lambdaNode.NodejsFunction(this, 'ReceiverFunction', {
      entry: path.join(repoRoot, 'apps/consumer-slack/src/receiver.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: Duration.seconds(10),
      memorySize: 256,
      reservedConcurrentExecutions: 5,
      depsLockFilePath,
      environment: {
        WORKER_FUNCTION_NAME: workerFn.functionName,
        SLACK_SIGNING_SECRET_PARAM: SIGNING_SECRET_PARAM,
      },
      bundling: commonBundling,
    })
    // signing secret の読み取り(SecureString 復号含む)。
    receiverFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [paramArn(SIGNING_SECRET_PARAM)],
    }))
    receiverFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    }))
    // 受信が応答 Lambda を起動できるようにする。
    workerFn.grantInvoke(receiverFn)

    // --- Slack の Events Request URL になる Function URL(認可は署名検証で担保) ---
    const fnUrl = receiverFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE })

    // --- デプロイ後に参照する値を出力 ---
    new CfnOutput(this, 'SlackEventsUrl', { value: fnUrl.url })
  }
}
```

- [ ] **Step 3: bin/app.ts を配線**

`infra/bin/app.ts` を以下に置き換える。

```ts
// =============================================================================
// CDK アプリケーションのエントリポイント。AgentStack と SlackBotStack を
// ap-northeast-1 にデプロイする。SlackBotStack は AgentStack の Runtime ARN を受け取る。
// =============================================================================
import { App } from 'aws-cdk-lib'
import { AgentStack } from '../lib/agent-stack.js'
import { SlackBotStack } from '../lib/slack-bot-stack.js'

const app = new App()
// 配置先リージョン(環境変数未設定時は ap-northeast-1)。
const env = {
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
  account: process.env.CDK_DEFAULT_ACCOUNT,
}

// AgentCore Runtime 本体。
const agent = new AgentStack(app, 'AgentcoreSlackAgent', { env })

// Slack サーバーレスコンシューマー。Runtime ARN を prop で受け取る(クロススタック参照)。
new SlackBotStack(app, 'AgentcoreSlackBot', {
  env,
  agentRuntimeArn: agent.agentRuntimeArn,
})
```

- [ ] **Step 4: infra/package.json に esbuild を追加**

`infra/package.json` の `devDependencies` に `esbuild` を追加する（`NodejsFunction` がローカルバンドルに使用。未導入だと Docker バンドルにフォールバックする）。

```json
  "devDependencies": {
    "aws-cdk": "^2.160.0",
    "aws-cdk-lib": "^2.160.0",
    "esbuild": "^0.23.0",
    "tsx": "^4.16.0"
  }
```

- [ ] **Step 5: インストールと synth で検証**

Run: `pnpm install && pnpm --filter @app/infra typecheck && pnpm --filter @app/infra run synth`
Expected: typecheck エラーなし。`cdk synth` が両スタック（`AgentcoreSlackAgent` / `AgentcoreSlackBot`）を出力し、worker/receiver の esbuild バンドルが成功する。

- [ ] **Step 6: Commit**

```bash
git add infra/lib/slack-bot-stack.ts infra/lib/agent-stack.ts infra/bin/app.ts infra/package.json pnpm-lock.yaml
git commit -m "feat(infra): Slack サーバーレス用 SlackBotStack(2段 Lambda + Function URL)を追加"
```

---

## Task 7: ドキュメント更新

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: なし
- Produces: なし

- [ ] **Step 1: CLAUDE.md を更新**

`CLAUDE.md` 内の以下を反映する（該当箇所を編集）。

1. 「Slack コンシューマーのローカル起動」節の `pnpm --filter @app/consumer-slack dev` 記述を削除し、代わりにデプロイ手順へ置き換える:

```bash
# Slack サーバーレスコンシューマーのデプロイ(受信/応答 Lambda + Function URL)
pnpm --filter @app/infra run deploy   # AgentcoreSlackAgent と AgentcoreSlackBot を作成
```

2. データフロー図の冒頭 `Slack (app_mention)` 〜 consumer-slack 部分を、受信/応答 2段 Lambda 構成に書き換える（spec のアーキテクチャ図に準拠）。

3. 「重要な制約・落とし穴」に以下 2 項目を追記:

```
- **SSM SecureString は CDK で作成できない** — `/agentcore-slack/slack-bot/signing-secret` と `/agentcore-slack/slack-bot/bot-token` はデプロイ前に `aws ssm put-parameter --type SecureString` で手動作成する。CDK は参照と読み取り権限付与のみ。
- **Slack コンシューマーはアクセスキー不要** — Lambda 実行ロールの一時クレデンシャルで AgentCore を呼ぶ。受信は署名検証で認可し、再送(x-slack-retry-num)は一律 ignore する。
```

4. ワークスペース構成表の `apps/consumer-slack` 行の責務を「Slack Bolt (Socket Mode)」から「Slack Events API(Function URL)を受ける受信/応答 2段 Lambda」に更新。

- [ ] **Step 2: README.md を更新**

`README.md` の Slack セットアップ/起動に関する記述を Socket Mode から Events API へ更新する。具体的には:

1. Socket Mode・App-Level Token(`SLACK_APP_TOKEN`)前提の記述を、Events API + Function URL 前提に変更。
2. デプロイ後に出力される `SlackEventsUrl`（CfnOutput）を Slack アプリの Event Subscriptions の Request URL に設定する手順を追記。
3. 購読イベントとして `app_mention` と `message.im`(DM) を有効化し、必要スコープ(`app_mentions:read`, `im:history`, `chat:write`, `files:read`, `files:write`)を記載。
4. SSM SecureString の手動作成コマンド例を追記:

```bash
aws ssm put-parameter --region ap-northeast-1 --type SecureString \
  --name /agentcore-slack/slack-bot/signing-secret --value '<Signing Secret>'
aws ssm put-parameter --region ap-northeast-1 --type SecureString \
  --name /agentcore-slack/slack-bot/bot-token --value 'xoxb-...'
```

- [ ] **Step 3: 全テスト・型チェックで最終確認**

Run: `pnpm test && pnpm typecheck`
Expected: すべて PASS / エラーなし。

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: Slack コンシューマーのサーバーレス移行に合わせて手順とデータフローを更新"
```

---

## Self-Review メモ（計画作成者による確認）

- **spec カバレッジ**: アーキテクチャ(Task 4/5/6) / パッケージ構成(Task 1〜6) / decideEvent の DM・空テキスト分岐(Task 3) / WorkerPayload(Task 4/5) / SecureString 手動作成運用(Task 6/7) / IAM(Task 6) / サイジング(Task 6) / エラーハンドリング(Task 4/5) / テスト方針(Task 2/3) / ドキュメント(Task 7) — すべて対応タスクあり。
- **型整合**: `WorkerPayload`(Task 4 で定義) を Task 5 が import。`AnswerDecision` のフィールド名(`sessionThreadTs`/`replyThreadTs`/`files`)は Task 3→5→4 で一貫。`buildAgentRequest` の引数キー(`threadTs`)に `sessionThreadTs` を渡す点は Task 4 で明示。`SlackFileRef` は Task 3 で定義し Task 4 が import。
- **プレースホルダ**: コードステップはすべて完全なコードを記載。Task 7 のドキュメントのみ編集箇所を箇条書きで指示（既存 README/CLAUDE.md の文面に依存するため）。
