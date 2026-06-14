# AgentCore + Slack 汎用エージェント 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slack（ローカル Socket Mode）から Bedrock AgentCore 上の Vercel AI SDK エージェントを呼び出し、Code Interpreter でファイルの入出力処理ができる汎用エージェントの PoC を、エンドツーエンドで動く形で構築する。

**Architecture:** pnpm モノレポ 3層構成。`packages/contract` が唯一の結合点（型＋AgentCore Runtime 呼び出しクライアント＋セッションID導出）。`apps/agent` は `BedrockAgentCoreApp` で HTTP 化した Vercel AI SDK の `ToolLoopAgent`（Code Interpreter ツール登録、呼び出しはモデル判断）。`apps/consumer-slack` は Slack Bolt(Socket Mode) アダプターで `contract` のみに依存。`infra` は CDK（`aws-cdk-lib/aws-bedrockagentcore` 安定版）で Runtime/CodeInterpreter/ECR/IAM を構築。

**Tech Stack:** TypeScript / pnpm workspaces / Vitest / Vercel AI SDK (`ai@^6`, `@ai-sdk/amazon-bedrock@^4`) / `bedrock-agentcore` SDK / `@slack/bolt` / AWS CDK (`aws-cdk-lib`) / Zod (`zod@^4`) / Docker。

**前提:** Node.js 20+ と pnpm 9+、Docker、AWS 認証情報（`aws configure` 済み）、Bedrock モデルアクセス有効化済み。Slack アプリ（Socket Mode 有効、`SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` 取得済み）。

**実SDK確認済みの事実（`bedrock-agentcore@0.2.4` のインストール済み型を実機確認）:**
- Vercel AI SDK 統合は **`CodeInterpreterTools`（`bedrock-agentcore/code-interpreter/vercel-ai`）** を使う。`new CodeInterpreterTools({ region })` → `.tools`（`ToolLoopAgent` に渡す3ツール: executeCode / fileOperations / executeCommand）、`.getClient(): CodeInterpreter`（同一セッションのファイル入出力）、`.startSession()` / `.stopSession()`。**同一インスタンス＝同一セッション**なので、getClient での入出力とエージェントのツール実行は同じサンドボックスを共有する。
- `CodeInterpreter` クライアントのメソッドは **`Promise<string>`（抽出済みコンテンツ文字列）を返す**（JSON エンベロープではない）。`executeCommand({command})` は stdout 文字列、`readFiles({paths})` は対象ファイルのコンテンツ文字列、`writeFiles({ files: [{ path, content }] })`（content は文字列）。
- root export（`bedrock-agentcore` の `.`）は壊れているが、**サブパス import（`.../code-interpreter`, `.../code-interpreter/vercel-ai`, `.../runtime`）は実体ありで Node/Vitest とも解決可能**。root を import しないこと。Vitest 用の alias 回避は不要。
- ファイル content は**文字列前提**。バイナリは「テキスト＋base64画像」方針で扱う: 入力のバイナリは `input/<name>.b64`（base64文字列）として書き、出力のバイナリ（画像等）はモデルに `output/<name>.b64`（base64）で保存させ、コンシューマーでデコードして添付。テキスト/CSV/JSON はそのまま往復。
- Runtime: `BedrockAgentCoreApp`（`bedrock-agentcore/runtime`）。
- モデルID 既定: `global.anthropic.claude-sonnet-4-20250514-v1:0`（`AGENT_MODEL_ID` で上書き可）。

---

## ファイル構成

| パス | 責務 |
|---|---|
| `package.json` / `pnpm-workspace.yaml` | モノレポルート。workspace 定義、共通スクリプト |
| `tsconfig.base.json` | 共通 TS 設定 |
| `vitest.config.ts` | テスト設定 |
| `packages/contract/src/types.ts` | `AgentRequest`/`AgentResponse`/`AgentFile`/`AgentArtifact` 型と Zod スキーマ |
| `packages/contract/src/session.ts` | `deriveSessionId` セッションID導出 |
| `packages/contract/src/client.ts` | `invokeAgent` = AgentCore Runtime 呼び出しクライアント（リトライ込み） |
| `packages/contract/src/index.ts` | 公開エントリ |
| `apps/agent/src/codeInterpreter.ts` | Code Interpreter のファイル入出力ヘルパ（input/ 書き込み・output/ 収集、テキスト＋base64画像） |
| `apps/agent/src/agent.ts` | `CodeInterpreterTools` ＋ Vercel AI SDK `ToolLoopAgent` 構築・実行（`AgentRequest`→`AgentResponse`） |
| `apps/agent/src/main.ts` | `BedrockAgentCoreApp` エントリ（:8080） |
| `apps/agent/Dockerfile` | コンテナイメージ |
| `apps/consumer-slack/src/mapping.ts` | Slack イベント→`AgentRequest`、`AgentResponse`→Slack 返信の変換 |
| `apps/consumer-slack/src/app.ts` | Slack Bolt(Socket Mode) アプリ |
| `infra/bin/app.ts` | CDK アプリエントリ |
| `infra/lib/agent-stack.ts` | Runtime/CodeInterpreter/ECR/IAM スタック |
| `infra/cdk.json` | CDK 設定 |

