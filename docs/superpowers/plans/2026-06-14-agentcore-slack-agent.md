# AgentCore + Slack 汎用エージェント 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slack（ローカル Socket Mode）から Bedrock AgentCore 上の Vercel AI SDK エージェントを呼び出し、Code Interpreter でファイルの入出力処理ができる汎用エージェントの PoC を、エンドツーエンドで動く形で構築する。

**Architecture:** pnpm モノレポ 3層構成。`packages/contract` が唯一の結合点（型＋AgentCore Runtime 呼び出しクライアント＋セッションID導出）。`apps/agent` は `BedrockAgentCoreApp` で HTTP 化した Vercel AI SDK の `ToolLoopAgent`（Code Interpreter ツール登録、呼び出しはモデル判断）。`apps/consumer-slack` は Slack Bolt(Socket Mode) アダプターで `contract` のみに依存。`infra` は CDK（`aws-cdk-lib/aws-bedrockagentcore` 安定版）で Runtime/CodeInterpreter/ECR/IAM を構築。

**Tech Stack:** TypeScript / pnpm workspaces / Vitest / Vercel AI SDK (`ai@^6`, `@ai-sdk/amazon-bedrock@^4`) / `bedrock-agentcore` SDK / `@slack/bolt` / AWS CDK (`aws-cdk-lib`) / Zod (`zod@^4`) / Docker。

**前提:** Node.js 20+ と pnpm 9+、Docker、AWS 認証情報（`aws configure` 済み）、Bedrock モデルアクセス有効化済み。Slack アプリ（Socket Mode 有効、`SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` 取得済み）。

