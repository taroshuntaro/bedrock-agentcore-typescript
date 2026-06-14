import { describe, it, expect } from 'vitest'
import { agentRequestSchema, agentResponseSchema } from './types'

describe('agentRequestSchema', () => {
  it('parses a valid request with a file', () => {
    const parsed = agentRequestSchema.parse({
      sessionId: 'x'.repeat(40),
      userId: 'U123',
      text: 'hello',
      files: [{ name: 'a.csv', mimeType: 'text/csv', data: 'YWJj' }],
    })
    expect(parsed.files?.[0].name).toBe('a.csv')
  })

  it('rejects a missing text field', () => {
    expect(() => agentRequestSchema.parse({ sessionId: 's', userId: 'u' })).toThrow()
  })
})

describe('agentResponseSchema', () => {
  it('parses a response with artifacts', () => {
    const parsed = agentResponseSchema.parse({
      text: 'done',
      artifacts: [{ name: 'out.png', mimeType: 'image/png', data: 'YWJj' }],
    })
    expect(parsed.artifacts?.[0].mimeType).toBe('image/png')
  })
})
