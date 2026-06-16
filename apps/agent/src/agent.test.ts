// =============================================================================
// runAgent の正常系・例外系の単体テスト。
// CodeInterpreter と LLM はモックオブジェクトで代替する。
// =============================================================================
import { describe, it, expect, vi } from 'vitest'
import { runAgent, partitionFiles, type PartitionOptions } from './agent'

// テスト用の決定的なオプション（環境変数に依存させない）。
const OPTS: PartitionOptions = { pdfVisionEnabled: true, maxImageBytes: 1000, maxPdfBytes: 1000 }
// 指定バイト数ぶんの base64 文字列を作る（base64 4文字=3バイト）。
const b64OfBytes = (bytes: number) => 'A'.repeat(Math.ceil(bytes / 3) * 4)

describe('runAgent', () => {
  it('uploads input files, runs the model, collects artifacts, and stops the session', async () => {
    const client = {
      writeFiles: vi.fn().mockResolvedValue('ok'),
      executeCommand: vi.fn()
        .mockResolvedValueOnce('chart.png\n') // ls output/
        .mockResolvedValueOnce(Buffer.from('PNG').toString('base64')), // base64 output/chart.png
    }
    const ci = { getClient: () => client, stopSession: vi.fn().mockResolvedValue(undefined) }
    const generate = vi.fn().mockResolvedValue('done')

    const res = await runAgent(
      { sessionId: 'x'.repeat(40), userId: 'U1', text: 'plot it', files: [{ name: 'd.csv', mimeType: 'text/csv', data: 'MSwy' }] },
      { ci: ci as any, generate },
    )

    expect(client.writeFiles).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledWith('plot it\n\n添付ファイル（input/ に配置済み）:\n- input/d.csv')
    expect(res.text).toBe('done')
    expect(res.artifacts?.[0].name).toBe('chart.png')
    expect(ci.stopSession).toHaveBeenCalledTimes(1)
  })

  it('stops the session even if generate throws', async () => {
    const client = {
      writeFiles: vi.fn().mockResolvedValue('ok'),
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

describe('partitionFiles', () => {
  it('対応画像と PDF は vision、その他は一覧のみに分類する', () => {
    const { visionFiles, listingOnly } = partitionFiles([
      { name: 'a.png', mimeType: 'image/png', data: b64OfBytes(10) },
      { name: 'b.csv', mimeType: 'text/csv', data: b64OfBytes(10) },
      { name: 'c.pdf', mimeType: 'application/pdf', data: b64OfBytes(10) },
    ], OPTS)
    expect(visionFiles.map((f) => f.name)).toEqual(['a.png', 'c.pdf'])
    expect(listingOnly.map((f) => f.name)).toEqual(['b.csv'])
  })

  it('サイズ超過の画像は一覧のみに落とす', () => {
    const { visionFiles, listingOnly } = partitionFiles([
      { name: 'big.png', mimeType: 'image/png', data: b64OfBytes(2000) },
    ], OPTS)
    expect(visionFiles).toEqual([])
    expect(listingOnly.map((f) => f.name)).toEqual(['big.png'])
  })

  it('pdfVisionEnabled が false なら PDF を一覧のみに倒す', () => {
    const { visionFiles, listingOnly } = partitionFiles([
      { name: 'c.pdf', mimeType: 'application/pdf', data: b64OfBytes(10) },
    ], { ...OPTS, pdfVisionEnabled: false })
    expect(visionFiles).toEqual([])
    expect(listingOnly.map((f) => f.name)).toEqual(['c.pdf'])
  })

  it('未対応の画像形式は一覧のみに落とす', () => {
    const { visionFiles, listingOnly } = partitionFiles([
      { name: 'x.bmp', mimeType: 'image/bmp', data: b64OfBytes(10) },
    ], OPTS)
    expect(visionFiles).toEqual([])
    expect(listingOnly.map((f) => f.name)).toEqual(['x.bmp'])
  })
})
