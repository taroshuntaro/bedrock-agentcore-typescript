// =============================================================================
// Slack コンシューマーをサーバーレス化する CDK スタック。
// 受信 Lambda(Function URL・3 秒制約内応答)と応答 Lambda(AgentCore 呼び出し + Slack 投稿)
// の 2 段構成。Slack トークンは事前手動作成済みの SSM SecureString から読み取る。
// AgentStack とは独立に `cdk deploy SlackBot` で選択デプロイできる。
// =============================================================================
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Stack, type StackProps, Duration, CfnOutput } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs'
import { OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'

// このファイル(infra/lib)から見たリポジトリルート。Lambda エントリの基点。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// SlackBotStack のデプロイ時パラメータ。
export interface SlackBotStackProps extends StackProps {
  readonly agentRuntimeArn: string // 呼び出し先 AgentCore Runtime の ARN
}

// 事前手動作成する SSM SecureString パラメータ名(CFn は SecureString を作成できないため参照のみ)。
const SIGNING_SECRET_PARAM = '/agentcore-slack/slack-bot/signing-secret'
const BOT_TOKEN_PARAM = '/agentcore-slack/slack-bot/bot-token'

// Slack サーバーレスコンシューマー一式を定義するスタック。
export class SlackBotStack extends Stack {
  constructor(scope: Construct, id: string, props: SlackBotStackProps) {
    super(scope, id, props)

    // SSM SecureString パラメータの ARN(読み取り権限のスコープに使う)。
    const paramArn = (name: string) => `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`

    // NodejsFunction 共通のバンドル設定。ESM 出力・minify・node24 ターゲット。
    const commonBundling = { minify: true, target: 'node24', format: OutputFormat.ESM }
    const depsLockFilePath = path.join(repoRoot, 'pnpm-lock.yaml')

    // --- 応答 Lambda(ファイル DL → invokeAgent → Slack 投稿) ---
    // 非同期起動の自動リトライは 0(失敗時の二重投稿防止)。AgentCore + Code Interpreter
    // を待つため timeout を長く、base64 バッファ用に memory も大きめに取る。
    const workerFn = new lambdaNode.NodejsFunction(this, 'WorkerFunction', {
      entry: path.join(repoRoot, 'apps/consumer-slack/src/worker.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: Duration.seconds(300),
      memorySize: 1024,
      retryAttempts: 0,
      depsLockFilePath,
      environment: {
        AGENT_RUNTIME_ARN: props.agentRuntimeArn,
        SLACK_BOT_TOKEN_PARAM: BOT_TOKEN_PARAM,
      },
      bundling: commonBundling,
    })
    // bot token の読み取り(SecureString 復号含む)。
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [paramArn(BOT_TOKEN_PARAM)],
    }))
    // AgentCore Runtime の呼び出し。
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [props.agentRuntimeArn, `${props.agentRuntimeArn}/*`],
    }))
    // SecureString 復号用 KMS。既定の aws/ssm キー経由のみに限定する。
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    }))

    // --- 受信 Lambda(署名検証 → 応答 Lambda の非同期起動) ---
    // 公開エンドポイントのため reserved concurrency で同時実行を絞る。
    const receiverFn = new lambdaNode.NodejsFunction(this, 'ReceiverFunction', {
      entry: path.join(repoRoot, 'apps/consumer-slack/src/receiver.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: Duration.seconds(10),
      memorySize: 256,
      reservedConcurrentExecutions: 5,
      depsLockFilePath,
      environment: {
        WORKER_FUNCTION_NAME: workerFn.functionName,
        SLACK_SIGNING_SECRET_PARAM: SIGNING_SECRET_PARAM,
      },
      bundling: commonBundling,
    })
    // signing secret の読み取り(SecureString 復号含む)。
    receiverFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [paramArn(SIGNING_SECRET_PARAM)],
    }))
    receiverFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    }))
    // 受信が応答 Lambda を起動できるようにする。
    workerFn.grantInvoke(receiverFn)

    // --- Slack の Events Request URL になる Function URL(認可は署名検証で担保) ---
    const fnUrl = receiverFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE })

    // --- デプロイ後に参照する値を出力 ---
    new CfnOutput(this, 'SlackEventsUrl', { value: fnUrl.url })
  }
}
