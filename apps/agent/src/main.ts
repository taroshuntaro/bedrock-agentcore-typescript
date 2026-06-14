// =============================================================================
// AgentCore Runtime のエントリポイント。BedrockAgentCoreApp に invocationHandler を
// 登録し、HTTP リクエストを受けて runAgent を呼び出す HTTP サーバーを起動する。
// =============================================================================
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'
import { agentRequestSchema } from '@app/contract'
import { runAgent, defaultDeps } from './agent'

// 本番依存をプロセス起動時に一度だけ初期化する。
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
