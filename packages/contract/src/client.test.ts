// =============================================================================
// invokeAgent のリトライ挙動・レスポンスパースの単体テスト。
// BedrockAgentCoreClient は vi.mock でスタブする。
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendMock = vi.fn()
vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: vi.fn(() => ({ send: sendMock })),
  InvokeAgentRuntimeCommand: vi.fn((input) => ({ input })),
}))

import { invokeAgent } from './client'

function streamOf(obj: unknown) { return { transformToString: async () => JSON.stringify(obj) } }

describe('invokeAgent', () => {
  beforeEach(() => sendMock.mockReset())

  it('parses a successful response', async () => {
    sendMock.mockResolvedValueOnce({ response: streamOf({ text: 'hi', artifacts: [] }) })
    const res = await invokeAgent(
      { sessionId: 'x'.repeat(40), userId: 'U1', text: 'hello' },
      { agentRuntimeArn: 'arn:aws:...:runtime/foo', region: 'us-east-1' },
    )
    expect(res.text).toBe('hi')
    expect(res.artifacts).toEqual([])
  })

  it('retries once then succeeds', async () => {
    sendMock
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({ response: streamOf({ text: 'ok' }) })
    const res = await invokeAgent(
      { sessionId: 'x'.repeat(40), userId: 'U1', text: 'hello' },
      { agentRuntimeArn: 'arn:aws:...:runtime/foo', region: 'us-east-1', maxRetries: 2, baseDelayMs: 1 },
    )
    expect(res.text).toBe('ok')
    expect(sendMock).toHaveBeenCalledTimes(2)
  })
})
