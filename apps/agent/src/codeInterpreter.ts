import type { CodeInterpreter } from 'bedrock-agentcore/code-interpreter'
import type { AgentArtifact, AgentFile } from '@app/contract'

const TEXT_MIME = /^(text\/|application\/(json|csv|xml|x-ndjson|javascript))/

// bedrock-agentcore の CodeInterpreter メソッドは失敗時に例外ではなく "Error: ..." 文字列を返す。
function isErrorResult(result: string): boolean {
  return result.startsWith('Error:')
}

/** 入力ファイルを input/ に書き込む。テキストはデコードして、バイナリは base64 を .b64 で。 */
export async function uploadInputFiles(client: CodeInterpreter, files: AgentFile[] = []): Promise<void> {
  if (files.length === 0) return
  const toWrite = files.map((f) =>
    TEXT_MIME.test(f.mimeType)
      ? { path: `input/${f.name}`, content: Buffer.from(f.data, 'base64').toString('utf-8') }
      : { path: `input/${f.name}.b64`, content: f.data },
  )
  const result = await client.writeFiles({ files: toWrite })
  if (isErrorResult(result)) throw new Error(`Code Interpreter writeFiles failed: ${result}`)
}

/** output/ を列挙し、各ファイルを base64 artifact として読み戻す。
 *  readFiles は文字列しか返せずバイナリが壊れるため、サンドボックス内で base64 エンコード
 *  してから読み出す。これによりテキスト・バイナリを一律に扱える。失敗したファイルはスキップ。 */
export async function collectOutputArtifacts(client: CodeInterpreter): Promise<AgentArtifact[]> {
  const listing = await client.executeCommand({ command: 'ls -1 output/ 2>/dev/null || true' })
  if (isErrorResult(listing)) return []
  const names = listing.split('\n').map((s) => s.trim()).filter(Boolean)

  const artifacts: AgentArtifact[] = []
  for (const name of names) {
    const encoded = await client.executeCommand({ command: `base64 -w0 "output/${name}"` })
    if (isErrorResult(encoded)) continue
    artifacts.push({ name, mimeType: guessMime(name), data: encoded.trim() })
  }
  return artifacts
}

function guessMime(name: string): string {
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.csv')) return 'text/csv'
  if (name.endsWith('.json')) return 'application/json'
  if (name.endsWith('.txt')) return 'text/plain'
  if (name.endsWith('.pdf')) return 'application/pdf'
  return 'application/octet-stream'
}
