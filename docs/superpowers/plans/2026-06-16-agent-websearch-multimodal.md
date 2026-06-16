# エージェント Web 検索 / マルチモーダル入力 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 汎用エージェントに Tavily ベースの Web 検索ツールと、画像/PDF のマルチモーダル(vision)入力を追加し、Code Interpreter へのアップロードを LLM 駆動の lazy 方式に再構成する。

**Architecture:** Web 検索は Vercel AI SDK の `tool()` を自前ラップし `ToolLoopAgent` の tools に並べる。マルチモーダルは純関数 `buildMessages`/`partitionFiles` で画像/PDF を vision content パート化し、サンドボックスへの書き込みは `loadAttachments` ブリッジツール経由でモデルが必要時のみ行う。純ロジックは SDK をモックせず単体テストし、`defaultDeps` の配線はテスト対象外とする。

**Tech Stack:** TypeScript / pnpm monorepo / Vercel AI SDK (`ai@6`) / `@ai-sdk/amazon-bedrock` / `@tavily/core` / `bedrock-agentcore` / AWS CDK / vitest

**設計書:** [2026-06-16-agent-websearch-multimodal-design.md](../specs/2026-06-16-agent-websearch-multimodal-design.md)

**前提（着手前に確認 / 設計書「要検証」と対応）:**
- `pnpm install` 済みであること（ローカル `node_modules` 未インストールのため）。
- `ai@6` の content パート型名（`TextPart`/`ImagePart`/`FilePart`）と `tool()` の `inputSchema`/`execute` 形、`CodeInterpreterTools.tools` がツールオブジェクト（`Record<string, Tool>`）であること、`@tavily/core` の `tavily().search()` 形、`agentcore.Runtime` の `environmentVariables` プロパティ名 — 各タスク冒頭の該当箇所で実機確認し、差異があれば型名のみ調整する。

**テスト方針:** 新規テストの `it()` 説明は CLAUDE.md に従い日本語で書く。

---

## ファイル構成

| ファイル | 区分 | 責務 |
| --- | --- | --- |
| `apps/agent/src/webSearch.ts` | 新規 | `formatSearchResult`(純) / `createWebSearchTool`(SearchFn 注入) / 関連型 |
| `apps/agent/src/webSearch.test.ts` | 新規 | 整形・失敗時挙動の単体テスト |
| `apps/agent/src/agent.ts` | 変更 | `partitionFiles`/`buildMessages`(純) 追加、`AgentDeps`/`runAgent`/`defaultDeps`/`INSTRUCTIONS` 改修 |
| `apps/agent/src/agent.test.ts` | 変更 | `partitionFiles`/`buildMessages`/`runAgent` のテスト更新・追加 |
| `apps/agent/src/codeInterpreter.ts` | 変更 | `createLoadAttachmentsTool` 追加 |
| `apps/agent/src/codeInterpreter.test.ts` | 変更 | `createLoadAttachmentsTool` のテスト追加 |
| `apps/agent/package.json` | 変更 | `@tavily/core` 依存追加 |
| `infra/lib/agent-stack.ts` | 変更 | Runtime に `TAVILY_API_KEY` 環境変数を注入 |

---

# Part 1: Web 検索ツール（独立・先行）

### Task 1: Tavily 依存追加と `formatSearchResult`（純関数）

**Files:**
- Modify: `apps/agent/package.json`
- Create: `apps/agent/src/webSearch.ts`
- Test: `apps/agent/src/webSearch.test.ts`

- [ ] **Step 1: Tavily を依存に追加**

Run:
```bash
pnpm --filter @app/agent add @tavily/core
```
Expected: `apps/agent/package.json` の `dependencies` に `@tavily/core` が追加される。

- [ ] **Step 2: 失敗するテストを書く**

Create `apps/agent/src/webSearch.test.ts`:
```ts
// =============================================================================
// formatSearchResult（検索結果整形）と createWebSearchTool（失敗時挙動）の単体テスト。
// =============================================================================
import { describe, it, expect } from 'vitest'
import { formatSearchResult } from './webSearch'

describe('formatSearchResult', () => {
  it('合成回答と上位ソースを整形する', () => {
    const out = formatSearchResult({
      answer: 'TypeScript は静的型付け言語です。',
      results: [
        { title: 'TS 公式', url: 'https://ts.example/a', content: '型の概要' },
        { title: 'Wiki', url: 'https://ts.example/b', content: '歴史' },
      ],
    })
    expect(out).toContain('回答: TypeScript は静的型付け言語です。')
    expect(out).toContain('1. TS 公式')
    expect(out).toContain('https://ts.example/a')
    expect(out).toContain('2. Wiki')
  })

  it('ソースを上位5件に制限する', () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      title: `t${i}`, url: `https://x/${i}`, content: `c${i}`,
    }))
    const out = formatSearchResult({ answer: undefined, results })
    expect(out).toContain('5. t4')
    expect(out).not.toContain('6. t5')
  })

  it('回答が無くてもソースだけ整形する', () => {
    const out = formatSearchResult({ answer: undefined, results: [{ title: 't', url: 'u', content: 'c' }] })
    expect(out).not.toContain('回答:')
    expect(out).toContain('1. t')
  })
})
```

- [ ] **Step 3: テストが落ちることを確認**

Run: `pnpm vitest run apps/agent/src/webSearch.test.ts`
Expected: FAIL（`webSearch` モジュール / `formatSearchResult` が存在しない）。

- [ ] **Step 4: 最小実装を書く**

Create `apps/agent/src/webSearch.ts`:
```ts
// =============================================================================
// Tavily を用いた Web 検索ツール。検索結果を LLM 向け文字列に整形する純関数
// formatSearchResult と、検索関数を注入して AI SDK ツールを生成する
// createWebSearchTool を提供する。失敗時は例外ではなくエラー文字列を返す。
// =============================================================================
import { tool } from 'ai'
import { z } from 'zod'

