import { createHash } from 'node:crypto'

/**
 * Slack 由来の識別子から AgentCore runtimeSessionId（33-256文字）を決定的に導出する。
 * sha256 hex は 64 文字で制約を満たす。
 */
export function deriveSessionId(parts: string[]): string {
  return createHash('sha256').update(parts.join(':')).digest('hex')
}
