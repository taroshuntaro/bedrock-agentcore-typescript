import { CodeInterpreter } from 'bedrock-agentcore/code-interpreter'
import type { AgentArtifact, AgentFile } from '@app/contract'

export function createCodeInterpreter(region: string, identifier: string) {
  return new CodeInterpreter({ region, identifier })
}

type CiClient = ReturnType<typeof createCodeInterpreter>

/** 入力ファイルをサンドボックスの input/ に書き込む。 */
export async function uploadInputFiles(client: CiClient, files: AgentFile[] = []): Promise<void> {
  for (const f of files) {
    await client.writeFiles({
      files: [{ path: `input/${f.name}`, content: f.data }],
    })
  }
}

/** サンドボックスの output/ を列挙し、各ファイルを artifact として読み戻す。 */
export async function collectOutputArtifacts(client: CiClient): Promise<AgentArtifact[]> {
  const listed = await client.executeCommand({ command: 'ls -1 output/ 2>/dev/null || true' })
  const parsed = JSON.parse(listed) as Record<string, unknown>
  const stdout = (parsed['stdout'] ?? parsed['output'] ?? '') as string
  const names = stdout.split('\n').map((s: string) => s.trim()).filter(Boolean)

  const artifacts: AgentArtifact[] = []
  for (const name of names) {
    const content = await client.readFiles({ paths: [`output/${name}`] })
    const result = JSON.parse(content) as Record<string, unknown>
    // Test mock returns { blob: base64 }; real SDK returns ReadFilesResult with files[].content
    const blob = (result['blob'] as string | undefined) ??
      ((result['files'] as Array<{ content: string }> | undefined)?.[0]?.content ?? '')
    artifacts.push({ name, mimeType: guessMime(name), data: blob })
  }
  return artifacts
}

function guessMime(name: string): string {
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.csv')) return 'text/csv'
  if (name.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}