// 検索結果1件（Tavily の results 要素のうち必要な項目）。
export interface SearchSource {
  title: string   // ページタイトル
  url: string     // ページ URL
  content: string // 抜粋スニペット
}

// 検索のレスポンス（必要分のみ）。
export interface SearchResponse {
  answer?: string         // Tavily の合成回答（include_answer）
  results: SearchSource[] // 検索ヒット
}

// 検索を実行する関数の型。テスト時に差し替え可能にするため注入する。
export type SearchFn = (query: string) => Promise<SearchResponse>

// 検索結果を LLM 向けの単一文字列に整形する（合成回答 + 上位5ソース）。
export function formatSearchResult(res: SearchResponse): string {
  const lines: string[] = []
  if (res.answer) {
    lines.push(`回答: ${res.answer}`, '')
  }
  lines.push('ソース:')
  res.results.slice(0, 5).forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title}`, `   ${s.url}`, `   ${s.content}`)
  })
  return lines.join('\n')
}

// Web 検索ツールを生成する。search に実際の検索呼び出しを注入する。
export function createWebSearchTool(search: SearchFn) {
  return tool({
    description: 'Web を検索して最新情報や事実を取得する。最新性の確認や裏取りが必要なときに使う。',
    inputSchema: z.object({ query: z.string().describe('検索クエリ') }),
    // 失敗時は例外を投げず「検索に失敗しました: …」を返し、エージェント全体を止めない。
    execute: async ({ query }) => {
      try {
        return formatSearchResult(await search(query))
      } catch (e) {
        return `検索に失敗しました: ${(e as Error).message}`
      }
    },
  })
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm vitest run apps/agent/src/webSearch.test.ts`
Expected: PASS（3 件）。

- [ ] **Step 6: コミット**

```bash
git add apps/agent/package.json pnpm-lock.yaml apps/agent/src/webSearch.ts apps/agent/src/webSearch.test.ts
git commit -m "feat(agent): Tavily 検索結果を整形する formatSearchResult を追加"
```

---

### Task 2: `createWebSearchTool` の失敗時挙動テスト

**Files:**
- Test: `apps/agent/src/webSearch.test.ts`（追記）

- [ ] **Step 1: 失敗するテストを追記**

Append to `apps/agent/src/webSearch.test.ts`:
```ts
import { createWebSearchTool } from './webSearch'

describe('createWebSearchTool', () => {
  it('検索成功時は整形結果を返す', async () => {
    const t = createWebSearchTool(async () => ({
      answer: 'ans', results: [{ title: 't', url: 'u', content: 'c' }],
    }))
    const out = await (t as any).execute({ query: 'q' }, {} as any)
    expect(out).toContain('回答: ans')
    expect(out).toContain('1. t')
  })

  it('検索失敗時はエラー文字列を返し例外を投げない', async () => {
    const t = createWebSearchTool(async () => { throw new Error('rate limit') })
    const out = await (t as any).execute({ query: 'q' }, {} as any)
    expect(out).toBe('検索に失敗しました: rate limit')
  })
})
```

- [ ] **Step 2: テストが通ることを確認**

Run: `pnpm vitest run apps/agent/src/webSearch.test.ts`
Expected: PASS（5 件）。`execute` の第2引数（ツール実行オプション）は本テストでは未使用のため `{}` を渡す。

- [ ] **Step 3: コミット**

```bash
git add apps/agent/src/webSearch.test.ts
git commit -m "test(agent): createWebSearchTool の成功・失敗時挙動を検証"
```

---

### Task 3: エージェントへの配線と環境変数注入

**Files:**
- Modify: `apps/agent/src/agent.ts`（`defaultDeps` の tools / `INSTRUCTIONS`）
- Modify: `infra/lib/agent-stack.ts`

> **確認:** `@tavily/core` の API（`tavily({ apiKey }).search(query, { includeAnswer, maxResults })` が `{ answer, results: [{ title, url, content }] }` 系を返す）と、`agentcore.Runtime` の `environmentVariables` プロパティ名を実機/型定義で確認する。差異があればプロパティ名のみ調整する。

