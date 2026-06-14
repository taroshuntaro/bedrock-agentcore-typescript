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