---

## Task 1: モノレポ基盤の初期化

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.nvmrc`

- [ ] **Step 1: ルート `package.json` を作成**

```json
{
  "name": "bedrock-agentcore-typescript",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.14.0"
  },
  "packageManager": "pnpm@9.7.0"
}
```

- [ ] **Step 2: `pnpm-workspace.yaml` を作成**

```yaml
packages:
  - "packages/*"
  - "apps/*"
  - "infra"
```

- [ ] **Step 3: `tsconfig.base.json` を作成**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": false
  }
}
```

- [ ] **Step 4: `vitest.config.ts` と `.nvmrc` を作成**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { globals: true, environment: 'node' },
})
```

`.nvmrc`:
```
20
```

- [ ] **Step 5: 依存をインストールして検証**

Run: `pnpm install`
Expected: lockfile 生成、エラーなく完了。

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts .nvmrc pnpm-lock.yaml
git commit -m "chore: pnpm モノレポ基盤を初期化"
```

---

## Task 2: contract — 型と Zod スキーマ

**Files:**
- Create: `packages/contract/package.json`, `packages/contract/tsconfig.json`, `packages/contract/src/types.ts`
- Test: `packages/contract/src/types.test.ts`

- [ ] **Step 1: パッケージ雛形を作成**

`packages/contract/package.json`:
```json
{
  "name": "@app/contract",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "zod": "^4.0.0",
    "@aws-sdk/client-bedrock-agentcore": "^3.0.0"
  }
}
```

`packages/contract/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 2: 失敗するテストを書く**

`packages/contract/src/types.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { agentRequestSchema, agentResponseSchema } from './types'

describe('agentRequestSchema', () => {
  it('parses a valid request with a file', () => {
    const parsed = agentRequestSchema.parse({
      sessionId: 'x'.repeat(40),
      userId: 'U123',
      text: 'hello',
      files: [{ name: 'a.csv', mimeType: 'text/csv', data: 'YWJj' }],
    })
    expect(parsed.files?.[0].name).toBe('a.csv')
  })

  it('rejects a missing text field', () => {
    expect(() => agentRequestSchema.parse({ sessionId: 's', userId: 'u' })).toThrow()
  })
})

describe('agentResponseSchema', () => {
  it('parses a response with artifacts', () => {
    const parsed = agentResponseSchema.parse({
      text: 'done',
      artifacts: [{ name: 'out.png', mimeType: 'image/png', data: 'YWJj' }],
    })
    expect(parsed.artifacts?.[0].mimeType).toBe('image/png')
  })
})
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm vitest run packages/contract/src/types.test.ts`
Expected: FAIL（`./types` が存在しない）。

- [ ] **Step 4: 型とスキーマを実装**

`packages/contract/src/types.ts`:
```ts
import { z } from 'zod'

export const agentFileSchema = z.object({
  name: z.string(),
  mimeType: z.string(),
  data: z.string(), // base64
})
export type AgentFile = z.infer<typeof agentFileSchema>

export const agentArtifactSchema = z.object({
  name: z.string(),
  mimeType: z.string(),
  data: z.string(), // base64
})
export type AgentArtifact = z.infer<typeof agentArtifactSchema>

export const agentRequestSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  text: z.string(),
  files: z.array(agentFileSchema).optional(),
})
export type AgentRequest = z.infer<typeof agentRequestSchema>

export const agentResponseSchema = z.object({
  text: z.string(),
  artifacts: z.array(agentArtifactSchema).optional(),
})
export type AgentResponse = z.infer<typeof agentResponseSchema>
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm vitest run packages/contract/src/types.test.ts`
Expected: PASS（3 件）。

- [ ] **Step 6: Commit**

```bash
git add packages/contract
git commit -m "feat(contract): AgentRequest/AgentResponse の型と Zod スキーマを追加"
```

---

## Task 3: contract — セッションID導出

**Files:**
- Create: `packages/contract/src/session.ts`
- Test: `packages/contract/src/session.test.ts`

**背景:** AgentCore の `runtimeSessionId` は最小33文字・最大256文字。Slack の `thread_ts` は短いため、決定的にハッシュして 64 桁 hex（64文字）にする。

- [ ] **Step 1: 失敗するテストを書く**

`packages/contract/src/session.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { deriveSessionId } from './session'

