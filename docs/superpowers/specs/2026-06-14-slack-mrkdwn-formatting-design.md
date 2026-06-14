# consumer-slack の Slack mrkdwn 対応

## 背景

Slack は通常の Markdown をそのまま解釈しない（独自の mrkdwn 記法）。本プロジェクトの Agent（`apps/agent`）は汎用アシスタントとして通常の Markdown を返すため、consumer-slack がそのまま投稿すると `**太字**` や `# 見出し`、`[text](url)` などが崩れて表示される。

別プロジェクト `bedrock-kb-gdrive-rag` では、Slack 専用ボットだったため LLM プロンプトに「mrkdwn で出力せよ」と直接指示していた。本プロジェクトは Agent と consumer が分離した汎用設計のため、同じ手法は Agent の汎用性を損なう。

## 方針

Agent は汎用のまま（通常 Markdown を返す）とし、**consumer-slack 側で Agent の応答テキストを Slack mrkdwn に後変換**して投稿する。変換には `slackify-markdown`（remark ベースで GFM を正確にパース・変換）を用いる。

## コンポーネント

### 1. `apps/consumer-slack/src/format.ts`（新規・純ロジック層）

- `toSlackMrkdwn(markdown: string): string` をエクスポート
- `slackify-markdown` をラップし、変換の入口を 1 関数に閉じ込める
- 変換結果を `trim()` して、Slack 投稿向けに末尾の余分な改行を除去
- `slackify-markdown` が担う主な変換:
  - `**太字**` / `__太字__` → `*太字*`
  - `# 見出し` → `*見出し*`（太字化）
  - `[text](url)` → `<url|text>`
  - `- 箇条書き` / `* 箇条書き` → `• 箇条書き`
  - `~~打消~~` → `~打消~`
  - コードブロック / インラインコードは保持（内部の記号は誤変換されない）

### 2. `apps/consumer-slack/src/app.ts`（変更）

- `say({ text: res.text || '(空の応答)' ... })` を
  `say({ text: toSlackMrkdwn(res.text ?? '') || '(空の応答)' ... })` に変更
- エラーメッセージ・`(空の応答)` のフォールバックはプレーンテキストのまま（変換不要）

### 3. `apps/consumer-slack/package.json`（変更）

- `dependencies` に `slackify-markdown` を追加

## データフロー

```
Agent 応答(Markdown) → runAgent → res.text → toSlackMrkdwn → say(Slack が text を mrkdwn として描画)
```

## テスト（`apps/consumer-slack/src/format.test.ts`・vitest）

- 太字 `**x**` → `*x*`
- 見出し `# x` → `*x*`
- リンク `[t](u)` → `<u|t>`
- 箇条書き `- x` → `• x`
- コードブロック内の記号が変換されないこと
- 空入力 → `''`

## スコープ外

- Agent 側プロンプトの変更（汎用性維持のため行わない）
- Slack Block Kit 化（テキスト投稿のまま）
- テーブルの整形（Slack 非対応のため slackify のテキスト化に委ねる）
