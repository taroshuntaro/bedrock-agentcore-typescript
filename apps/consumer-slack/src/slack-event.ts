// =============================================================================
// Slack Events API のリクエストボディから「どう処理すべきか」を判定する純ロジック層。
// challenge 応答 / 無視(再送・bot 発言など) / 回答(answer)の 3 択に分類し、
// SDK 呼び出しは一切含まない。app_mention とボットとの DM(message.im) を対象とする。
// =============================================================================

// worker に渡すファイル参照(本体はダウンロードせずメタデータのみ)。
export interface SlackFileRef {
  name: string               // ファイル名
  mimeType: string           // MIME タイプ
  urlPrivateDownload: string // bot トークンで認証して取得する非公開 URL
}

// 応答 Lambda に委譲する決定。worker ペイロードに必要な値をすべて含む。
export interface AnswerDecision {
  action: 'answer'
  teamId: string             // Slack ワークスペース ID(セッション導出の一部)
  channel: string            // 返信先チャンネル(DM 含む)
  userId: string             // 発言者の ID
  rawText: string            // メンションを含む生テキスト(除去は mapping 側)
  sessionThreadTs: string    // セッション導出用(DM では channel ID)
  replyThreadTs?: string     // 返信の thread_ts(DM では undefined=非スレッド)
  files: SlackFileRef[]      // 添付ファイルのメタデータ一覧
}

// イベントの処理方針を表す判別共用体。
export type EventDecision =
  | { action: 'challenge'; challenge: string } // URL 検証に応答する
  | { action: 'ignore'; reason: string }       // 処理せず 200 を返す
  | AnswerDecision                             // 応答 Lambda に委譲する

// Slack のファイルオブジェクト配列を SlackFileRef[] に正規化する。
function toFileRefs(files: unknown): SlackFileRef[] {
  if (!Array.isArray(files)) return []
  return files
    .map((f) => ({ name: String(f?.name ?? ''), mimeType: String(f?.mimetype ?? ''), urlPrivateDownload: String(f?.url_private_download ?? '') }))
    .filter((f) => f.urlPrivateDownload !== '')
}

// メンション(<@UXXXX>)を除去したテキストが実質空かどうかを判定する。
function isTextEmpty(rawText: string): boolean {
  return rawText.replace(/<@[^>]+>/g, '').trim() === ''
}

// 生ボディと再送ヘッダ(x-slack-retry-num)から処理方針を判定する。
export function decideEvent(rawBody: string, retryNum: string | undefined): EventDecision {
  // Slack の再送は無視する(初回で処理済みのため。二重応答防止)。
  if (retryNum !== undefined) return { action: 'ignore', reason: `再送 (retry=${retryNum})` }

  // ボディの JSON 解析(不正な形式は無視)。
  let body: any
  try {
    body = JSON.parse(rawBody)
  } catch {
    return { action: 'ignore', reason: 'JSON 解析失敗' }
  }

  // Events URL 登録時の URL 検証(challenge をそのまま返す必要がある)。
  if (body?.type === 'url_verification' && typeof body.challenge === 'string') {
    return { action: 'challenge', challenge: body.challenge }
  }
  if (body?.type !== 'event_callback' || !body.event) {
    return { action: 'ignore', reason: '対象外タイプ' }
  }

  const ev = body.event
  const teamId = String(body.team_id ?? 'unknown')
  // bot 自身の発言・サブタイプ付きメッセージは無視(無限ループ防止)。
  if (ev.bot_id || ev.subtype) return { action: 'ignore', reason: 'bot またはサブタイプ付きメッセージ' }

  const rawText = String(ev.text ?? '')
  const files = toFileRefs(ev.files)
  // メンションのみ等でテキストが空でも、添付ファイルがあれば処理する。
  if (isTextEmpty(rawText) && files.length === 0) {
    return { action: 'ignore', reason: 'テキスト空かつファイル無し' }
  }

  // チャンネルでのメンション: スレッドで返信し、セッションもスレッド単位にする。
  if (ev.type === 'app_mention') {
    const threadTs = String(ev.thread_ts ?? ev.ts)
    return { action: 'answer', teamId, channel: String(ev.channel), userId: String(ev.user), rawText, sessionThreadTs: threadTs, replyThreadTs: threadTs, files }
  }

  // bot との DM: 非スレッド返信。DM 全体を 1 セッションにするため channel をセッションキーにする。
  if (ev.type === 'message' && ev.channel_type === 'im') {
    return { action: 'answer', teamId, channel: String(ev.channel), userId: String(ev.user), rawText, sessionThreadTs: String(ev.channel), replyThreadTs: undefined, files }
  }

  return { action: 'ignore', reason: `対象外イベント (${ev.type})` }
}
