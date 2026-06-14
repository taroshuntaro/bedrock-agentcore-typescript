import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Stack, type StackProps, CfnOutput } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Platform } from 'aws-cdk-lib/aws-ecr-assets'
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore'

// このファイル（infra/lib）から見たリポジトリルート。Dockerfile が置かれている。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export class AgentStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    // CDK がリポジトリルートの Dockerfile をビルドし、ブートストラップ管理の ECR に
    // push してから Runtime を作成する。これにより「イメージ未存在」での作成失敗を防ぐ。
    // AgentCore Runtime は linux/arm64 イメージを要求するため platform を明示する。
    const artifact = agentcore.AgentRuntimeArtifact.fromAsset(repoRoot, {
      platform: Platform.LINUX_ARM64,
    })

    const runtime = new agentcore.Runtime(this, 'AgentRuntime', {
      runtimeName: 'slackAgent',
      agentRuntimeArtifact: artifact,
    })

    runtime.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    }))

    runtime.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:StartCodeInterpreterSession',
        'bedrock-agentcore:InvokeCodeInterpreter',
        'bedrock-agentcore:StopCodeInterpreterSession',
        'bedrock-agentcore:GetCodeInterpreterSession',
        'bedrock-agentcore:ListCodeInterpreterSessions',
      ],
      resources: ['*'],
    }))

    new CfnOutput(this, 'AgentRuntimeArn', { value: runtime.agentRuntimeArn })
  }
}
