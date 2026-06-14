// =============================================================================
// uploadInputFiles・collectOutputArtifacts およびエラー文字列ハンドリングの単体テスト。
// CodeInterpreter クライアントはモックオブジェクトで代替する。
// =============================================================================
import { describe, it, expect, vi } from 'vitest'
import { uploadInputFiles, collectOutputArtifacts } from './codeInterpreter'

function makeClient() {
  return {
    writeFiles: vi.fn().mockResolvedValue('ok'),
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
  it('base64-encodes each output file via executeCommand', async () => {
    const client = makeClient()
    client.executeCommand
      .mockResolvedValueOnce('report.csv\nchart.png\n') // ls
      .mockResolvedValueOnce(Buffer.from('col1,col2').toString('base64') + '\n') // base64 report.csv
      .mockResolvedValueOnce(Buffer.from('PNG').toString('base64') + '\n') // base64 chart.png
    const artifacts = await collectOutputArtifacts(client as any)
    expect(artifacts).toEqual([
      { name: 'report.csv', mimeType: 'text/csv', data: Buffer.from('col1,col2').toString('base64') },
      { name: 'chart.png', mimeType: 'image/png', data: Buffer.from('PNG').toString('base64') },
    ])
    // 各ファイルはサンドボックス内で base64 エンコードして安全に読み出す。
    expect(client.executeCommand).toHaveBeenNthCalledWith(2, { command: 'base64 -w0 "output/report.csv"' })
    expect(client.executeCommand).toHaveBeenNthCalledWith(3, { command: 'base64 -w0 "output/chart.png"' })
  })

  it('maps known extensions including pdf', async () => {
    const client = makeClient()
    client.executeCommand
      .mockResolvedValueOnce('doc.pdf\n')
      .mockResolvedValueOnce('QQ==')
    const artifacts = await collectOutputArtifacts(client as any)
    expect(artifacts).toEqual([{ name: 'doc.pdf', mimeType: 'application/pdf', data: 'QQ==' }])
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

  it('collectOutputArtifacts skips files whose encoding errors', async () => {
    const client = makeClient()
    client.executeCommand
      .mockResolvedValueOnce('good.csv\nbad.csv\n') // ls
      .mockResolvedValueOnce(Buffer.from('a,b').toString('base64')) // base64 good.csv
      .mockResolvedValueOnce('Error: Read failed') // base64 bad.csv
    const artifacts = await collectOutputArtifacts(client as any)
    expect(artifacts).toEqual([
      { name: 'good.csv', mimeType: 'text/csv', data: Buffer.from('a,b').toString('base64') },
    ])
  })
})
