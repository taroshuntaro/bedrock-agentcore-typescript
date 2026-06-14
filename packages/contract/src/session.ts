// =============================================================================
// Slack イベントの識別子から AgentCore runtimeSessionId を決定的に導出するユーティリティ。
// =============================================================================
import { createHash } from 'node:crypto'

// parts を ':' で結合した SHA-256 ハッシュ（64 文字）を返す。AgentCore の 33-256 文字制約を満たす。
export function deriveSessionId(parts: string[]): string {
  return createHash('sha256').update(parts.join(':')).digest('hex')
}
