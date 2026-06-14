import { describe, it, expect, vi } from 'vitest'
import { uploadInputFiles, collectOutputArtifacts } from './codeInterpreter'

function makeClient() {
  return {
    writeFiles: vi.fn().mockResolvedValue('ok'),
    readFiles: vi.fn(),
    executeCommand: vi.fn(),
  }
}

describe('uploadInputFiles', () => {
  it('writes text files decoded and binary files as .b64', async () => {
    const client = makeClient()
    await uploadInputFiles(client as any, [
      { name: 'a.csv', mimeType: 'text/csv', data: Buffer.from('1,2').toString('base64') },
      { name: 'img.png', mimeType: 'image/png', data: 'AAEC' },
    ])
    expect(client.writeFiles).toHaveBeenCalledTimes(1)
    expect(client.writeFiles.mock.calls[0][0]).toEqual({
      files: [
        { path: 'input/a.csv', content: '1,2' },
        { path: 'input/img.png.b64', content: 'AAEC' },
      ],
    })
  })

  it('does nothing when there are no files', async () => {
    const client = makeClient()
    await uploadInputFiles(client as any, [])
    expect(client.writeFiles).not.toHaveBeenCalled()
  })
})

describe('collectOutputArtifacts', () => {
  it('reads text outputs (base64-encoded) and .b64 outputs (raw base64)', async () => {
    const client = makeClient()
    client.executeCommand.mockResolvedValue('report.csv\nchart.png.b64\n')
    client.readFiles
      .mockResolvedValueOnce('col1,col2')
      .mockResolvedValueOnce(Buffer.from('PNG').toString('base64'))
    const artifacts = await collectOutputArtifacts(client as any)
    expect(artifacts).toEqual([
      { name: 'report.csv', mimeType: 'text/csv', data: Buffer.from('col1,col2').toString('base64') },
      { name: 'chart.png', mimeType: 'image/png', data: Buffer.from('PNG').toString('base64') },
    ])
  })

  it('returns empty when output/ is empty', async () => {
    const client = makeClient()
    client.executeCommand.mockResolvedValue('')
    expect(await collectOutputArtifacts(client as any)).toEqual([])
  })
})

describe('error-string handling', () => {
  it('uploadInputFiles throws when writeFiles returns an Error string', async () => {
    const client = makeClient()
    client.writeFiles.mockResolvedValue('Error: Write failed')
    await expect(
      uploadInputFiles(client as any, [{ name: 'a.csv', mimeType: 'text/csv', data: Buffer.from('1,2').toString('base64') }]),
    ).rejects.toThrow(/writeFiles failed/)
  })

  it('collectOutputArtifacts returns empty when listing errors', async () => {
    const client = makeClient()
    client.executeCommand.mockResolvedValue('Error: Command execution failed')
    expect(await collectOutputArtifacts(client as any)).toEqual([])
  })

  it('collectOutputArtifacts skips files whose read errors', async () => {
    const client = makeClient()
    client.executeCommand.mockResolvedValue('good.csv\nbad.csv\n')
    client.readFiles
      .mockResolvedValueOnce('a,b')
      .mockResolvedValueOnce('Error: Read failed')
    const artifacts = await collectOutputArtifacts(client as any)
    expect(artifacts).toEqual([
      { name: 'good.csv', mimeType: 'text/csv', data: Buffer.from('a,b').toString('base64') },
    ])
  })
})
