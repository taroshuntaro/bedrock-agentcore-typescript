import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import { agentResponseSchema, type AgentRequest, type AgentResponse } from './types'

export interface InvokeOptions {
  agentRuntimeArn: string
  region: string
  /** Inject a pre-built client (e.g. in tests). Defaults to a new client for `region`. */
  client?: BedrockAgentCoreClient
  maxRetries?: number
  baseDelayMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function invokeAgent(
  req: AgentRequest,
  opts: InvokeOptions,
): Promise<AgentResponse> {
  const client = opts.client ?? new BedrockAgentCoreClient({ region: opts.region })
  const maxRetries = opts.maxRetries ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 200

  // Only the network call is retried. Parsing happens after the loop, so a
  // received-but-malformed response fails fast instead of being retried pointlessly.
  let raw: string | undefined
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
      if (!out.response) throw new Error('InvokeAgentRuntime returned no response body')
      raw = await out.response.transformToString()
      break
    } catch (err) {
      lastErr = err
      if (attempt < maxRetries - 1) await sleep(baseDelayMs * 2 ** attempt)
    }
  }
  if (raw === undefined) throw lastErr
  return agentResponseSchema.parse(JSON.parse(raw))
}
