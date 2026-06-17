// =============================================================================
// decideEvent の判定(challenge / 再送 / bot・subtype / app_mention / DM /
// テキスト空+ファイル有無)の単体テスト。
// =============================================================================
import { describe, it, expect } from 'vitest'
import { decideEvent } from './slack-event'

// event_callback 形式のボディを組み立てるヘルパ。
function callback(event: Record<string, unknown>, teamId = 'T1'): string {
  return JSON.stringify({ type: 'event_callback', team_id: teamId, event })
}

describe('decideEvent', () => {
  it('url_verification には challenge を返す', () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' })
    expect(decideEvent(body, undefined)).toEqual({ action: 'challenge', challenge: 'abc' })
  })

  it('再送(retryNum あり)は無視する', () => {
    expect(decideEvent(callback({ type: 'app_mention', text: 'x' }), '1').action).toBe('ignore')
  })

  it('bot 発言やサブタイプ付きメッセージは無視する', () => {
    expect(decideEvent(callback({ type: 'message', bot_id: 'B1', channel_type: 'im' }), undefined).action).toBe('ignore')
    expect(decideEvent(callback({ type: 'message', subtype: 'message_changed', channel_type: 'im' }), undefined).action).toBe('ignore')
  })

  it('app_mention はスレッド返信(replyThreadTs = thread_ts ?? ts)で answer になる', () => {
    const d = decideEvent(callback({ type: 'app_mention', text: '<@U1> hi', channel: 'C1', user: 'U9', ts: '111.1' }), undefined)
    expect(d).toMatchObject({
      action: 'answer', teamId: 'T1', channel: 'C1', userId: 'U9',
      rawText: '<@U1> hi', sessionThreadTs: '111.1', replyThreadTs: '111.1', files: [],
    })
  })

  it('DM(message.im) は非スレッド・channel をセッションキーにして answer になる', () => {
    const d = decideEvent(callback({ type: 'message', channel_type: 'im', text: 'hi', channel: 'D1', user: 'U9', ts: '222.2' }), undefined)
    expect(d).toMatchObject({ action: 'answer', channel: 'D1', sessionThreadTs: 'D1', files: [] })
    expect((d as { replyThreadTs?: string }).replyThreadTs).toBeUndefined()
  })

  it('テキストが空でもファイルがあれば answer にする', () => {
    const files = [{ name: 'a.csv', mimetype: 'text/csv', url_private_download: 'https://x/a.csv' }]
    const d = decideEvent(callback({ type: 'app_mention', text: '<@U1>', channel: 'C1', user: 'U9', ts: '1.1', files }), undefined)
    expect(d.action).toBe('answer')
    expect((d as { files: unknown[] }).files).toEqual([{ name: 'a.csv', mimeType: 'text/csv', urlPrivateDownload: 'https://x/a.csv' }])
  })

  it('テキスト空かつファイル無しは無視する', () => {
    const d = decideEvent(callback({ type: 'app_mention', text: '<@U1>', channel: 'C1', user: 'U9', ts: '1.1' }), undefined)
    expect(d.action).toBe('ignore')
  })
})