- [ ] **Step 1: `INSTRUCTIONS` に web_search 方針を追記**

In `apps/agent/src/agent.ts`, replace the `INSTRUCTIONS` definition:
```ts
// LLM に渡すシステムインストラクション。ツール使用方針とファイル入出力の規約を指定する。
const INSTRUCTIONS = [
  'あなたは汎用アシスタントです。',
  'ファイル処理やコード実行が必要なときだけツール（Code Interpreter）を使ってください。不要なら使わないでください。',
  '入力ファイルは input/ にあります。生成物は必ず output/<name> にそのまま保存してください（画像・PDF などバイナリも変換せずそのまま保存。base64 化やコピーの複製は不要です）。',
  '最新情報や事実確認が必要なときは web_search ツールで検索してください。',
  '生成したファイルの内容や base64 文字列を最終応答に貼り付けないでください。応答ではファイルを作成した旨を簡潔に伝えてください。',
].join('\n')
```

- [ ] **Step 2: import と `defaultDeps` に Web 検索ツールを配線**

In `apps/agent/src/agent.ts`, add import near the top (after the existing imports):
```ts
import { tavily } from '@tavily/core'
import { createWebSearchTool, type SearchFn } from './webSearch'
```

Replace the agent/tools construction inside `defaultDeps`:
```ts
  const bedrock = createAmazonBedrock({ region, credentialProvider: fromNodeProviderChain() })

  // Tavily 検索の実体を注入して Web 検索ツールを生成する。
  const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY })
  const search: SearchFn = async (query) => {
    const r = await tvly.search(query, { includeAnswer: true, maxResults: 5 })
    return { answer: r.answer, results: r.results.map((x) => ({ title: x.title, url: x.url, content: x.content })) }
  }
  const webSearchTool = createWebSearchTool(search)

  const agent = new ToolLoopAgent({
    model: bedrock(MODEL_ID),
    instructions: INSTRUCTIONS,
    tools: { ...ci.tools, webSearch: webSearchTool },
  })
```

> **注:** `ci.tools` はツールオブジェクト（`Record<string, Tool>`）である前提でオブジェクト展開する。配列だった場合は `tools` の組み立て方のみ調整する。

- [ ] **Step 3: 型チェックと全テストを通す**

Run:
```bash
pnpm vitest run apps/agent
pnpm typecheck
```
Expected: 既存テスト + Web 検索テストが PASS、型エラーなし。

- [ ] **Step 4: Runtime に `TAVILY_API_KEY` を注入**

In `infra/lib/agent-stack.ts`, replace the `Runtime` construction:
```ts
    // AgentCore Runtime を作成する。Web 検索ツール用に TAVILY_API_KEY をデプロイ時の
    // 環境変数から注入する（値はコミットしない）。
    const runtime = new agentcore.Runtime(this, 'AgentRuntime', {
      runtimeName: 'slackAgent',
      agentRuntimeArtifact: artifact,
      environmentVariables: {
        TAVILY_API_KEY: process.env.TAVILY_API_KEY ?? '',
      },
    })
```

- [ ] **Step 5: infra の型チェック**

Run: `pnpm typecheck`
Expected: 型エラーなし（`environmentVariables` プロパティが存在）。存在しない/別名なら正しいプロパティ名に修正する。

- [ ] **Step 6: コミット**

```bash
git add apps/agent/src/agent.ts infra/lib/agent-stack.ts
git commit -m "feat(agent): Web 検索ツールを ToolLoopAgent に配線し TAVILY_API_KEY を注入"
```

---

# Part 2: マルチモーダル入力 + lazy 再構成

### Task 4: `partitionFiles`（純関数・ファイル分類）

**Files:**
- Modify: `apps/agent/src/agent.ts`
- Test: `apps/agent/src/agent.test.ts`（追記）

- [ ] **Step 1: 失敗するテストを追記**

