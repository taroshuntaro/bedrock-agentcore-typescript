// =============================================================================
// formatSearchResult（検索結果整形）と createWebSearchTool（失敗時挙動）の単体テスト。
// =============================================================================
import { describe, it, expect } from 'vitest'
import { formatSearchResult } from './webSearch'

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
})