**注記（実装者向け）:** Code Interpreter を Vercel AI SDK に渡す具体的なツールバインド API は、参照実装 [`primitives/tools/code-interpreter/vercel-ai`](https://github.com/awslabs/bedrock-agentcore-samples-typescript/tree/main/primitives/tools/code-interpreter/vercel-ai) の最新コードに必ず合わせること。本計画では確認済みの API 名（`CodeInterpreterTools`, `executeCommand`, `writeFiles`, `readFiles`）を使う。メソッド名が参照実装と異なる場合は参照実装を正とする。

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
| `apps/agent/src/codeInterpreter.ts` | Code Interpreter ツール生成（ファイル入出力ヘルパ含む） |
| `apps/agent/src/agent.ts` | Vercel AI SDK `ToolLoopAgent` 構築・実行（`AgentRequest`→`AgentResponse`） |
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
    "bedrock-agentcore": "^1.0.0",
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

- [ ] **Step 2: 失敗するテストを書く（CodeInterpreterTools をモック）**

`apps/agent/src/codeInterpreter.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'

const writeFiles = vi.fn().mockResolvedValue(undefined)
const readFiles = vi.fn().mockResolvedValue(JSON.stringify({ blob: Buffer.from('PNG').toString('base64') }))
const executeCommand = vi.fn().mockResolvedValue(JSON.stringify({ stdout: 'out.png\n' }))

vi.mock('bedrock-agentcore', () => ({
  CodeInterpreterTools: vi.fn(() => ({
    getClient: () => ({ writeFiles, readFiles, executeCommand }),
  })),
}))

import { uploadInputFiles, collectOutputArtifacts } from './codeInterpreter'

describe('uploadInputFiles', () => {
  it('writes each input file to the sandbox', async () => {
    const client = { writeFiles, readFiles, executeCommand } as any
    await uploadInputFiles(client, [{ name: 'a.csv', mimeType: 'text/csv', data: Buffer.from('1,2').toString('base64') }])
    expect(writeFiles).toHaveBeenCalledTimes(1)
  })
})

describe('collectOutputArtifacts', () => {
  it('lists output/ and reads files back as artifacts', async () => {
    const client = { writeFiles, readFiles, executeCommand } as any
    const artifacts = await collectOutputArtifacts(client)
    expect(artifacts[0].name).toBe('out.png')
    expect(Buffer.from(artifacts[0].data, 'base64').toString()).toBe('PNG')
  })
})
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm vitest run apps/agent/src/codeInterpreter.test.ts`
Expected: FAIL（`./codeInterpreter` が存在しない）。

- [ ] **Step 4: ヘルパを実装**

`apps/agent/src/codeInterpreter.ts`:
```ts
import { CodeInterpreterTools } from 'bedrock-agentcore'
import type { AgentArtifact, AgentFile } from '@app/contract'

export function createCodeInterpreter(region: string, identifier: string) {
  return new CodeInterpreterTools({ region, identifier })
}

type CiClient = ReturnType<ReturnType<typeof createCodeInterpreter>['getClient']>

/** 入力ファイルをサンドボックスの input/ に書き込む。 */
export async function uploadInputFiles(client: CiClient, files: AgentFile[] = []): Promise<void> {
  for (const f of files) {
    await client.writeFiles({
      content: [{ path: `input/${f.name}`, blob: f.data }],
    })
  }
}

/** サンドボックスの output/ を列挙し、各ファイルを artifact として読み戻す。 */
export async function collectOutputArtifacts(client: CiClient): Promise<AgentArtifact[]> {
  const listed = await client.executeCommand({ command: 'ls -1 output/ 2>/dev/null || true' })
  const stdout = JSON.parse(listed).stdout ?? ''
  const names = stdout.split('\n').map((s: string) => s.trim()).filter(Boolean)

  const artifacts: AgentArtifact[] = []
  for (const name of names) {
    const content = await client.readFiles({ paths: [`output/${name}`] })
    const blob = JSON.parse(content).blob as string
    artifacts.push({ name, mimeType: guessMime(name), data: blob })
  }
  return artifacts
}

function guessMime(name: string): string {
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.csv')) return 'text/csv'
  if (name.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}
```

> 注: `writeFiles`/`readFiles`/`executeCommand` の引数・戻り値の形は参照実装 `primitives/tools/code-interpreter/vercel-ai` に合わせて確定すること（本計画は README で確認した `readFiles({paths})` と base64 `blob` 形式に準拠）。

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm vitest run apps/agent/src/codeInterpreter.test.ts`
Expected: PASS（2 件）。

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

**設計:** `runAgent(req)` は (1) Code Interpreter セッション準備 → 入力ファイルアップロード、(2) `ToolLoopAgent` を Code Interpreter ツール付きで実行（モデルが必要時のみツールを呼ぶ）、(3) `output/` の生成ファイルを artifacts として収集、を行い `AgentResponse` を返す。LLM/CI は注入可能にしてテストする。

- [ ] **Step 1: 失敗するテストを書く（依存を注入してモック）**

`apps/agent/src/agent.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { runAgent } from './agent'

describe('runAgent', () => {
  it('uploads input files, runs the model, and returns text + artifacts', async () => {
    const writeFiles = vi.fn().mockResolvedValue(undefined)
    const readFiles = vi.fn().mockResolvedValue(JSON.stringify({ blob: Buffer.from('PNG').toString('base64') }))
    const executeCommand = vi.fn().mockResolvedValue(JSON.stringify({ stdout: 'chart.png\n' }))
    const client = { writeFiles, readFiles, executeCommand } as any

    const deps = {
      getClient: () => client,
      tools: {},
      generate: vi.fn().mockResolvedValue({ text: 'done' }),
    }

    const res = await runAgent(
      { sessionId: 'x'.repeat(40), userId: 'U1', text: 'plot it', files: [{ name: 'd.csv', mimeType: 'text/csv', data: 'MSwy' }] },
      deps as any,
    )

    expect(writeFiles).toHaveBeenCalledTimes(1)
    expect(res.text).toBe('done')
    expect(res.artifacts?.[0].name).toBe('chart.png')
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
import type { AgentRequest, AgentResponse } from '@app/contract'
import { createCodeInterpreter, uploadInputFiles, collectOutputArtifacts } from './codeInterpreter'

const MODEL_ID = process.env.AGENT_MODEL_ID ?? 'anthropic.claude-3-5-sonnet-20241022-v2:0'

const INSTRUCTIONS = [
  'あなたは汎用アシスタントです。',
  'ファイル処理やコード実行が必要なときだけ Code Interpreter を使ってください（不要なら使わない）。',
  '入力ファイルは input/ にあります。生成物は必ず output/ に保存してください。',
].join('\n')

export interface AgentDeps {
  getClient: () => ReturnType<ReturnType<typeof createCodeInterpreter>['getClient']>
  tools: Record<string, unknown>
  generate: (args: { instructions: string; prompt: string; tools: Record<string, unknown> }) => Promise<{ text: string }>
}

/** 本番用の依存を生成する。 */
export function defaultDeps(): AgentDeps {
  const region = process.env.AWS_REGION ?? 'us-east-1'
  const ci = createCodeInterpreter(region, process.env.CODE_INTERPRETER_ID!)
  const client = ci.getClient()
  const agent = new ToolLoopAgent({
    model: bedrock(MODEL_ID),
    instructions: INSTRUCTIONS,
    tools: ci.tools, // 参照実装に合わせ Code Interpreter のツール群を渡す
  })
  return {
    getClient: () => client,
    tools: ci.tools as Record<string, unknown>,
    generate: async ({ prompt }) => {
      const result = await agent.generate({ prompt })
      return { text: result.text }
    },
  }
}

export async function runAgent(req: AgentRequest, deps: AgentDeps): Promise<AgentResponse> {
  const client = deps.getClient()
  await uploadInputFiles(client, req.files)
  const { text } = await deps.generate({ instructions: INSTRUCTIONS, prompt: req.text, tools: deps.tools })
  const artifacts = await collectOutputArtifacts(client)
  return artifacts.length > 0 ? { text, artifacts } : { text }
}
```

> 注: `ToolLoopAgent` / `ci.tools` / `agent.generate` の正確な API は `ai@^6` と参照実装に合わせること。`defaultDeps` はテスト対象外（`runAgent` のみテスト）。型エラーが出る箇所は参照実装の最新シグネチャを正とする。

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run apps/agent/src/agent.test.ts`
Expected: PASS（1 件）。

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
    process: async function* (request) {
      const response = await runAgent(request, deps)
      yield { event: 'message', data: response }
    },
  },
})

app.run()
```

> 注: `process` の `yield` イベント形と最終レスポンス整形は `bedrock-agentcore` の最新仕様に合わせること（README 準拠: `yield { event, data }`）。コンシューマー側 `invokeAgent` が受け取る JSON が `AgentResponse` 形になるよう、必要なら data 整形を調整する。

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

    const codeInterpreter = new agentcore.CodeInterpreterCustom(this, 'CodeInterpreter', {
      codeInterpreterCustomName: 'agent_code_interpreter',
      description: 'Code interpreter for the Slack agent',
    })

    const artifact = agentcore.AgentRuntimeArtifact.fromEcrRepository(repository, 'latest')

    const runtime = new agentcore.Runtime(this, 'AgentRuntime', {
      runtimeName: 'slackAgent',
      agentRuntimeArtifact: artifact,
    })

    // Runtime 実行ロールに Bedrock 呼び出し権限を付与
    runtime.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    }))

    // Runtime に Code Interpreter の利用権限を付与
    codeInterpreter.grantUse(runtime.grantPrincipal)

    new CfnOutput(this, 'AgentRuntimeArn', { value: runtime.runtimeArn })
    new CfnOutput(this, 'CodeInterpreterId', { value: codeInterpreter.codeInterpreterCustomId })
    new CfnOutput(this, 'EcrRepoUri', { value: repository.repositoryUri })
  }
}
```

> 注: `runtime.runtimeArn` / `runtime.grantPrincipal` / `codeInterpreter.codeInterpreterCustomId` の正確なプロパティ名は `aws-cdk-lib/aws-bedrockagentcore` の型定義で確認すること（命名が異なれば合わせる）。`grantUse` は README で確認済み。

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
git commit -m "feat(infra): AgentCore Runtime/CodeInterpreter/ECR の CDK スタックを追加"
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
- デプロイ手順: `cdk bootstrap` → `pnpm --filter @app/infra deploy` → 出力の `EcrRepoUri` に `docker build`/`docker push` → 再デプロイ（`latest` 参照）→ 出力の `AgentRuntimeArn`/`CodeInterpreterId` を控える
- ローカル起動: `apps/consumer-slack/.env` を作成（`.env.example` 参照、`AGENT_RUNTIME_ARN` をデプロイ出力で設定）→ `pnpm --filter @app/consumer-slack dev`
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