Append to `apps/agent/src/agent.test.ts`:
```ts
import { partitionFiles, type PartitionOptions } from './agent'

// テスト用の決定的なオプション（環境変数に依存させない）。
const OPTS: PartitionOptions = { pdfVisionEnabled: true, maxImageBytes: 1000, maxPdfBytes: 1000 }
// 指定バイト数ぶんの base64 文字列を作る（base64 4文字=3バイト）。
const b64OfBytes = (bytes: number) => 'A'.repeat(Math.ceil(bytes / 3) * 4)

describe('partitionFiles', () => {
  it('対応画像と PDF は vision、その他は一覧のみに分類する', () => {
    const { visionFiles, listingOnly } = partitionFiles([
      { name: 'a.png', mimeType: 'image/png', data: b64OfBytes(10) },
      { name: 'b.csv', mimeType: 'text/csv', data: b64OfBytes(10) },
      { name: 'c.pdf', mimeType: 'application/pdf', data: b64OfBytes(10) },
    ], OPTS)
    expect(visionFiles.map((f) => f.name)).toEqual(['a.png', 'c.pdf'])
    expect(listingOnly.map((f) => f.name)).toEqual(['b.csv'])
  })

  it('サイズ超過の画像は一覧のみに落とす', () => {
    const { visionFiles, listingOnly } = partitionFiles([
      { name: 'big.png', mimeType: 'image/png', data: b64OfBytes(2000) },
    ], OPTS)
    expect(visionFiles).toEqual([])
    expect(listingOnly.map((f) => f.name)).toEqual(['big.png'])
  })

  it('pdfVisionEnabled が false なら PDF を一覧のみに倒す', () => {
    const { visionFiles, listingOnly } = partitionFiles([
      { name: 'c.pdf', mimeType: 'application/pdf', data: b64OfBytes(10) },
    ], { ...OPTS, pdfVisionEnabled: false })
    expect(visionFiles).toEqual([])
    expect(listingOnly.map((f) => f.name)).toEqual(['c.pdf'])
  })

  it('未対応の画像形式は一覧のみに落とす', () => {
    const { visionFiles, listingOnly } = partitionFiles([
      { name: 'x.bmp', mimeType: 'image/bmp', data: b64OfBytes(10) },
    ], OPTS)
    expect(visionFiles).toEqual([])
    expect(listingOnly.map((f) => f.name)).toEqual(['x.bmp'])
  })
})
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `pnpm vitest run apps/agent/src/agent.test.ts`
Expected: FAIL（`partitionFiles` / `PartitionOptions` が存在しない）。

- [ ] **Step 3: 最小実装を書く**

In `apps/agent/src/agent.ts`, add after the `INSTRUCTIONS` definition:
```ts
// vision に渡せる画像 MIME（Claude on Bedrock 対応形式）。
const VISION_IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/

// ファイル分類のオプション。閾値と PDF の vision 可否を外から渡せるようにし、純関数を保つ。
export interface PartitionOptions {
  pdfVisionEnabled: boolean // PDF を vision に渡すか（プロバイダ未対応時は false に倒す）
  maxImageBytes: number     // vision に渡す画像の最大バイト数
  maxPdfBytes: number       // vision に渡す PDF の最大バイト数
}

// 既定の分類オプション。PDF の vision 可否のみ環境変数 PDF_VISION_ENABLED で倒せる。
export const DEFAULT_PARTITION_OPTIONS: PartitionOptions = {
  pdfVisionEnabled: process.env.PDF_VISION_ENABLED !== 'false',
  maxImageBytes: 5 * 1024 * 1024,
  maxPdfBytes: Math.floor(4.5 * 1024 * 1024),
}

// base64 文字列のバイト数を概算する（4文字=3バイト。末尾パディングは無視）。
function base64Bytes(data: string): number {
  return Math.floor((data.length * 3) / 4)
}

