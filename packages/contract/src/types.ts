import { z } from 'zod'

export const agentFileSchema = z.object({
  name: z.string(),
  mimeType: z.string(),
  data: z.string(), // base64
})
export type AgentFile = z.infer<typeof agentFileSchema>

export const agentArtifactSchema = z.object({
  name: z.string(),
  mimeType: z.string(),
  data: z.string(), // base64
})
export type AgentArtifact = z.infer<typeof agentArtifactSchema>

export const agentRequestSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  text: z.string(),
  files: z.array(agentFileSchema).optional(),
})
export type AgentRequest = z.infer<typeof agentRequestSchema>

export const agentResponseSchema = z.object({
  text: z.string(),
  artifacts: z.array(agentArtifactSchema).optional(),
})
export type AgentResponse = z.infer<typeof agentResponseSchema>