describe('deriveSessionId', () => {
  it('returns a 33-256 char string', () => {
    const id = deriveSessionId(['T1', 'C1', '1700000000.000100'])
    expect(id.length).toBeGreaterThanOrEqual(33)
    expect(id.length).toBeLessThanOrEqual(256)
  })

  it('is deterministic for the same parts', () => {
    const parts = ['T1', 'C1', '1700000000.000100']
    expect(deriveSessionId(parts)).toBe(deriveSessionId(parts))
  })

  it('differs for different parts', () => {
    expect(deriveSessionId(['T1', 'C1', 'a'])).not.toBe(deriveSessionId(['T1', 'C1', 'b']))
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run packages/contract/src/session.test.ts`
Expected: FAIL（`./session` が存在しない）。

- [ ] **Step 3: 実装**

`packages/contract/src/session.ts`:
```ts
import { createHash } from 'node:crypto'

/**
 * Slack 由来の識別子から AgentCore runtimeSessionId（33-256文字）を決定的に導出する。
 * sha256 hex は 64 文字で制約を満たす。
 */
export function deriveSessionId(parts: string[]): string {
  return createHash('sha256').update(parts.join(':')).digest('hex')
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run packages/contract/src/session.test.ts`
Expected: PASS（3 件）。

- [ ] **Step 5: Commit**

```bash
git add packages/contract/src/session.ts packages/contract/src/session.test.ts
git commit -m "feat(contract): runtimeSessionId 導出ユーティリティを追加"
```

---

## Task 4: contract — Runtime 呼び出しクライアント

**Files:**
- Create: `packages/contract/src/client.ts`, `packages/contract/src/index.ts`
- Test: `packages/contract/src/client.test.ts`

- [ ] **Step 1: 失敗するテストを書く（依存はモック）**

`packages/contract/src/client.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendMock = vi.fn()
vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: vi.fn(() => ({ send: sendMock })),
  InvokeAgentRuntimeCommand: vi.fn((input) => ({ input })),
}))

import { invokeAgent } from './client'

function streamOf(obj: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj))
  return { transformToString: async () => new TextDecoder().decode(bytes) }
}

describe('invokeAgent', () => {
  beforeEach(() => sendMock.mockReset())

  it('parses a successful response', async () => {
    sendMock.mockResolvedValueOnce({ response: streamOf({ text: 'hi', artifacts: [] }) })
    const res = await invokeAgent(
      { sessionId: 'x'.repeat(40), userId: 'U1', text: 'hello' },
      { agentRuntimeArn: 'arn:aws:...:runtime/foo', region: 'us-east-1' },
    )
    expect(res.text).toBe('hi')
  })

  it('retries once then succeeds', async () => {
    sendMock
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({ response: streamOf({ text: 'ok' }) })
    const res = await invokeAgent(
      { sessionId: 'x'.repeat(40), userId: 'U1', text: 'hello' },
      { agentRuntimeArn: 'arn', region: 'us-east-1', maxRetries: 2, baseDelayMs: 1 },
    )
    expect(res.text).toBe('ok')
    expect(sendMock).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run packages/contract/src/client.test.ts`
Expected: FAIL（`./client` が存在しない）。

- [ ] **Step 3: クライアントを実装**

`packages/contract/src/client.ts`:
```ts
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import { agentResponseSchema, type AgentRequest, type AgentResponse } from './types'

export interface InvokeOptions {
  agentRuntimeArn: string
  region: string
  maxRetries?: number
  baseDelayMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function invokeAgent(
  req: AgentRequest,
  opts: InvokeOptions,
): Promise<AgentResponse> {
  const client = new BedrockAgentCoreClient({ region: opts.region })
  const maxRetries = opts.maxRetries ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 200

  let lastErr: unknown
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const out = await client.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: opts.agentRuntimeArn,
          runtimeSessionId: req.sessionId,
          contentType: 'application/json',
          accept: 'application/json',
          payload: new TextEncoder().encode(JSON.stringify(req)),
        }),
      )
      const raw = await out.response!.transformToString()
      return agentResponseSchema.parse(JSON.parse(raw))
    } catch (err) {
      lastErr = err
      if (attempt < maxRetries - 1) await sleep(baseDelayMs * 2 ** attempt)
    }
  }
  throw lastErr
}
```

> 注: `InvokeAgentRuntimeCommand` の入力フィールド名（`payload`/`response` 等）は `@aws-sdk/client-bedrock-agentcore` の実型に合わせること。型エラーが出たら SDK の `InvokeAgentRuntimeCommandInput`/`Output` を確認して修正する。

- [ ] **Step 4: 公開エントリを作成**

`packages/contract/src/index.ts`:
```ts
export * from './types'
export * from './session'
export * from './client'
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm vitest run packages/contract/src/client.test.ts`
Expected: PASS（2 件）。

- [ ] **Step 6: 型チェック**

Run: `pnpm --filter @app/contract typecheck`
Expected: エラーなし。

- [ ] **Step 7: Commit**

```bash
git add packages/contract/src/client.ts packages/contract/src/index.ts packages/contract/src/client.test.ts
git commit -m "feat(contract): AgentCore Runtime 呼び出しクライアントを追加"
```

---

## Task 5: agent — Code Interpreter ヘルパ

**Files:**
- Create: `apps/agent/package.json`, `apps/agent/tsconfig.json`, `apps/agent/src/codeInterpreter.ts`
- Test: `apps/agent/src/codeInterpreter.test.ts`

- [ ] **Step 1: パッケージ雛形を作成**

`apps/agent/package.json`:
```json
{
  "name": "@app/agent",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx src/main.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@app/contract": "workspace:*",
    "ai": "^6.0.0",
    "@ai-sdk/amazon-bedrock": "^4.0.0",
    "bedrock-agentcore": "^0.2.4",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "tsx": "^4.16.0"
  }
}
```

`apps/agent/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

