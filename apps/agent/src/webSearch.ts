// =============================================================================
// Tavily を用いた Web 検索ツール。検索結果を LLM 向け文字列に整形する純関数
// formatSearchResult と、検索関数を注入して AI SDK ツールを生成する
// createWebSearchTool を提供する。失敗時は例外ではなくエラー文字列を返す。
// =============================================================================
import { tool } from 'ai'
import { z } from 'zod'

// 検索結果1件（Tavily の results 要素のうち必要な項目）。
export interface SearchSource {
  title: string   // ページタイトル
  url: string     // ページ URL
  content: string // 抜粋スニペット
}

// 検索のレスポンス（必要分のみ）。
export interface SearchResponse {
  answer?: string         // Tavily の合成回答（include_answer）
  results: SearchSource[] // 検索ヒット
}

// 検索を実行する関数の型。テスト時に差し替え可能にするため注入する。
export type SearchFn = (query: string) => Promise<SearchResponse>

// 各ソースの content の最大文字数。Tavily の content はナビゲーションリンク等の
// ノイズで数千文字に膨らむことがあり、トークン浪費と要点埋没を招くため切り詰める。
const MAX_CONTENT_CHARS = 600

// 文字列を最大長で切り詰める（超過時のみ末尾に … を付す）。
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// 検索結果を LLM 向けの単一文字列に整形する（合成回答 + 上位5ソース）。
// content はノイズ抑制のため MAX_CONTENT_CHARS で切り詰める。
export function formatSearchResult(res: SearchResponse): string {
  const lines: string[] = []
  if (res.answer) {
    lines.push(`回答: ${res.answer}`, '')
  }
  lines.push('ソース:')
  res.results.slice(0, 5).forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title}`, `   ${s.url}`, `   ${truncate(s.content, MAX_CONTENT_CHARS)}`)
  })
  return lines.join('\n')
}

// Web 検索ツールを生成する。search に実際の検索呼び出しを注入する。
export function createWebSearchTool(search: SearchFn) {
  return tool({
    description: 'Web を検索して最新情報や事実を取得する。最新性の確認や裏取りが必要なときに使う。',
    inputSchema: z.object({ query: z.string().describe('検索クエリ') }),
    // 失敗時は例外を投げず「検索に失敗しました: …」を返し、エージェント全体を止めない。
    execute: async ({ query }) => {
      try {
        return formatSearchResult(await search(query))
      } catch (e) {
        return `検索に失敗しました: ${(e as Error).message}`
      }
    },
  })
}
