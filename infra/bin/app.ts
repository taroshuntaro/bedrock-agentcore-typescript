// =============================================================================
// CDK アプリケーションのエントリポイント。AgentStack と SlackBotStack を
// ap-northeast-1 にデプロイする。SlackBotStack は AgentStack の Runtime ARN を受け取る。
// =============================================================================
import { App } from 'aws-cdk-lib'
import { AgentStack } from '../lib/agent-stack.js'
import { SlackBotStack } from '../lib/slack-bot-stack.js'

const app = new App()
// 配置先リージョン(環境変数未設定時は ap-northeast-1)。
const env = {
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
  account: process.env.CDK_DEFAULT_ACCOUNT,
}

// AgentCore Runtime 本体。
const agent = new AgentStack(app, 'AgentcoreSlackAgent', { env })

// Slack サーバーレスコンシューマー。Runtime ARN を prop で受け取る(クロススタック参照)。
new SlackBotStack(app, 'AgentcoreSlackBot', {
  env,
  agentRuntimeArn: agent.agentRuntimeArn,
})
