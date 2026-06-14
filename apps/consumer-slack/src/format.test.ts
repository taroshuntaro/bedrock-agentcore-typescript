import { describe, it, expect } from 'vitest'
import { toSlackMrkdwn } from './format'

// slackify は CJK に隣接する強調記号を Slack が正しく描画できるよう、
// ゼロ幅スペース(U+200B)を挿入する。比較時はそれを除去して意味だけを確認する。
const stripZeroWidth = (s: string) => s.replace(/​/g, '')

describe('toSlackMrkdwn', () => {
  it('converts bold ** to single *', () => {
    expect(stripZeroWidth(toSlackMrkdwn('**太字**'))).toBe('*太字*')
  })

  it('converts a heading to bold', () => {
    expect(toSlackMrkdwn('# 見出し')).toBe('*見出し*')
  })

  it('converts a markdown link to mrkdwn link', () => {
    expect(toSlackMrkdwn('[text](https://example.com)')).toBe('<https://example.com|text>')
  })

  it('converts a bullet list marker to •', () => {
    const out = toSlackMrkdwn('- 項目')
    expect(out.startsWith('•')).toBe(true)
    expect(out).toContain('項目')
    expect(out).not.toContain('- ')
  })

  it('keeps code block contents unconverted', () => {
    const md = '```\n**not bold** # not heading\n```'
    const out = toSlackMrkdwn(md)
    expect(out).toContain('**not bold** # not heading')
    expect(out).toContain('```')
  })

  it('returns empty string for empty input', () => {
    expect(toSlackMrkdwn('')).toBe('')
  })
})