これらのヘルパは `CodeInterpreter` クライアント（`CodeInterpreterTools.getClient()` で取得、戻り値は `Promise<string>`）を受け取る。**ファイル content は文字列前提**なので「テキスト＋base64画像」方針で扱う:
- 入力: テキスト系 mime は base64→utf-8 デコードして `input/<name>` に書く。バイナリは base64 のまま `input/<name>.b64` に書く。
- 出力: `output/` を列挙。`<name>.b64` は base64 バイナリ（そのまま artifact.data）、それ以外はテキスト（utf-8→base64 して artifact.data）。

- [ ] **Step 2: 失敗するテストを書く（client は単純なモックを直接注入）**

`apps/agent/src/codeInterpreter.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { uploadInputFiles, collectOutputArtifacts } from './codeInterpreter'

function makeClient() {
  return {
    writeFiles: vi.fn().mockResolvedValue('ok'),
    readFiles: vi.fn(),
    executeCommand: vi.fn(),
  }
}

describe('uploadInputFiles', () => {
  it('writes text files decoded and binary files as .b64', async () => {
    const client = makeClient()
    await uploadInputFiles(client as any, [
      { name: 'a.csv', mimeType: 'text/csv', data: Buffer.from('1,2').toString('base64') },
      { name: 'img.png', mimeType: 'image/png', data: 'AAEC' },
    ])
    expect(client.writeFiles).toHaveBeenCalledTimes(1)
    expect(client.writeFiles.mock.calls[0][0]).toEqual({
      files: [
        { path: 'input/a.csv', content: '1,2' },
        { path: 'input/img.png.b64', content: 'AAEC' },
      ],
    })
  })

  it('does nothing when there are no files', async () => {
    const client = makeClient()
    await uploadInputFiles(client as any, [])
    expect(client.writeFiles).not.toHaveBeenCalled()
  })
})

describe('collectOutputArtifacts', () => {
  it('reads text outputs (base64-encoded) and .b64 outputs (raw base64)', async () => {
    const client = makeClient()
    client.executeCommand.mockResolvedValue('report.csv\nchart.png.b64\n')
    client.readFiles
      .mockResolvedValueOnce('col1,col2')
      .mockResolvedValueOnce(Buffer.from('PNG').toString('base64'))
    const artifacts = await collectOutputArtifacts(client as any)
    expect(artifacts).toEqual([
      { name: 'report.csv', mimeType: 'text/csv', data: Buffer.from('col1,col2').toString('base64') },
      { name: 'chart.png', mimeType: 'image/png', data: Buffer.from('PNG').toString('base64') },
    ])
  })

  it('returns empty when output/ is empty', async () => {
    const client = makeClient()
    client.executeCommand.mockResolvedValue('')
    expect(await collectOutputArtifacts(client as any)).toEqual([])
  })
})
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm vitest run apps/agent/src/codeInterpreter.test.ts`
Expected: FAIL（`./codeInterpreter` が存在しない）。

- [ ] **Step 4: ヘルパを実装**

`apps/agent/src/codeInterpreter.ts`:
```ts
import type { CodeInterpreter } from 'bedrock-agentcore/code-interpreter'
import type { AgentArtifact, AgentFile } from '@app/contract'

const TEXT_MIME = /^(text\/|application\/(json|csv|xml|x-ndjson|javascript))/

/** 入力ファイルを input/ に書き込む。テキストはデコードして、バイナリは base64 を .b64 で。 */
export async function uploadInputFiles(client: CodeInterpreter, files: AgentFile[] = []): Promise<void> {
  if (files.length === 0) return
  const toWrite = files.map((f) =>
    TEXT_MIME.test(f.mimeType)
      ? { path: `input/${f.name}`, content: Buffer.from(f.data, 'base64').toString('utf-8') }
      : { path: `input/${f.name}.b64`, content: f.data },
  )
  await client.writeFiles({ files: toWrite })
}

/** output/ を列挙し、各ファイルを artifact として読み戻す。
 *  `<name>.b64` は base64 バイナリ、それ以外はテキスト。 */
export async function collectOutputArtifacts(client: CodeInterpreter): Promise<AgentArtifact[]> {
  const listing = await client.executeCommand({ command: 'ls -1 output/ 2>/dev/null || true' })
  const names = listing.split('\n').map((s) => s.trim()).filter(Boolean)

  const artifacts: AgentArtifact[] = []
  for (const name of names) {
    const content = await client.readFiles({ paths: [`output/${name}`] })
    if (name.endsWith('.b64')) {
      const realName = name.slice(0, -'.b64'.length)
      artifacts.push({ name: realName, mimeType: guessMime(realName), data: content.trim() })
    } else {
      artifacts.push({ name, mimeType: guessMime(name), data: Buffer.from(content, 'utf-8').toString('base64') })
    }
  }
  return artifacts
}

function guessMime(name: string): string {
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.csv')) return 'text/csv'
  if (name.endsWith('.json')) return 'application/json'
  if (name.endsWith('.txt')) return 'text/plain'
  return 'application/octet-stream'
}
```

