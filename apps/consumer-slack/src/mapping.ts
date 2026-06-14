// =============================================================================
// Slack のイベントデータを AgentRequest に変換するマッピング層。
// ボットメンションの除去・セッション ID の導出・ファイルリストの整形を担う。
// =============================================================================
import { deriveSessionId, type AgentFile, type AgentRequest } from '@app/contract'

// app_mention イベントから AgentRequest を組み立てるための入力データ。
export interface SlackEventInput {
  teamId: string   // Slack ワークスペース ID（セッション ID の一部）
  channel: string  // チャンネル ID（セッション ID の一部）
  threadTs: string // スレッド親メッセージのタイムスタンプ（セッション ID の一部）
  userId: string   // 発言したユーザーの ID
  rawText: string  // ボットメンションを含む生テキスト
  files: AgentFile[] // ダウンロード済みの添付ファイル一覧
}

// SlackEventInput を AgentRequest に変換する。
export function buildAgentRequest(input: SlackEventInput): AgentRequest {
  // ボットメンション（<@UXXXX> 形式）を除去してユーザーの指示だけを抽出する。
  const text = input.rawText.replace(/<@[^>]+>/g, '').trim()
  return {
    // チームID・チャンネル・スレッドの組み合わせで同一スレッドを同一セッションに対応させる。
    sessionId: deriveSessionId([input.teamId, input.channel, input.threadTs]),
    userId: input.userId,
    text,
    files: input.files.length > 0 ? input.files : undefined,
  }
}
