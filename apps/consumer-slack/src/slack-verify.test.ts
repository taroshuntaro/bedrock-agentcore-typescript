// =============================================================================
// verifySlackSignature の署名検証・タイムスタンプ窓・ヘッダ欠落の単体テスト。
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifySlackSignature } from './slack-verify'

// テスト用に正しい署名を生成するヘルパ。
function sign(secret: string, ts: string, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`
}

describe('verifySlackSignature', () => {
  const secret = 'shhh'
  const body = '{"type":"event_callback"}'
  const now = 1_700_000_000

  it('正しい署名とタイムスタンプを受理する', () => {
    const ts = String(now)
    const res = verifySlackSignature({ signingSecret: secret, body, timestamp: ts, signature: sign(secret, ts, body), nowEpochSec: now })
    expect(res).toEqual({ ok: true })
  })

  it('署名が一致しない場合は拒否する', () => {
    const ts = String(now)
    const res = verifySlackSignature({ signingSecret: secret, body, timestamp: ts, signature: 'v0=deadbeef', nowEpochSec: now })
    expect(res.ok).toBe(false)
  })

  it('タイムスタンプが許容窓(±5分)を超える場合は拒否する', () => {
    const ts = String(now - 600)
    const res = verifySlackSignature({ signingSecret: secret, body, timestamp: ts, signature: sign(secret, ts, body), nowEpochSec: now })
    expect(res.ok).toBe(false)
  })

  it('必須ヘッダが欠落している場合は拒否する', () => {
    const res = verifySlackSignature({ signingSecret: secret, body, timestamp: undefined, signature: undefined, nowEpochSec: now })
    expect(res.ok).toBe(false)
  })
})