> `CodeInterpreter` の `writeFiles({ files: [{ path, content }] })` / `executeCommand({ command })→string` / `readFiles({ paths })→string` は `bedrock-agentcore@0.2.4` の実型で確認済み。型は `import type { CodeInterpreter } from 'bedrock-agentcore/code-interpreter'`。**ルート `bedrock-agentcore` からは import しない**（root export が壊れている）。Vitest 用 alias は不要。

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm vitest run apps/agent/src/codeInterpreter.test.ts`
Expected: PASS（4 件）。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/package.json apps/agent/tsconfig.json apps/agent/src/codeInterpreter.ts apps/agent/src/codeInterpreter.test.ts
git commit -m "feat(agent): Code Interpreter のファイル入出力ヘルパを追加"
```

---

## Task 6: agent — エージェント本体（ToolLoopAgent）

**Files:**
- Create: `apps/agent/src/agent.ts`
- Test: `apps/agent/src/agent.test.ts`

**設計:** `runAgent(req, deps)` は (1) 入力ファイルを Code Interpreter にアップロード、(2) `ToolLoopAgent` を実行（モデルが必要時のみツールを呼ぶ）、(3) `output/` の生成ファイルを artifacts として収集、を行い `AgentResponse` を返す。`finally` で必ず `stopSession()`。`deps` は `{ ci: { getClient(), stopSession() }, generate(prompt) }` で、`defaultDeps()` が本番依存（`CodeInterpreterTools` ＋ `ToolLoopAgent`）を生成。テストは `deps` を注入し、`defaultDeps` は対象外。

- [ ] **Step 1: 失敗するテストを書く（依存を注入してモック）**

`apps/agent/src/agent.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { runAgent } from './agent'

describe('runAgent', () => {
  it('uploads input files, runs the model, collects artifacts, and stops the session', async () => {
    const client = {
      writeFiles: vi.fn().mockResolvedValue('ok'),
      readFiles: vi.fn().mockResolvedValue(Buffer.from('PNG').toString('base64')),
      executeCommand: vi.fn().mockResolvedValue('chart.png.b64\n'),
    }
    const ci = { getClient: () => client, stopSession: vi.fn().mockResolvedValue(undefined) }
    const generate = vi.fn().mockResolvedValue('done')

    const res = await runAgent(
      { sessionId: 'x'.repeat(40), userId: 'U1', text: 'plot it', files: [{ name: 'd.csv', mimeType: 'text/csv', data: 'MSwy' }] },
      { ci: ci as any, generate },
    )

    expect(client.writeFiles).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledWith('plot it')
    expect(res.text).toBe('done')
    expect(res.artifacts?.[0].name).toBe('chart.png')
    expect(ci.stopSession).toHaveBeenCalledTimes(1)
  })

  it('stops the session even if generate throws', async () => {
    const client = {
      writeFiles: vi.fn().mockResolvedValue('ok'),
      readFiles: vi.fn(),
      executeCommand: vi.fn().mockResolvedValue(''),
    }
    const ci = { getClient: () => client, stopSession: vi.fn().mockResolvedValue(undefined) }
    const generate = vi.fn().mockRejectedValue(new Error('boom'))

    await expect(
      runAgent({ sessionId: 'x'.repeat(40), userId: 'U1', text: 'hi' }, { ci: ci as any, generate }),
    ).rejects.toThrow('boom')
    expect(ci.stopSession).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run apps/agent/src/agent.test.ts`
Expected: FAIL（`./agent` が存在しない）。

- [ ] **Step 3: エージェントを実装**

`apps/agent/src/agent.ts`:
```ts
import { ToolLoopAgent } from 'ai'
import { bedrock } from '@ai-sdk/amazon-bedrock'
import { CodeInterpreterTools } from 'bedrock-agentcore/code-interpreter/vercel-ai'
import type { AgentRequest, AgentResponse } from '@app/contract'
import { uploadInputFiles, collectOutputArtifacts } from './codeInterpreter'

const MODEL_ID = process.env.AGENT_MODEL_ID ?? 'global.anthropic.claude-sonnet-4-20250514-v1:0'

const INSTRUCTIONS = [
  'あなたは汎用アシスタントです。',
  'ファイル処理やコード実行が必要なときだけツール（Code Interpreter）を使ってください。不要なら使わないでください。',
  '入力ファイルは input/ にあります。生成物は必ず output/ に保存してください。',
  '画像など非テキストの生成物は、base64 にエンコードして output/<name>.b64 というテキストファイルとして保存してください（例: チャート画像なら output/chart.png.b64）。',
  'CSV や JSON などテキストの生成物はそのまま output/<name> に保存してください。',
].join('\n')

/** ファイル入出力に使う Code Interpreter クライアントの最小インターフェース。 */
export interface AgentDeps {
  ci: {
    getClient: () => Parameters<typeof uploadInputFiles>[0]
    stopSession: () => Promise<void>
  }
  generate: (prompt: string) => Promise<string>
}

/** 本番用の依存を生成する（テスト対象外）。 */
export function defaultDeps(): AgentDeps {
  const ci = new CodeInterpreterTools({ region: process.env.AWS_REGION ?? 'us-east-1' })
  const agent = new ToolLoopAgent({
    model: bedrock(MODEL_ID),
    instructions: INSTRUCTIONS,
    tools: ci.tools,
  })
  return {
    ci,
    generate: async (prompt) => (await agent.generate({ prompt })).text,
  }
}

export async function runAgent(req: AgentRequest, deps: AgentDeps): Promise<AgentResponse> {
  const client = deps.ci.getClient()
  try {
    await uploadInputFiles(client, req.files)
    const text = await deps.generate(req.text)
    const artifacts = await collectOutputArtifacts(client)
    return artifacts.length > 0 ? { text, artifacts } : { text }
  } finally {
    await deps.ci.stopSession()
  }
}
```

