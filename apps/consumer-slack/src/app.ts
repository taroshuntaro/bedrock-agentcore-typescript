import 'dotenv/config'
import { App } from '@slack/bolt'
import { invokeAgent, type AgentFile } from '@app/contract'
import { buildAgentRequest } from './mapping'

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
})

const region = process.env.AWS_REGION ?? 'ap-northeast-1'
const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN!

async function downloadSlackFiles(files: any[] | undefined, token: string): Promise<AgentFile[]> {
  if (!files?.length) return []
  const out: AgentFile[] = []
  for (const f of files) {
    const res = await fetch(f.url_private_download, { headers: { Authorization: `Bearer ${token}` } })
    const buf = Buffer.from(await res.arrayBuffer())
    out.push({ name: f.name, mimeType: f.mimetype, data: buf.toString('base64') })
  }
  return out
}

app.event('app_mention', async ({ event, client, say }) => {
  const e = event as any
  const threadTs = e.thread_ts ?? e.ts
  try {
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
    await say({ text: res.text || '(空の応答)', thread_ts: threadTs })

    for (const a of res.artifacts ?? []) {
      await client.files.uploadV2({
        channel_id: e.channel,
        thread_ts: threadTs,
        filename: a.name,
        file: Buffer.from(a.data, 'base64'),
      })
    }
  } catch (err) {
    await say({ text: `エラーが発生しました: ${(err as Error).message}`, thread_ts: threadTs })
  }
})

await app.start()
console.log('⚡️ Slack consumer (Socket Mode) running')