// 入力ファイルを vision に渡すもの（visionFiles）と一覧表示だけのもの（listingOnly）に分ける。
export function partitionFiles(
  files: AgentFile[],
  opts: PartitionOptions = DEFAULT_PARTITION_OPTIONS,
): { visionFiles: AgentFile[]; listingOnly: AgentFile[] } {
  const visionFiles: AgentFile[] = []
  const listingOnly: AgentFile[] = []
  for (const f of files) {
    const bytes = base64Bytes(f.data)
    // 対応画像でサイズ内 → vision。PDF は有効かつサイズ内 → vision。それ以外 → 一覧のみ。
    if (VISION_IMAGE_MIME.test(f.mimeType) && bytes <= opts.maxImageBytes) {
      visionFiles.push(f)
    } else if (f.mimeType === 'application/pdf' && opts.pdfVisionEnabled && bytes <= opts.maxPdfBytes) {
      visionFiles.push(f)
    } else {
      listingOnly.push(f)
    }
  }
  return { visionFiles, listingOnly }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run apps/agent/src/agent.test.ts`
Expected: `partitionFiles` の 4 件が PASS（既存 `runAgent` テストはこの時点でまだ旧仕様。Task 7 で更新するため、ここでは `partitionFiles` の describe のみ確認すればよい）。

- [ ] **Step 5: コミット**

```bash
git add apps/agent/src/agent.ts apps/agent/src/agent.test.ts
git commit -m "feat(agent): 画像/PDF を vision と一覧に振り分ける partitionFiles を追加"
```

---

### Task 5: `buildMessages`（純関数・content パート構築）

**Files:**
- Modify: `apps/agent/src/agent.ts`
- Test: `apps/agent/src/agent.test.ts`（追記）

> **確認:** `ai@6` の content パート型（`TextPart`/`ImagePart`/`FilePart`）の export 名と各フィールド（image パートは `image` + `mediaType`、file パートは `data` + `mediaType`）を実機/型定義で確認する。型名が異なる場合は import 名のみ調整する。

- [ ] **Step 1: 失敗するテストを追記**

Append to `apps/agent/src/agent.test.ts`:
```ts
import { buildMessages } from './agent'

describe('buildMessages', () => {
  it('ファイルが無ければテキストのみのパートを返す', () => {
    expect(buildMessages('こんにちは', [])).toEqual([{ type: 'text', text: 'こんにちは' }])
  })

  it('画像は vision パートに、全ファイルは一覧テキストに含める', () => {
    const parts = buildMessages('説明して', [
      { name: 'a.png', mimeType: 'image/png', data: b64OfBytes(10) },
      { name: 'b.csv', mimeType: 'text/csv', data: b64OfBytes(10) },
    ], OPTS)
    // 先頭は指示テキスト。
    expect(parts[0]).toEqual({ type: 'text', text: '説明して' })
    // 画像は image パートとして含まれる。
    const image = parts.find((p: any) => p.type === 'image') as any
    expect(image.mediaType).toBe('image/png')
    expect(Buffer.isBuffer(image.image)).toBe(true)
    // 末尾の一覧テキストに両ファイルが載る（csv は vision でないが一覧には載る）。
    const listing = parts[parts.length - 1] as any
    expect(listing.type).toBe('text')
    expect(listing.text).toContain('- input/a.png (image/png)')
    expect(listing.text).toContain('- input/b.csv (text/csv)')
  })

  it('PDF は file パートとして含める', () => {
    const parts = buildMessages('読んで', [
      { name: 'c.pdf', mimeType: 'application/pdf', data: b64OfBytes(10) },
    ], OPTS)
    const file = parts.find((p: any) => p.type === 'file') as any
    expect(file.mediaType).toBe('application/pdf')
    expect(Buffer.isBuffer(file.data)).toBe(true)
  })
})
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `pnpm vitest run apps/agent/src/agent.test.ts`
Expected: FAIL（`buildMessages` が存在しない）。

- [ ] **Step 3: 最小実装を書く**

In `apps/agent/src/agent.ts`, add import for the content part types (top of file):
```ts
import type { TextPart, ImagePart, FilePart } from 'ai'
```

Add after `partitionFiles`:
```ts
// ユーザーメッセージの content パート（テキスト / 画像 / ファイル）。
export type UserContentPart = TextPart | ImagePart | FilePart

// テキストと添付ファイルからユーザーメッセージの content パート配列を組み立てる。
// 画像/PDF は vision パートとして渡し、全ファイル名は一覧テキストとして添える。
export function buildMessages(
  text: string,
  files: AgentFile[] = [],
  opts: PartitionOptions = DEFAULT_PARTITION_OPTIONS,
): UserContentPart[] {
  if (files.length === 0) return [{ type: 'text', text }]

  const { visionFiles } = partitionFiles(files, opts)
  const parts: UserContentPart[] = [{ type: 'text', text }]

  // vision に渡せる画像/PDF をパート化する（PDF は file、画像は image）。
  for (const f of visionFiles) {
    if (f.mimeType === 'application/pdf') {
      parts.push({ type: 'file', data: Buffer.from(f.data, 'base64'), mediaType: 'application/pdf' })
    } else {
      parts.push({ type: 'image', image: Buffer.from(f.data, 'base64'), mediaType: f.mimeType })
    }
  }

  // 全ファイルを一覧テキストで提示する。コード処理には loadAttachments での取り込みが必要。
  const listing = files.map((f) => `- input/${f.name} (${f.mimeType})`).join('\n')
  parts.push({
    type: 'text',
    text: `添付ファイル（コードで処理する場合は loadAttachments で input/ に取り込む）:\n${listing}`,
  })
  return parts
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run apps/agent/src/agent.test.ts`
Expected: `buildMessages` の 3 件が PASS。

- [ ] **Step 5: コミット**

```bash
git add apps/agent/src/agent.ts apps/agent/src/agent.test.ts
git commit -m "feat(agent): 画像/PDF を vision パート化する buildMessages を追加"
```

---

### Task 6: `createLoadAttachmentsTool`（ブリッジツール）

**Files:**
- Modify: `apps/agent/src/codeInterpreter.ts`
- Test: `apps/agent/src/codeInterpreter.test.ts`（追記）

- [ ] **Step 1: 失敗するテストを追記**

Append to `apps/agent/src/codeInterpreter.test.ts`:
```ts
import { createLoadAttachmentsTool } from './codeInterpreter'

describe('createLoadAttachmentsTool', () => {
  it('getClient のクライアントに全ファイルを書き込む', async () => {
    const client = makeClient()
    const files = [
      { name: 'a.csv', mimeType: 'text/csv', data: Buffer.from('1,2').toString('base64') },
      { name: 'img.png', mimeType: 'image/png', data: 'AAEC' },
    ]
    const t = createLoadAttachmentsTool({ getClient: () => client as any }, files)
    const out = await (t as any).execute({}, {} as any)
    expect(client.writeFiles).toHaveBeenCalledTimes(1)
    expect(out).toContain('2 件')
  })

  it('添付が無ければその旨を返し書き込まない', async () => {
    const client = makeClient()
    const t = createLoadAttachmentsTool({ getClient: () => client as any }, [])
    const out = await (t as any).execute({}, {} as any)
    expect(client.writeFiles).not.toHaveBeenCalled()
    expect(out).toContain('添付ファイルはありません')
  })
})
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `pnpm vitest run apps/agent/src/codeInterpreter.test.ts`
Expected: FAIL（`createLoadAttachmentsTool` が存在しない）。

- [ ] **Step 3: 最小実装を書く**

In `apps/agent/src/codeInterpreter.ts`, add imports at the top (after existing imports):
```ts
import { tool } from 'ai'
import { z } from 'zod'
```

Add at the end of the file:
```ts
// 添付ファイルを Code Interpreter の input/ に取り込むブリッジツールを生成する。
// getClient は ci と同一セッションのクライアントを返すこと（書き込みを ci のコードツールから読めるようにするため）。
export function createLoadAttachmentsTool(
  ci: { getClient: () => CodeInterpreter },
  files: AgentFile[],
) {
  return tool({
    description: '添付ファイルを Code Interpreter の input/ に取り込む。ファイルをコードで処理する前に必ず呼ぶ。',
    inputSchema: z.object({}),
    execute: async () => {
      // 既存の振り分けロジック（テキスト=デコード / バイナリ=.b64）を再利用して書き込む。
      await uploadInputFiles(ci.getClient(), files)
      return files.length > 0
        ? `input/ に ${files.length} 件のファイルを配置しました。`
        : '添付ファイルはありません。'
    },
  })
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run apps/agent/src/codeInterpreter.test.ts`
Expected: PASS（既存 + 新規 2 件）。

- [ ] **Step 5: コミット**

```bash
git add apps/agent/src/codeInterpreter.ts apps/agent/src/codeInterpreter.test.ts
git commit -m "feat(agent): 添付を input/ に取り込む loadAttachments ブリッジツールを追加"
```

---

### Task 7: `AgentDeps` と `runAgent` の lazy 化

**Files:**
- Modify: `apps/agent/src/agent.ts`（`AgentDeps` / `runAgent`）
- Modify: `apps/agent/src/agent.test.ts`（既存 `runAgent` テストを新仕様へ更新）

- [ ] **Step 1: 既存 `runAgent` テストを新仕様へ書き換える**

In `apps/agent/src/agent.test.ts`, replace the entire `describe('runAgent', ...)` block with:
```ts
describe('runAgent', () => {
  it('buildMessages の content と files で generate を呼び、used なら artifacts を回収する', async () => {
    const client = {
      executeCommand: vi.fn()
        .mockResolvedValueOnce('chart.png\n') // ls output/
        .mockResolvedValueOnce(Buffer.from('PNG').toString('base64')), // base64 output/chart.png
    }
    const ci = {
      getClient: () => client,
      stopSession: vi.fn().mockResolvedValue(undefined),
      wasUsed: () => true, // サンドボックスが使われた
    }
    const generate = vi.fn().mockResolvedValue('done')

    const res = await runAgent(
      { sessionId: 'x'.repeat(40), userId: 'U1', text: 'plot it', files: [{ name: 'd.csv', mimeType: 'text/csv', data: 'MSwy' }] },
      { ci: ci as any, generate },
    )

    // content（buildMessages の戻り）と files が渡る。
    const [content, files] = generate.mock.calls[0]
    expect(content[0]).toEqual({ type: 'text', text: 'plot it' })
    expect(files).toEqual([{ name: 'd.csv', mimeType: 'text/csv', data: 'MSwy' }])
    expect(res.text).toBe('done')
    expect(res.artifacts?.[0].name).toBe('chart.png')
    expect(ci.stopSession).toHaveBeenCalledTimes(1)
  })

  it('サンドボックス未使用なら artifacts を回収せずセッションも停止しない', async () => {
    const client = { executeCommand: vi.fn() }
    const ci = {
      getClient: () => client,
      stopSession: vi.fn().mockResolvedValue(undefined),
      wasUsed: () => false, // 純 vision クエリ
    }
    const generate = vi.fn().mockResolvedValue('画像は猫です')

    const res = await runAgent(
      { sessionId: 'x'.repeat(40), userId: 'U1', text: 'これは何？', files: [{ name: 'a.png', mimeType: 'image/png', data: 'AAEC' }] },
      { ci: ci as any, generate },
    )

    expect(res.text).toBe('画像は猫です')
    expect(res.artifacts).toBeUndefined()
    expect(client.executeCommand).not.toHaveBeenCalled()
    expect(ci.stopSession).not.toHaveBeenCalled()
  })

  it('used なら generate が例外でもセッションを停止する', async () => {
    const ci = {
      getClient: () => ({ executeCommand: vi.fn() }),
      stopSession: vi.fn().mockResolvedValue(undefined),
      wasUsed: () => true,
    }
    const generate = vi.fn().mockRejectedValue(new Error('boom'))

    await expect(
      runAgent({ sessionId: 'x'.repeat(40), userId: 'U1', text: 'hi' }, { ci: ci as any, generate }),
    ).rejects.toThrow('boom')
    expect(ci.stopSession).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `pnpm vitest run apps/agent/src/agent.test.ts`
Expected: FAIL（`AgentDeps` に `wasUsed` が無い / `runAgent` が旧仕様で `generate` を文字列で呼ぶ）。

- [ ] **Step 3: `AgentDeps` と `runAgent` を実装する**

In `apps/agent/src/agent.ts`, replace the `AgentDeps` interface:
```ts
// Code Interpreter クライアントと LLM 呼び出しの最小インターフェース。テスト時にモック注入する。
export interface AgentDeps {
  ci: {
    getClient: () => Parameters<typeof uploadInputFiles>[0] // Code Interpreter クライアントを返す
    stopSession: () => Promise<void>                        // セッションを終了してリソースを解放する
    wasUsed: () => boolean                                  // サンドボックスが使われたか（lazy 判定）
  }
  // content（vision パート含む）と files（loadAttachments 束縛用）を受けて応答テキストを返す。
  generate: (content: UserContentPart[], files: AgentFile[]) => Promise<string>
}
```

Replace `buildPrompt` and `runAgent` (remove the old `buildPrompt` function entirely) with:
```ts
// リクエストを受けてエージェントを実行し、テキスト応答と出力アーティファクトを返す。
export async function runAgent(req: AgentRequest, deps: AgentDeps): Promise<AgentResponse> {
  try {
    // 画像/PDF を vision パート化した content を組み立てて LLM を実行する（アップロードは lazy）。
    const content = buildMessages(req.text, req.files)
    const text = await deps.generate(content, req.files ?? [])
    // サンドボックスが使われた場合のみ output/ を回収する（純 vision クエリではセッション不要）。
    const artifacts = deps.ci.wasUsed() ? await collectOutputArtifacts(deps.ci.getClient()) : []
    return artifacts.length > 0 ? { text, artifacts } : { text }
  } finally {
    // セッションが開始済み（used）のときだけ停止してリソースを解放する。
    if (deps.ci.wasUsed()) await deps.ci.stopSession()
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run apps/agent/src/agent.test.ts`
Expected: PASS（`partitionFiles` / `buildMessages` / `runAgent` すべて）。

- [ ] **Step 5: コミット**

```bash
git add apps/agent/src/agent.ts apps/agent/src/agent.test.ts
git commit -m "feat(agent): runAgent を lazy 化し vision content と used 判定に対応"
```

---

### Task 8: `defaultDeps` の再配線（テスト対象外の配線）

**Files:**
- Modify: `apps/agent/src/agent.ts`（`defaultDeps` / `INSTRUCTIONS`）

> `defaultDeps` は本番依存の生成のみでテスト対象外。型チェックと、Part 1 までの既存テストが緑のままであることで検証する。

> **確認:** `ToolLoopAgent.generate` が `{ messages: [{ role: 'user', content }] }` を受け付けること、`CodeInterpreterTools.tools` が各要素に `execute` を持つツールオブジェクトであることを実機/型定義で確認する。

- [ ] **Step 1: `INSTRUCTIONS` をマルチモーダル + lazy 方針へ更新**

In `apps/agent/src/agent.ts`, replace the `INSTRUCTIONS` definition:
```ts
// LLM に渡すシステムインストラクション。ツール使用方針とファイル入出力の規約を指定する。
const INSTRUCTIONS = [
  'あなたは汎用アシスタントです。',
  '画像や PDF は添付されていれば直接見えています。内容を問われたらそのまま読み取って答えてください。',
  'ファイルをコードで加工・解析する必要があるときだけ、まず loadAttachments ツールで input/ に取り込んでから Code Interpreter を使ってください。不要なら使わないでください。',
  '入力ファイルは loadAttachments 実行後に input/ に配置されます。生成物は必ず output/<name> にそのまま保存してください（画像・PDF などバイナリも変換せずそのまま保存。base64 化やコピーの複製は不要です）。',
  '最新情報や事実確認が必要なときは web_search ツールで検索してください。',
  '生成したファイルの内容や base64 文字列を最終応答に貼り付けないでください。応答ではファイルを作成した旨を簡潔に伝えてください。',
].join('\n')
```

- [ ] **Step 2: import を追加**

In `apps/agent/src/agent.ts`, update the import from `./codeInterpreter`:
```ts
import { uploadInputFiles, collectOutputArtifacts, createLoadAttachmentsTool } from './codeInterpreter'
```

- [ ] **Step 3: `defaultDeps` を再配線する**

Replace the entire `defaultDeps` function:
```ts
// 各ツールの execute をラップし、呼ばれたら used フラグを立てる（サンドボックス使用の追跡）。
function withUsageTracking<T extends Record<string, any>>(tools: T, mark: () => void): T {
  const out: Record<string, any> = {}
  for (const [name, t] of Object.entries(tools)) {
    out[name] = t?.execute
      ? { ...t, execute: async (...args: any[]) => { mark(); return t.execute(...args) } }
      : t
  }
  return out as T
}

// 本番用の依存を生成する（テスト対象外）。
export function defaultDeps(): AgentDeps {
  const region = process.env.AWS_REGION ?? 'ap-northeast-1'
  const ci = new CodeInterpreterTools({ region })
  // Vercel AI SDK の Bedrock プロバイダは独自の認証解決のため、AWS SDK 標準の
  // 認証チェーン（SSO・コンテナ実行ロール等）を credentialProvider として明示的に渡す。
  const bedrock = createAmazonBedrock({ region, credentialProvider: fromNodeProviderChain() })

  // Tavily 検索の実体を注入して Web 検索ツールを生成する。
  const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY })
  const search: SearchFn = async (query) => {
    const r = await tvly.search(query, { includeAnswer: true, maxResults: 5 })
    return { answer: r.answer, results: r.results.map((x) => ({ title: x.title, url: x.url, content: x.content })) }
  }
  const webSearchTool = createWebSearchTool(search)

  // サンドボックスが使われたかを追跡する。getClient（loadAttachments 経由）と CI ツール実行で true になる。
  let used = false
  const getClient = () => { used = true; return ci.getClient() }
  const trackedCiTools = withUsageTracking(ci.tools, () => { used = true })

  return {
    ci: {
      getClient,
      stopSession: () => ci.stopSession(),
      wasUsed: () => used,
    },
    // リクエストごとに loadAttachments を files で束縛して ToolLoopAgent を組む。
    generate: async (content, files) => {
      const agent = new ToolLoopAgent({
        model: bedrock(MODEL_ID),
        instructions: INSTRUCTIONS,
        tools: {
          ...trackedCiTools,
          webSearch: webSearchTool,
          loadAttachments: createLoadAttachmentsTool({ getClient }, files),
        },
      })
      return (await agent.generate({ messages: [{ role: 'user', content }] })).text
    },
  }
}
```

- [ ] **Step 4: 型チェックと全テストを通す**

Run:
```bash
pnpm vitest run apps/agent
pnpm typecheck
```
Expected: 全テスト PASS、型エラーなし。`ToolLoopAgent.generate` の引数型や `ci.tools` の形で型エラーが出た場合は、`messages` 形式・ツールオブジェクトの扱いのみ調整する（ロジックは変えない）。

- [ ] **Step 5: コミット**

```bash
git add apps/agent/src/agent.ts
git commit -m "feat(agent): defaultDeps を lazy 配線しマルチモーダル指示を反映"
```

---

### Task 9: 最終検証

**Files:** なし（検証のみ）

- [ ] **Step 1: 全パッケージのテストと型チェック**

Run:
```bash
pnpm test
pnpm typecheck
```
Expected: 全テスト PASS、型エラーなし。

- [ ] **Step 2: 設計書「要検証」の最終確認**

設計書 §「要検証」の 4 項目（CI セッション開始タイミング / content パート API / vision 上限実値 / `environmentVariables` プロパティ）について、実装中に判明した結果を設計書に追記する（食い違いがあれば閾値や型名を修正）。`PDF_VISION_ENABLED` でプロバイダ未対応を退避できることもここで確認する。

- [ ] **Step 3: ドキュメント整合**

`CLAUDE.md` のデータフロー記述（`uploadInputFiles → buildPrompt`）が旧仕様のため、`buildMessages` + lazy `loadAttachments` + web_search に更新する。

```bash
git add CLAUDE.md docs/superpowers/specs/2026-06-16-agent-websearch-multimodal-design.md
git commit -m "docs: マルチモーダル/lazy/Web 検索に合わせてデータフロー記述を更新"
```

---

## Self-Review メモ（計画作成者による確認）

- **spec カバレッジ:** 機能A（webSearch.ts/整形/env/失敗時=Task1-3）、機能B（partitionFiles=Task4 / buildMessages=Task5 / loadAttachments=Task6 / runAgent lazy+used=Task7 / defaultDeps 配線+INSTRUCTIONS=Task8）、F1 セッション共有（Task6 で同一 getClient、Task8 で共有 ci）、F2 バイトサイズ判定（Task4）、F3 PDF 閾値/フラグ（Task4 の `pdfVisionEnabled`/`maxPdfBytes`）、F4 generate シグネチャ（Task7）を網羅。
- **型整合:** `AgentFile`/`PartitionOptions`/`UserContentPart`/`SearchFn`/`SearchResponse`、`wasUsed`/`getClient`/`stopSession`、`createLoadAttachmentsTool({ getClient }, files)`、`createWebSearchTool(search)` の名称・シグネチャをタスク間で一致させた。
- **要検証依存:** `ai@6` 型名・`@tavily/core` 形・`environmentVariables` 名・`ToolLoopAgent.generate` の messages 形は各タスクで実機確認する旨を明記（純ロジックは実機非依存でテスト可能）。