> `CodeInterpreterTools`（`bedrock-agentcore/code-interpreter/vercel-ai`）は `.tools`（`ToolLoopAgent` に渡す）・`.getClient()`・`.stopSession()` を持つ（実型で確認済み）。`ToolLoopAgent` / `bedrock()` / `agent.generate({prompt})→{text}` は `ai@^6` / `@ai-sdk/amazon-bedrock@^4` の API。型エラーが出たらインストール済み型に合わせる。`defaultDeps` の `ci` 型は `CodeInterpreterTools` が `AgentDeps.ci` を構造的に満たすこと（`getClient`/`stopSession`）。

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run apps/agent/src/agent.test.ts`
Expected: PASS（2 件）。

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/agent.ts apps/agent/src/agent.test.ts
git commit -m "feat(agent): ToolLoopAgent によるエージェント本体を追加"
```

---

## Task 7: agent — BedrockAgentCoreApp エントリ

**Files:**
- Create: `apps/agent/src/main.ts`

- [ ] **Step 1: エントリを実装**

`apps/agent/src/main.ts`:
```ts
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'
import { agentRequestSchema } from '@app/contract'
import { runAgent, defaultDeps } from './agent'

const deps = defaultDeps()

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: agentRequestSchema,
    // 値を直接 return すると JSON レスポンスとして返る（async generator は SSE 用なので使わない）。
    // これによりコンシューマーの invokeAgent が response body を JSON.parse → AgentResponse できる。
    process: async (request) => runAgent(request, deps),
  },
})

app.run()
```

> `BedrockAgentCoreApp({ invocationHandler: { requestSchema, process } })` は実型で確認済み。`process: (request, context) => Promise<unknown>` は**戻り値をそのまま JSON レスポンス本文として返す**（実型: `InvocationHandler` は値 return / AsyncGenerator のどちらも可。SSE が必要なときだけ generator）。本設計は `AgentResponse` をそのまま return する。サーバはポート 8080 で起動。
>
> PoC 上の割り切り: `defaultDeps()` は起動時に `CodeInterpreterTools` を1つ生成し全リクエストで共有する。`runAgent` は各リクエストで `stopSession()` する（次回利用時に自動再作成）。同時並行リクエストはセッションを共有してしまうため、個人利用の低並行前提とする。並行対応が必要になったらリクエスト毎に `CodeInterpreterTools` を生成する形へ変更する。

- [ ] **Step 2: 型チェック**

Run: `pnpm --filter @app/agent typecheck`
Expected: エラーなし（型不一致が出たら SDK 実シグネチャに合わせて修正）。

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/main.ts
git commit -m "feat(agent): BedrockAgentCoreApp エントリを追加"
```

---

## Task 8: agent — Dockerfile

**Files:**
- Create: `apps/agent/Dockerfile`, `apps/agent/.dockerignore`

- [ ] **Step 1: Dockerfile を作成**

`apps/agent/Dockerfile`（モノレポルートからビルドする前提）:
```dockerfile
FROM node:20-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contract ./packages/contract
COPY apps/agent ./apps/agent
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @app/contract build && pnpm --filter @app/agent build

FROM node:20-slim
WORKDIR /repo
RUN corepack enable
COPY --from=build /repo /repo
ENV PORT=8080
EXPOSE 8080
CMD ["node", "apps/agent/dist/main.js"]
```

`apps/agent/.dockerignore`:
```
node_modules
dist
```

- [ ] **Step 2: ビルドできることを確認**

Run: `docker build -f apps/agent/Dockerfile -t agentcore-agent .`
Expected: イメージビルド成功。

- [ ] **Step 3: Commit**

```bash
git add apps/agent/Dockerfile apps/agent/.dockerignore
git commit -m "build(agent): エージェントのコンテナイメージ定義を追加"
```

---

## Task 9: consumer-slack — イベント変換マッピング

**Files:**
- Create: `apps/consumer-slack/package.json`, `apps/consumer-slack/tsconfig.json`, `apps/consumer-slack/src/mapping.ts`
- Test: `apps/consumer-slack/src/mapping.test.ts`

- [ ] **Step 1: パッケージ雛形を作成**

`apps/consumer-slack/package.json`:
```json
{
  "name": "@app/consumer-slack",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx src/app.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@app/contract": "workspace:*",
    "@slack/bolt": "^4.0.0"
  },
  "devDependencies": {
    "tsx": "^4.16.0"
  }
}
```

`apps/consumer-slack/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 2: 失敗するテストを書く**

