import { Stack, type StackProps, CfnOutput } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore'

export class AgentStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    const repository = new ecr.Repository(this, 'AgentRepo', {
      repositoryName: 'agentcore-agent',
    })

    const artifact = agentcore.AgentRuntimeArtifact.fromEcrRepository(repository, 'latest')

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
    new CfnOutput(this, 'EcrRepoUri', { value: repository.repositoryUri })
  }
}
