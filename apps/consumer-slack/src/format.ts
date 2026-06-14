// =============================================================================
// Agent が返す通常の Markdown を Slack の mrkdwn 記法へ変換する純ロジック層。
// Slack は通常の Markdown をそのまま解釈しない(**太字** や # 見出し、
// [text](url) などが崩れる)ため、投稿前にここで変換する。
// 変換そのものは slackify-markdown(remark ベース)に委ね、入口を 1 関数に閉じ込める。
// =============================================================================
import { slackifyMarkdown } from 'slackify-markdown'

// 通常の Markdown を Slack mrkdwn に変換する。
// slackify-markdown は末尾に改行を付けることがあるため trim して整える。
export function toSlackMrkdwn(markdown: string): string {
  return slackifyMarkdown(markdown).trim()
}
