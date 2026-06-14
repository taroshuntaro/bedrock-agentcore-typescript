import { describe, it, expect, vi } from 'vitest'
import { runAgent } from './agent'

describe('runAgent', () => {
  it('uploads input files, runs the model, collects artifacts, and stops the session', async () => {
    const client = {
      writeFiles: vi.fn().mockResolvedValue('ok'),
      readFiles: vi.fn().mockResolvedValue(Buffer.from('PNG').toString('base64')),
      executeCommand: vi.fn().mockResolvedValue('chart.png.b64\n'),
    }
    const ci = { getClient: () => client, stopSession: vi.fn().mockResolvedValue(undefined) }
    const generate = vi.fn().mockResolvedValue('done')

    const res = await runAgent(
      { sessionId: 'x'.repeat(40), userId: 'U1', text: 'plot it', files: [{ name: 'd.csv', mimeType: 'text/csv', data: 'MSwy' }] },
      { ci: ci as any, generate },
    )

    expect(client.writeFiles).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledWith('plot it')
    expect(res.text).toBe('done')
    expect(res.artifacts?.[0].name).toBe('chart.png')
    expect(ci.stopSession).toHaveBeenCalledTimes(1)
  })

  it('stops the session even if generate throws', async () => {
    const client = {
      writeFiles: vi.fn().mockResolvedValue('ok'),
      readFiles: vi.fn(),
      executeCommand: vi.fn().mockResolvedValue(''),
    }
    const ci = { getClient: () => client, stopSession: vi.fn().mockResolvedValue(undefined) }
    const generate = vi.fn().mockRejectedValue(new Error('boom'))

    await expect(
      runAgent({ sessionId: 'x'.repeat(40), userId: 'U1', text: 'hi' }, { ci: ci as any, generate }),
    ).rejects.toThrow('boom')
    expect(ci.stopSession).toHaveBeenCalledTimes(1)
  })
})
