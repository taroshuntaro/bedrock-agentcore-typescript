// =============================================================================
// AgentCore Runtime 上で動作するエージェントのコアロジック。
// Vercel AI SDK の ToolLoopAgent に CodeInterpreterTools を組み合わせ、
// ファイルの入出力を伴う汎用タスクを処理する。
// runAgent が唯一の公開エントリポイント。defaultDeps は本番依存を生成する。
// =============================================================================
import { ToolLoopAgent } from 'ai'
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { CodeInterpreterTools } from 'bedrock-agentcore/code-interpreter/vercel-ai'
import { tavily } from '@tavily/core'
import type { AgentFile, AgentRequest, AgentResponse } from '@app/contract'
import { uploadInputFiles, collectOutputArtifacts } from './codeInterpreter'
import { createWebSearchTool, type SearchFn } from './webSearch'

// 使用するモデル ID。環境変数で上書き可能。
const MODEL_ID = process.env.AGENT_MODEL_ID ?? 'global.anthropic.claude-sonnet-4-6'

// LLM に渡すシステムインストラクション。ツール使用方針とファイル入出力の規約を指定する。
const INSTRUCTIONS = [
  'あなたは汎用アシスタントです。',
  'ファイル処理やコード実行が必要なときだけツール（Code Interpreter）を使ってください。不要なら使わないでください。',
  '入力ファイルは input/ にあります。生成物は必ず output/<name> にそのまま保存してください（画像・PDF などバイナリも変換せずそのまま保存。base64 化やコピーの複製は不要です）。',
  '最新情報や事実確認が必要なときは web_search ツールで検索してください。',
  '生成したファイルの内容や base64 文字列を最終応答に貼り付けないでください。応答ではファイルを作成した旨を簡潔に伝えてください。',
].join('\n')

// Code Interpreter クライアントの最小インターフェース。テスト時にモック注入するために分離する。
export interface AgentDeps {
  ci: {
    getClient: () => Parameters<typeof uploadInputFiles>[0] // Code Interpreter クライアントを返す
    stopSession: () => Promise<void>                        // セッションを終了してリソースを解放する
  }
  generate: (prompt: string) => Promise<string> // LLM にプロンプトを送って応答テキストを返す
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

  const agent = new ToolLoopAgent({
    model: bedrock(MODEL_ID),
    instructions: INSTRUCTIONS,
    tools: { ...ci.tools, web_search: webSearchTool },
  })
  return {
    ci,
    generate: async (prompt) => (await agent.generate({ prompt })).text,
  }
}

// ファイルがある場合、ファイル名一覧をプロンプトに付与して LLM に認識させる。
function buildPrompt(text: string, files: AgentFile[] | undefined): string {
  if (!files?.length) return text
  const listing = files.map((f) => `- input/${f.name}`).join('\n')
  return `${text}\n\n添付ファイル（input/ に配置済み）:\n${listing}`
}

// リクエストを受けてエージェントを実行し、テキスト応答と出力アーティファクトを返す。
export async function runAgent(req: AgentRequest, deps: AgentDeps): Promise<AgentResponse> {
  const client = deps.ci.getClient()
  try {
    // 入力ファイルをサンドボックスにアップロードしてからプロンプトを生成・実行する。
    await uploadInputFiles(client, req.files)
    const prompt = buildPrompt(req.text, req.files)
    const text = await deps.generate(prompt)
    // output/ に生成されたファイルを base64 アーティファクトとして回収する。
    const artifacts = await collectOutputArtifacts(client)
    return artifacts.length > 0 ? { text, artifacts } : { text }
  } finally {
    // 例外の有無に関わらず Code Interpreter セッションを終了してリソースを解放する。
    await deps.ci.stopSession()
  }
}
