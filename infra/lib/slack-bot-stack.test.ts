// =============================================================================
// SlackBotStack の Lambda バンドル設定の単体テスト。
// =============================================================================
import { describe, expect, it } from 'vitest'
import { OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import { slackLambdaBundling } from './slack-bot-stack.js'

describe('SlackBotStack の Lambda バンドル設定', () => {
  it('CommonJS 依存を含む Slack worker のため CJS 形式で出力する', () => {
    expect(slackLambdaBundling.format).toBe(OutputFormat.CJS)
  })
})
