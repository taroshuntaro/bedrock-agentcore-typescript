import { App } from 'aws-cdk-lib'
import { AgentStack } from '../lib/agent-stack.js'

const app = new App()
new AgentStack(app, 'AgentcoreSlackAgent', {
  env: { region: process.env.CDK_DEFAULT_REGION, account: process.env.CDK_DEFAULT_ACCOUNT },
})
