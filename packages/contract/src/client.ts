// =============================================================================
// BedrockAgentCoreClient を使ってエージェント Runtime を呼び出す invokeAgent 関数。
// ネットワーク失敗のみを指数バックオフでリトライし、レスポンスのパース失敗は即エラー。
// =============================================================================
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import { agentResponseSchema, type AgentRequest, type AgentResponse } from './types'

// invokeAgent の呼び出しオプション。
export interface InvokeOptions {
  agentRuntimeArn: string          // 呼び出し先 AgentCore Runtime の ARN
  region: string                   // AWS リージョン（例: "ap-northeast-1"）
  /** テスト等で注入する構築済みクライアント。省略時は region で新規生成する。 */
  client?: BedrockAgentCoreClient
  maxRetries?: number              // ネットワーク失敗時の最大リトライ回数（既定: 3）
  baseDelayMs?: number            // 指数バックオフの基底遅延ミリ秒（既定: 200）
}

// 指定ミリ秒だけ待機する Promise を返すユーティリティ。
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// AgentRequest を AgentCore Runtime に送信して AgentResponse を返す。
export async function invokeAgent(
  req: AgentRequest,
  opts: InvokeOptions,
): Promise<AgentResponse> {
  // オプション既定値を解決する。
  const client = opts.client ?? new BedrockAgentCoreClient({ region: opts.region })
  const maxRetries = opts.maxRetries ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 200

  // ネットワーク呼び出しのみリトライする。パース失敗はループ外で即エラーにする。
  let raw: string | undefined
  let lastErr: unknown
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // AgentCore Runtime にリクエストを送信してレスポンスボディを文字列で受け取る。
      const out = await client.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: opts.agentRuntimeArn,
          runtimeSessionId: req.sessionId,
          contentType: 'application/json',
          accept: 'application/json',
          payload: new TextEncoder().encode(JSON.stringify(req)),
        }),
      )
      if (!out.response) throw new Error('InvokeAgentRuntime returned no response body')
      raw = await out.response.transformToString()
      break
    } catch (err) {
      lastErr = err
      // 最後のリトライでなければ指数バックオフで待機する。
      if (attempt < maxRetries - 1) await sleep(baseDelayMs * 2 ** attempt)
    }
  }
  // 全リトライが失敗した場合は最後のエラーを再スローする。
  if (raw === undefined) throw lastErr
  // レスポンス本文を JSON パースして Zod スキーマで検証する。
  return agentResponseSchema.parse(JSON.parse(raw))
}
