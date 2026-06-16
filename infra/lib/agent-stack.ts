// =============================================================================
// AgentCore Runtime をデプロイする CDK スタック。
// リポジトリルートの Dockerfile を linux/arm64 でビルドして ECR に push し、
// Runtime を作成して Bedrock 呼び出し・CodeInterpreter 操作の IAM 権限を付与する。
// =============================================================================
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Stack, type StackProps, CfnOutput } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Platform } from 'aws-cdk-lib/aws-ecr-assets'
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore'

// このファイル（infra/lib）から見たリポジトリルート。Dockerfile が置かれている。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// Slack エージェント用の AgentCore Runtime および必要な IAM ポリシーを定義するスタック。
export class AgentStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    // CDK がリポジトリルートの Dockerfile をビルドし、ブートストラップ管理の ECR に
    // push してから Runtime を作成する。これにより「イメージ未存在」での作成失敗を防ぐ。
    // AgentCore Runtime は linux/arm64 イメージを要求するため platform を明示する。
    const artifact = agentcore.AgentRuntimeArtifact.fromAsset(repoRoot, {
      platform: Platform.LINUX_ARM64,
    })

    // AgentCore Runtime を作成する。Web 検索ツール用に TAVILY_API_KEY をデプロイ時の
    // 環境変数から注入する（値はコミットしない）。
    const runtime = new agentcore.Runtime(this, 'AgentRuntime', {
      runtimeName: 'slackAgent',
      agentRuntimeArtifact: artifact,
      environmentVariables: {
        TAVILY_API_KEY: process.env.TAVILY_API_KEY ?? '',
      },
    })

    // Bedrock モデル呼び出し権限を付与する。
    runtime.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    }))

    // Code Interpreter セッション操作権限を付与する。
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

    // consumer-slack が AGENT_RUNTIME_ARN として参照できるよう出力する。
    new CfnOutput(this, 'AgentRuntimeArn', { value: runtime.agentRuntimeArn })
  }
}
