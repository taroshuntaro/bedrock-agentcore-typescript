// =============================================================================
// CDK アプリケーションのエントリポイント。AgentStack を ap-northeast-1 にデプロイする。
// =============================================================================
import { App } from 'aws-cdk-lib'
import { AgentStack } from '../lib/agent-stack.js'

const app = new App()
// スタックをデフォルトリージョン（環境変数未設定時は ap-northeast-1）に配置する。
new AgentStack(app, 'AgentcoreSlackAgent', {
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
})
