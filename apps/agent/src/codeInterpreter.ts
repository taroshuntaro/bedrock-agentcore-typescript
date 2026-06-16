// =============================================================================
// Code Interpreter サンドボックスとのファイル入出力を担うユーティリティ群。
// uploadInputFiles でリクエストのファイルをサンドボックスに配置し、
// collectOutputArtifacts でエージェントが生成したファイルを base64 化して回収する。
// =============================================================================
import type { CodeInterpreter } from 'bedrock-agentcore/code-interpreter'
import type { AgentArtifact, AgentFile } from '@app/contract'
import { tool } from 'ai'
import { z } from 'zod'

// テキストとみなす MIME タイプのパターン。該当するファイルは UTF-8 デコードして書き込む。
const TEXT_MIME = /^(text\/|application\/(json|csv|xml|x-ndjson|javascript))/

// bedrock-agentcore の CodeInterpreter メソッドは失敗時に例外ではなく "Error: ..." 文字列を返す。
function isErrorResult(result: string): boolean {
  return result.startsWith('Error:')
}

// 入力ファイルを input/ に書き込む。テキストはデコードして、バイナリは base64 を .b64 で保存する。
export async function uploadInputFiles(client: CodeInterpreter, files: AgentFile[] = []): Promise<void> {
  if (files.length === 0) return
  // MIME タイプに応じてテキスト（デコード）かバイナリ（.b64 のまま）かを振り分ける。
  const toWrite = files.map((f) =>
    TEXT_MIME.test(f.mimeType)
      ? { path: `input/${f.name}`, content: Buffer.from(f.data, 'base64').toString('utf-8') }
      : { path: `input/${f.name}.b64`, content: f.data },
  )
  const result = await client.writeFiles({ files: toWrite })
  if (isErrorResult(result)) throw new Error(`Code Interpreter writeFiles failed: ${result}`)
}

// output/ に生成されたファイルをすべて base64 アーティファクトとして読み戻す。
// readFiles は文字列しか返せずバイナリが壊れるため、サンドボックス内で base64 エンコードしてから読み出す。
// 失敗したファイルはスキップする。
export async function collectOutputArtifacts(client: CodeInterpreter): Promise<AgentArtifact[]> {
  // output/ 内のファイル名一覧を取得する。ディレクトリが存在しない場合は空文字列になる。
  const listing = await client.executeCommand({ command: 'ls -1 output/ 2>/dev/null || true' })
  if (isErrorResult(listing)) return []
  const names = listing.split('\n').map((s) => s.trim()).filter(Boolean)

  // 各ファイルをサンドボックス内で base64 エンコードしてから文字列として読み出す。
  const artifacts: AgentArtifact[] = []
  for (const name of names) {
    const encoded = await client.executeCommand({ command: `base64 -w0 "output/${name}"` })
    if (isErrorResult(encoded)) continue
    artifacts.push({ name, mimeType: guessMime(name), data: encoded.trim() })
  }
  return artifacts
}

// ファイル拡張子から MIME タイプを推測する。
function guessMime(name: string): string {
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.csv')) return 'text/csv'
  if (name.endsWith('.json')) return 'application/json'
  if (name.endsWith('.txt')) return 'text/plain'
  if (name.endsWith('.pdf')) return 'application/pdf'
  return 'application/octet-stream'
}

// 添付ファイルを Code Interpreter の input/ に取り込むブリッジツールを生成する。
// getClient は ci と同一セッションのクライアントを返すこと（書き込みを ci のコードツールから読めるようにするため）。
export function createLoadAttachmentsTool(
  ci: { getClient: () => CodeInterpreter },
  files: AgentFile[],
) {
  return tool({
    description: '添付ファイルを Code Interpreter の input/ に取り込む。ファイルをコードで処理する前に必ず呼ぶ。',
    inputSchema: z.object({}),
    execute: async () => {
      // 既存の振り分けロジック（テキスト=デコード / バイナリ=.b64）を再利用して書き込む。
      await uploadInputFiles(ci.getClient(), files)
      return files.length > 0
        ? `input/ に ${files.length} 件のファイルを配置しました。`
        : '添付ファイルはありません。'
    },
  })
}
