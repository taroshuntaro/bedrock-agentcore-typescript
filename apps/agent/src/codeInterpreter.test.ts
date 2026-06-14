import { describe, it, expect, vi } from 'vitest'

const writeFiles = vi.fn().mockResolvedValue(undefined)
const readFiles = vi.fn().mockResolvedValue(JSON.stringify({ blob: Buffer.from('PNG').toString('base64') }))
const executeCommand = vi.fn().mockResolvedValue(JSON.stringify({ stdout: 'out.png\n' }))

vi.mock('bedrock-agentcore', () => ({
  CodeInterpreterTools: vi.fn(() => ({
    getClient: () => ({ writeFiles, readFiles, executeCommand }),
  })),
}))

import { uploadInputFiles, collectOutputArtifacts } from './codeInterpreter'

describe('uploadInputFiles', () => {
  it('writes each input file to the sandbox', async () => {
    const client = { writeFiles, readFiles, executeCommand } as any
    await uploadInputFiles(client, [{ name: 'a.csv', mimeType: 'text/csv', data: Buffer.from('1,2').toString('base64') }])
    expect(writeFiles).toHaveBeenCalledTimes(1)
  })
})

describe('collectOutputArtifacts', () => {
  it('lists output/ and reads files back as artifacts', async () => {
    const client = { writeFiles, readFiles, executeCommand } as any
    const artifacts = await collectOutputArtifacts(client)
    expect(artifacts[0].name).toBe('out.png')
    expect(Buffer.from(artifacts[0].data, 'base64').toString()).toBe('PNG')
  })
})
