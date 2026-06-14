// =============================================================================
// buildAgentRequest のメンション除去・セッション ID 導出の単体テスト。
// =============================================================================
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
