// =============================================================================
// Slack への応答ハンドラ(SDK 呼び出し層)。受信 Lambda から非同期起動され、
// 添付ファイルをダウンロード → invokeAgent(AgentCore Runtime)→ mrkdwn 変換 →
// Slack 投稿(テキスト + 成果物)を行う。非同期起動の自動リトライは 0 のため、
// エラー通知はここで 1 回だけ行う。
// =============================================================================
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { WebClient } from '@slack/web-api'
import { invokeAgent, type AgentFile } from '@app/contract'
import { buildAgentRequest } from './mapping'
import { toSlackMrkdwn } from './format'
import type { SlackFileRef } from './slack-event'

// 受信 Lambda から非同期 Invoke で渡される処理依頼。
export interface WorkerPayload {
  teamId: string             // Slack ワークスペース ID
  channel: string            // 返信先チャンネル(DM 含む)
  userId: string             // 発言者の ID
  rawText: string            // メンションを含む生テキスト
  sessionThreadTs: string    // セッション導出用(DM では channel ID)
  replyThreadTs?: string     // 返信の thread_ts(DM では undefined)
  files: SlackFileRef[]      // 添付ファイルのメタデータ一覧
}

// AWS SDK クライアント(コールドスタート時に 1 度だけ生成して再利用)。
const region = process.env.AWS_REGION ?? 'ap-northeast-1'
const ssm = new SSMClient({ region })
const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN!

// bot token のキャッシュ(コールドスタート後は再利用)。
let cachedBotToken: string | undefined

// SSM SecureString から bot token を復号取得する。
async function getBotToken(): Promise<string> {
  if (cachedBotToken) return cachedBotToken
  const out = await ssm.send(new GetParameterCommand({ Name: process.env.SLACK_BOT_TOKEN_PARAM!, WithDecryption: true }))
  const value = out.Parameter?.Value
  if (!value) throw new Error('SSM に bot token がありません')
  cachedBotToken = value
  return value
}

// Slack のファイルメタデータを bot トークンで認証ダウンロードし base64 AgentFile 化する。
async function downloadFiles(files: SlackFileRef[], token: string): Promise<AgentFile[]> {
  const out: AgentFile[] = []
  for (const f of files) {
    const res = await fetch(f.urlPrivateDownload, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) continue
    const buf = Buffer.from(await res.arrayBuffer())
    out.push({ name: f.name, mimeType: f.mimeType, data: buf.toString('base64') })
  }
  return out
}

// ハンドラ本体。失敗時はエラーメッセージを 1 回だけ投稿し、それも失敗したらログのみ。
export async function handler(event: WorkerPayload): Promise<void> {
  const token = await getBotToken()
  const web = new WebClient(token)
  try {
    // 添付ファイルをダウンロードして AgentRequest を組み立てる。
    const files = await downloadFiles(event.files, token)
    const req = buildAgentRequest({
      teamId: event.teamId,
      channel: event.channel,
      threadTs: event.sessionThreadTs,
      userId: event.userId,
      rawText: event.rawText,
      files,
    })
    // AgentCore Runtime を呼び出す。
    const res = await invokeAgent(req, { agentRuntimeArn, region })
    // Markdown を Slack mrkdwn に変換して投稿する。
    await web.chat.postMessage({ channel: event.channel, thread_ts: event.replyThreadTs, text: toSlackMrkdwn(res.text ?? '') || '(空の応答)' })
    // 成果物があれば file_uploads でまとめて 1 回でアップロードする。
    const artifacts = res.artifacts ?? []
    if (artifacts.length > 0) {
      await web.files.uploadV2({
        channel_id: event.channel,
        thread_ts: event.replyThreadTs,
        file_uploads: artifacts.map((a) => ({ filename: a.name, file: Buffer.from(a.data, 'base64') })),
      })
    }
  } catch (e) {
    console.error(`応答処理に失敗: ${(e as Error).message}`)
    try {
      await web.chat.postMessage({ channel: event.channel, thread_ts: event.replyThreadTs, text: `エラーが発生しました: ${(e as Error).message}` })
    } catch (e2) {
      console.error(`エラーメッセージの投稿にも失敗: ${(e2 as Error).message}`)
    }
  }
}