`apps/consumer-slack/src/mapping.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildAgentRequest } from './mapping'

describe('buildAgentRequest', () => {
  it('strips the bot mention and derives a 33+ char sessionId', () => {
    const req = buildAgentRequest({
      teamId: 'T1',
      channel: 'C1',
      threadTs: '1700000000.000100',
      userId: 'U9',
      rawText: '<@UBOT> 集計して',
      files: [],
    })
    expect(req.text).toBe('集計して')
    expect(req.userId).toBe('U9')
    expect(req.sessionId.length).toBeGreaterThanOrEqual(33)
  })

  it('uses the same sessionId for the same thread', () => {
    const base = { teamId: 'T1', channel: 'C1', threadTs: '111.222', userId: 'U9', rawText: 'hi', files: [] }
    expect(buildAgentRequest(base).sessionId).toBe(buildAgentRequest(base).sessionId)
  })
})
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm vitest run apps/consumer-slack/src/mapping.test.ts`
Expected: FAIL（`./mapping` が存在しない）。

- [ ] **Step 4: 実装**

`apps/consumer-slack/src/mapping.ts`:
```ts
import { deriveSessionId, type AgentFile, type AgentRequest } from '@app/contract'

export interface SlackEventInput {
  teamId: string
  channel: string
  threadTs: string
  userId: string
  rawText: string
  files: AgentFile[]
}

export function buildAgentRequest(input: SlackEventInput): AgentRequest {
  const text = input.rawText.replace(/<@[^>]+>/g, '').trim()
  return {
    sessionId: deriveSessionId([input.teamId, input.channel, input.threadTs]),
    userId: input.userId,
    text,
    files: input.files.length > 0 ? input.files : undefined,
  }
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm vitest run apps/consumer-slack/src/mapping.test.ts`
Expected: PASS（2 件）。

- [ ] **Step 6: Commit**

```bash
git add apps/consumer-slack/package.json apps/consumer-slack/tsconfig.json apps/consumer-slack/src/mapping.ts apps/consumer-slack/src/mapping.test.ts
git commit -m "feat(consumer-slack): Slack イベント→AgentRequest 変換を追加"
```

---

## Task 10: consumer-slack — Bolt アプリ（Socket Mode）

**Files:**
- Create: `apps/consumer-slack/src/app.ts`, `apps/consumer-slack/.env.example`

- [ ] **Step 1: ファイルDLヘルパとアプリを実装**

`apps/consumer-slack/src/app.ts`:
```ts
import bolt from '@slack/bolt'
import { invokeAgent, type AgentFile } from '@app/contract'
import { buildAgentRequest } from './mapping'

const { App } = bolt

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
})

const region = process.env.AWS_REGION ?? 'us-east-1'
const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN!

async function downloadSlackFiles(files: any[] | undefined, token: string): Promise<AgentFile[]> {
  if (!files?.length) return []
  const out: AgentFile[] = []
  for (const f of files) {
    const res = await fetch(f.url_private_download, { headers: { Authorization: `Bearer ${token}` } })
    const buf = Buffer.from(await res.arrayBuffer())
    out.push({ name: f.name, mimeType: f.mimetype, data: buf.toString('base64') })
  }
  return out
}

app.event('app_mention', async ({ event, client, say }) => {
  const e = event as any
  const threadTs = e.thread_ts ?? e.ts
  try {
    const files = await downloadSlackFiles(e.files, process.env.SLACK_BOT_TOKEN!)
    const req = buildAgentRequest({
      teamId: e.team ?? 'unknown',
      channel: e.channel,
      threadTs,
      userId: e.user,
      rawText: e.text ?? '',
      files,
    })
    const res = await invokeAgent(req, { agentRuntimeArn, region })
    await say({ text: res.text || '(空の応答)', thread_ts: threadTs })

    for (const a of res.artifacts ?? []) {
      await client.files.uploadV2({
        channel_id: e.channel,
        thread_ts: threadTs,
        filename: a.name,
        file: Buffer.from(a.data, 'base64'),
      })
    }
  } catch (err) {
    await say({ text: `エラーが発生しました: ${(err as Error).message}`, thread_ts: threadTs })
  }
})

await app.start()
console.log('⚡️ Slack consumer (Socket Mode) running')
```

- [ ] **Step 2: `.env.example` を作成**

`apps/consumer-slack/.env.example`:
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
AWS_REGION=us-east-1
AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/your-agent
```

- [ ] **Step 3: 型チェック**

Run: `pnpm --filter @app/consumer-slack typecheck`
Expected: エラーなし（Slack/SDK 型不一致が出たら実型に合わせて修正）。

- [ ] **Step 4: Commit**

```bash
git add apps/consumer-slack/src/app.ts apps/consumer-slack/.env.example
git commit -m "feat(consumer-slack): Socket Mode Bolt アプリを追加"
```

---

## Task 11: infra — CDK スタック

**Files:**
- Create: `infra/package.json`, `infra/tsconfig.json`, `infra/cdk.json`, `infra/bin/app.ts`, `infra/lib/agent-stack.ts`

- [ ] **Step 1: パッケージ雛形と CDK 設定を作成**

`infra/package.json`:
```json
{
  "name": "@app/infra",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "synth": "cdk synth",
    "deploy": "cdk deploy",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "aws-cdk-lib": "^2.160.0",
    "constructs": "^10.0.0"
  },
  "devDependencies": {
    "aws-cdk": "^2.160.0",
    "tsx": "^4.16.0"
  }
}
```

`infra/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext" },
  "include": ["bin", "lib"]
}
```

`infra/cdk.json`:
```json
{
  "app": "tsx bin/app.ts"
}
```

- [ ] **Step 2: スタックを実装**

`infra/lib/agent-stack.ts`:
```ts
import { Stack, type StackProps, CfnOutput } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore'

