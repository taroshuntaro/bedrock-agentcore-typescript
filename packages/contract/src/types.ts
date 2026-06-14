// =============================================================================
// コンシューマーとエージェント間の共通 Zod スキーマおよび TypeScript 型定義。
// AgentFile（入力ファイル）・AgentArtifact（出力成果物）・AgentRequest・AgentResponse
// の 4 型を定義し、@app/contract の型境界を形成する。
// =============================================================================
import { z } from 'zod'

// コンシューマーがエージェントに渡す入力ファイル（base64 エンコード済み）のスキーマ。
export const agentFileSchema = z.object({
  name: z.string(),     // ファイル名（例: "data.csv"）
  mimeType: z.string(), // MIME タイプ（例: "text/csv"）
  data: z.string(),     // base64 エンコードされたファイル内容
})
// コンシューマーがエージェントに渡す入力ファイルの型。
export type AgentFile = z.infer<typeof agentFileSchema>

// エージェントが生成した出力ファイル（base64 エンコード済み）のスキーマ。
export const agentArtifactSchema = z.object({
  name: z.string(),     // ファイル名（例: "chart.png"）
  mimeType: z.string(), // MIME タイプ（例: "image/png"）
  data: z.string(),     // base64 エンコードされたファイル内容
})
// エージェントが生成した出力ファイルの型。
export type AgentArtifact = z.infer<typeof agentArtifactSchema>

// コンシューマーからエージェントへのリクエストスキーマ。
export const agentRequestSchema = z.object({
  sessionId: z.string(),                         // AgentCore runtimeSessionId（SHA-256 64 文字）
  userId: z.string(),                            // Slack ユーザー ID 等の呼び出し元識別子
  text: z.string(),                              // ユーザーの指示テキスト
  files: z.array(agentFileSchema).optional(),   // 添付入力ファイル（省略可）
})
// コンシューマーからエージェントへのリクエストの型。
export type AgentRequest = z.infer<typeof agentRequestSchema>

// エージェントからコンシューマーへのレスポンススキーマ。
export const agentResponseSchema = z.object({
  text: z.string(),                                    // エージェントの応答テキスト
  artifacts: z.array(agentArtifactSchema).optional(), // 生成された出力ファイル（省略可）
})
// エージェントからコンシューマーへのレスポンスの型。
export type AgentResponse = z.infer<typeof agentResponseSchema>
