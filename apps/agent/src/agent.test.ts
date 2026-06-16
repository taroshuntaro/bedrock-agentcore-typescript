// =============================================================================
// runAgent の正常系・例外系の単体テスト。
// CodeInterpreter と LLM はモックオブジェクトで代替する。
// =============================================================================
import { describe, it, expect, vi } from 'vitest'
import { runAgent, partitionFiles, type PartitionOptions, buildMessages, buildInstructions } from './agent'

// テスト用の決定的なオプション（環境変数に依存させない）。
const OPTS: PartitionOptions = { pdfVisionEnabled: true, maxImageBytes: 1000, maxPdfBytes: 1000 }
// 指定バイト数ぶんの base64 文字列を作る（base64 4文字=3バイト）。
const b64OfBytes = (bytes: number) => 'A'.repeat(Math.ceil(bytes / 3) * 4)

describe('runAgent', () => {
  it('buildMessages の content と files で generate を呼び、used なら artifacts を回収する', async () => {
    const client = {
      executeCommand: vi.fn()
        .mockResolvedValueOnce('chart.png\n') // ls output/
        .mockResolvedValueOnce(Buffer.from('PNG').toString('base64')), // base64 output/chart.png
    }
    const ci = {
      getClient: () => client,
      stopSession: vi.fn().mockResolvedValue(undefined),
      wasUsed: () => true, // サンドボックスが使われた
    }
    const generate = vi.fn().mockResolvedValue('done')

    const res = await runAgent(
      { sessionId: 'x'.repeat(40), userId: 'U1', text: 'plot it', files: [{ name: 'd.csv', mimeType: 'text/csv', data: 'MSwy' }] },
      { ci: ci as any, generate },
    )

    // content（buildMessages の戻り）と files が渡る。
    const [content, files] = generate.mock.calls[0]
    expect(content[0]).toEqual({ type: 'text', text: 'plot it' })
    expect(files).toEqual([{ name: 'd.csv', mimeType: 'text/csv', data: 'MSwy' }])
    expect(res.text).toBe('done')
    expect(res.artifacts?.[0].name).toBe('chart.png')
    expect(ci.stopSession).toHaveBeenCalledTimes(1)
  })

  it('サンドボックス未使用なら artifacts を回収せずセッションも停止しない', async () => {
    const client = { executeCommand: vi.fn() }
    const ci = {
      getClient: () => client,
      stopSession: vi.fn().mockResolvedValue(undefined),
      wasUsed: () => false, // 純 vision クエリ
    }
    const generate = vi.fn().mockResolvedValue('画像は猫です')

    const res = await runAgent(
      { sessionId: 'x'.repeat(40), userId: 'U1', text: 'これは何？', files: [{ name: 'a.png', mimeType: 'image/png', data: 'AAEC' }] },
      { ci: ci as any, generate },
    )

    expect(res.text).toBe('画像は猫です')
    expect(res.artifacts).toBeUndefined()
    expect(client.executeCommand).not.toHaveBeenCalled()
    expect(ci.stopSession).not.toHaveBeenCalled()
  })

  it('used なら generate が例外でもセッションを停止する', async () => {
    const ci = {
      getClient: () => ({ executeCommand: vi.fn() }),
      stopSession: vi.fn().mockResolvedValue(undefined),
      wasUsed: () => true,
    }
    const generate = vi.fn().mockRejectedValue(new Error('boom'))

    await expect(
      runAgent({ sessionId: 'x'.repeat(40), userId: 'U1', text: 'hi' }, { ci: ci as any, generate }),
    ).rejects.toThrow('boom')
    expect(ci.stopSession).toHaveBeenCalledTimes(1)
  })
})

describe('buildInstructions', () => {
  it('現在日時を日本時間で埋め込む', () => {
    // UTC 2026-06-17T03:00:00Z = JST 2026年6月17日 12:00。
    const s = buildInstructions(new Date('2026-06-17T03:00:00Z'))
    expect(s).toContain('2026年6月17日')
    expect(s).toContain('日本時間')
  })

  it('日付境界をまたぐ深夜 UTC でも JST の日付になる', () => {
    // UTC 2026-06-16T20:00:00Z = JST 2026年6月17日 05:00。
    const s = buildInstructions(new Date('2026-06-16T20:00:00Z'))
    expect(s).toContain('2026年6月17日')
  })

  it('時事質問では web_search で grounding するよう強制する', () => {
    const s = buildInstructions(new Date('2026-06-17T03:00:00Z'))
    expect(s).toContain('web_search')
    expect(s).toContain('検索結果のみに基づいて')
    expect(s).toContain('検索結果を優先')
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

describe('buildMessages', () => {
  it('ファイルが無ければテキストのみのパートを返す', () => {
    expect(buildMessages('こんにちは', [])).toEqual([{ type: 'text', text: 'こんにちは' }])
  })

  it('画像は vision パートに、全ファイルは一覧テキストに含める', () => {
    const parts = buildMessages('説明して', [
      { name: 'a.png', mimeType: 'image/png', data: b64OfBytes(10) },
      { name: 'b.csv', mimeType: 'text/csv', data: b64OfBytes(10) },
    ], OPTS)
    expect(parts[0]).toEqual({ type: 'text', text: '説明して' })
    const image = parts.find((p: any) => p.type === 'image') as any
    expect(image.mediaType).toBe('image/png')
    expect(Buffer.isBuffer(image.image)).toBe(true)
    const listing = parts[parts.length - 1] as any
    expect(listing.type).toBe('text')
    expect(listing.text).toContain('- input/a.png (image/png)')
    expect(listing.text).toContain('- input/b.csv (text/csv)')
  })

  it('PDF は file パートとして含める', () => {
    const parts = buildMessages('読んで', [
      { name: 'c.pdf', mimeType: 'application/pdf', data: b64OfBytes(10) },
    ], OPTS)
    const file = parts.find((p: any) => p.type === 'file') as any
    expect(file.mediaType).toBe('application/pdf')
    expect(Buffer.isBuffer(file.data)).toBe(true)
  })
})