export class AgentStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    const repository = new ecr.Repository(this, 'AgentRepo', {
      repositoryName: 'agentcore-agent',
    })

    const artifact = agentcore.AgentRuntimeArtifact.fromEcrRepository(repository, 'latest')

    const runtime = new agentcore.Runtime(this, 'AgentRuntime', {
      runtimeName: 'slackAgent',
      agentRuntimeArtifact: artifact,
    })

    // Runtime 実行ロールに Bedrock モデル呼び出し権限を付与
    runtime.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    }))

    // Runtime 実行ロールに（既定の管理）Code Interpreter の利用権限を付与。
    // エージェントは identifier 既定（AWS 管理の system code interpreter）を使うため、
    // カスタム CodeInterpreter リソースは作らず IAM 権限のみ付与する。
    runtime.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:StartCodeInterpreterSession',
        'bedrock-agentcore:InvokeCodeInterpreter',
        'bedrock-agentcore:StopCodeInterpreterSession',
        'bedrock-agentcore:GetCodeInterpreterSession',
        'bedrock-agentcore:ListCodeInterpreterSessions',
      ],
      resources: ['*'],
    }))

    new CfnOutput(this, 'AgentRuntimeArn', { value: runtime.runtimeArn })
    new CfnOutput(this, 'EcrRepoUri', { value: repository.repositoryUri })
  }
}
```

> 注: `Runtime` / `AgentRuntimeArtifact.fromEcrRepository` / `addToRolePolicy` は README で確認済み。`runtime.runtimeArn` の正確なプロパティ名は `aws-cdk-lib/aws-bedrockagentcore` の型定義で確認し、異なれば合わせる（例: `runtimeArn`）。Code Interpreter の IAM アクション名は実環境で権限不足が出たら調整する（`resources: ['*']` は PoC 簡略化。将来は既定インタープリタ ARN とセッション ARN に絞る）。専用のカスタム Code Interpreter を使いたい場合は `agentcore.CodeInterpreterCustom` を作成し、その ID をエージェントの `CODE_INTERPRETER_ID` 環境変数で渡す（`defaultDeps` で `new CodeInterpreterTools({ region, identifier })` とする拡張が必要）。

`infra/bin/app.ts`:
```ts
import { App } from 'aws-cdk-lib'
import { AgentStack } from '../lib/agent-stack'

const app = new App()
new AgentStack(app, 'AgentcoreSlackAgent', {
  env: { region: process.env.CDK_DEFAULT_REGION, account: process.env.CDK_DEFAULT_ACCOUNT },
})
```

- [ ] **Step 3: synth できることを確認**

Run: `pnpm --filter @app/infra synth`
Expected: CloudFormation テンプレートが生成され、エラーなし。

- [ ] **Step 4: Commit**

```bash
git add infra
git commit -m "feat(infra): AgentCore Runtime/ECR/IAM の CDK スタックを追加"
```

---

## Task 12: 全体検証とドキュメント

**Files:**
- Create: `README.md`

- [ ] **Step 1: 全テスト・型チェックを実行**

Run: `pnpm test && pnpm -r typecheck`
Expected: 全テスト PASS、型エラーなし。

- [ ] **Step 2: README にセットアップ・デプロイ・ローカル起動手順を記載**

`README.md` に以下を含める:
- 前提（Node 20+/pnpm/Docker/AWS 認証/Bedrock モデルアクセス/Slack アプリ）
- デプロイ手順: `cdk bootstrap` → `pnpm --filter @app/infra deploy` → 出力の `EcrRepoUri` に `docker build`/`docker push` → 再デプロイ（`latest` 参照）→ 出力の `AgentRuntimeArn` を控える
- ローカル起動: `apps/consumer-slack/.env` を作成（`.env.example` 参照、`AGENT_RUNTIME_ARN` をデプロイ出力で設定）→ `pnpm --filter @app/consumer-slack dev`
- エージェントのモデルは既定で `global.anthropic.claude-sonnet-4-20250514-v1:0`。変更時は Runtime の環境変数 `AGENT_MODEL_ID` を設定（Bedrock でモデルアクセス有効化が必要）
- Slack でボットをチャンネルに招待し、メンション（＋ファイル添付）して応答を確認

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: セットアップ・デプロイ・ローカル起動手順を追加"
```

---

## 手動 E2E 検証（デプロイ後）

これらは自動テストの対象外。デプロイ後に手動で確認する。

1. `@bot こんにちは` → スレッドにテキスト応答（Code Interpreter は未使用）。
2. CSV を添付して `@bot このデータを棒グラフにして output に保存して` → スレッドに説明テキスト＋ PNG がアップロードされる。
3. 同一スレッドで続けて質問 → 文脈が保持されている（同一 sessionId）。
4. 別スレッドで質問 → 文脈が分離されている。
