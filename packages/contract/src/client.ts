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
