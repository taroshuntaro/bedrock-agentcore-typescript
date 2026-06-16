// =============================================================================
// formatSearchResult（検索結果整形）と createWebSearchTool（失敗時挙動）の単体テスト。
// =============================================================================
import { describe, it, expect } from 'vitest'
import { formatSearchResult, createWebSearchTool } from './webSearch'

describe('formatSearchResult', () => {
  it('合成回答と上位ソースを整形する', () => {
    const out = formatSearchResult({
      answer: 'TypeScript は静的型付け言語です。',
      results: [
        { title: 'TS 公式', url: 'https://ts.example/a', content: '型の概要' },
        { title: 'Wiki', url: 'https://ts.example/b', content: '歴史' },
      ],
    })
    expect(out).toContain('回答: TypeScript は静的型付け言語です。')
    expect(out).toContain('1. TS 公式')
    expect(out).toContain('https://ts.example/a')
    expect(out).toContain('2. Wiki')
  })

  it('ソースを上位5件に制限する', () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      title: `t${i}`, url: `https://x/${i}`, content: `c${i}`,
    }))
    const out = formatSearchResult({ answer: undefined, results })
    expect(out).toContain('5. t4')
    expect(out).not.toContain('6. t5')
  })

  it('回答が無くてもソースだけ整形する', () => {
    const out = formatSearchResult({ answer: undefined, results: [{ title: 't', url: 'u', content: 'c' }] })
    expect(out).not.toContain('回答:')
    expect(out).toContain('1. t')
  })

  it('長大な content は 600 文字で切り詰めて … を付す', () => {
    const long = 'x'.repeat(2000)
    const out = formatSearchResult({ answer: undefined, results: [{ title: 't', url: 'u', content: long }] })
    expect(out).toContain('x'.repeat(600) + '…')
    expect(out).not.toContain('x'.repeat(601))
  })

  it('短い content はそのまま（… を付けない）', () => {
    const out = formatSearchResult({ answer: undefined, results: [{ title: 't', url: 'u', content: '短い本文' }] })
    expect(out).toContain('   短い本文')
    expect(out).not.toContain('…')
  })
})

describe('createWebSearchTool', () => {
  it('検索成功時は整形結果を返す', async () => {
    const t = createWebSearchTool(async () => ({
      answer: 'ans', results: [{ title: 't', url: 'u', content: 'c' }],
    }))
    const out = await (t as any).execute({ query: 'q' }, {} as any)
    expect(out).toContain('回答: ans')
    expect(out).toContain('1. t')
  })

  it('検索失敗時はエラー文字列を返し例外を投げない', async () => {
    const t = createWebSearchTool(async () => { throw new Error('rate limit') })
    const out = await (t as any).execute({ query: 'q' }, {} as any)
    expect(out).toBe('検索に失敗しました: rate limit')
  })
})
