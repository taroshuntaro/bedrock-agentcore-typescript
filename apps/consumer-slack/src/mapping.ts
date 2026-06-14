import { deriveSessionId, type AgentFile, type AgentRequest } from '@app/contract'

export interface SlackEventInput {
  teamId: string
  channel: string
  threadTs: string
  userId: string
  rawText: string
  files: AgentFile[]
}

export function buildAgentRequest(input: SlackEventInput): AgentRequest {
  const text = input.rawText.replace(/<@[^>]+>/g, '').trim()
  return {
    sessionId: deriveSessionId([input.teamId, input.channel, input.threadTs]),
    userId: input.userId,
    text,
    files: input.files.length > 0 ? input.files : undefined,
  }
}
