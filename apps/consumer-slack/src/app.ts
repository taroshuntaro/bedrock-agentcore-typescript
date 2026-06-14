// =============================================================================
// Slack Bolt (Socket Mode) アダプター。app_mention イベントを受けて
// 添付ファイルをダウンロードし、@app/contract の invokeAgent を通じてエージェントを
// 呼び出し、応答テキストと成果物ファイルをスレッドに投稿する。
// =============================================================================
import 'dotenv/config'
import { App } from '@slack/bolt'
import { invokeAgent, type AgentFile } from '@app/contract'
import { buildAgentRequest } from './mapping'
import { toSlackMrkdwn } from './format'

// Socket Mode で Slack に接続する Bolt アプリを初期化する。
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
})

const region = process.env.AWS_REGION ?? 'ap-northeast-1'
const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN!

// メッセージに添付された Slack ファイルを base64 AgentFile として一括ダウンロードする。
async function downloadSlackFiles(files: any[] | undefined, token: string): Promise<AgentFile[]> {
  if (!files?.length) return []
  const out: AgentFile[] = []
  // Bot トークンで private ダウンロード URL に認証してバイナリを取得する。
  for (const f of files) {
    const res = await fetch(f.url_private_download, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) continue
    const buf = Buffer.from(await res.arrayBuffer())
    out.push({ name: f.name, mimeType: f.mimetype, data: buf.toString('base64') })
  }
  return out
}

// ボットへのメンションを受けてエージェントを呼び出し、応答をスレッドに投稿する。
app.event('app_mention', async ({ event, client, say }) => {
  const e = event as any
  const threadTs = e.thread_ts ?? e.ts
  try {
    // 添付ファイルをダウンロードして AgentRequest を組み立てる。
    const files = await downloadSlackFiles(e.files, process.env.SLACK_BOT_TOKEN!)
    const req = buildAgentRequest({
      teamId: e.team ?? 'unknown',
      channel: e.channel,
      threadTs,
      userId: e.user,
      rawText: e.text ?? '',
      files,
    })
    const res = await invokeAgent(req, { agentRuntimeArn, region })
    // Agent は通常の Markdown を返すため、Slack mrkdwn に変換してから投稿する。
    await say({ text: toSlackMrkdwn(res.text ?? '') || '(空の応答)', thread_ts: threadTs })

    // 複数ファイルは file_uploads でまとめて 1 回のリクエストでアップロードする。
    // 個別に uploadV2 を連続呼び出しすると、同名衝突などで一部しか投稿されないため。
    const artifacts = res.artifacts ?? []
    if (artifacts.length > 0) {
      await client.files.uploadV2({
        channel_id: e.channel,
        thread_ts: threadTs,
        file_uploads: artifacts.map((a) => ({
          filename: a.name,
          file: Buffer.from(a.data, 'base64'),
        })),
      })
    }
  } catch (err) {
    await say({ text: `エラーが発生しました: ${(err as Error).message}`, thread_ts: threadTs })
  }
})

await app.start()
console.log('⚡️ Slack consumer (Socket Mode) running')
