// =============================================================================
// deriveSessionId の決定性・AgentCore 文字数制約充足の単体テスト。
// =============================================================================
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
