import type { CodeInterpreter } from 'bedrock-agentcore/code-interpreter'
import type { AgentArtifact, AgentFile } from '@app/contract'

const TEXT_MIME = /^(text\/|application\/(json|csv|xml|x-ndjson|javascript))/

/** 入力ファイルを input/ に書き込む。テキストはデコードして、バイナリは base64 を .b64 で。 */
export async function uploadInputFiles(client: CodeInterpreter, files: AgentFile[] = []): Promise<void> {
  if (files.length === 0) return
  const toWrite = files.map((f) =>
    TEXT_MIME.test(f.mimeType)
      ? { path: `input/${f.name}`, content: Buffer.from(f.data, 'base64').toString('utf-8') }
      : { path: `input/${f.name}.b64`, content: f.data },
  )
  await client.writeFiles({ files: toWrite })
}

/** output/ を列挙し、各ファイルを artifact として読み戻す。
 *  `<name>.b64` は base64 バイナリ、それ以外はテキスト。 */
export async function collectOutputArtifacts(client: CodeInterpreter): Promise<AgentArtifact[]> {
  const listing = await client.executeCommand({ command: 'ls -1 output/ 2>/dev/null || true' })
  const names = listing.split('\n').map((s) => s.trim()).filter(Boolean)

  const artifacts: AgentArtifact[] = []
  for (const name of names) {
    const content = await client.readFiles({ paths: [`output/${name}`] })
    if (name.endsWith('.b64')) {
      const realName = name.slice(0, -'.b64'.length)
      artifacts.push({ name: realName, mimeType: guessMime(realName), data: content.trim() })
    } else {
      artifacts.push({ name, mimeType: guessMime(name), data: Buffer.from(content, 'utf-8').toString('base64') })
    }
  }
  return artifacts
}

function guessMime(name: string): string {
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.csv')) return 'text/csv'
  if (name.endsWith('.json')) return 'application/json'
  if (name.endsWith('.txt')) return 'text/plain'
  return 'application/octet-stream'
}
