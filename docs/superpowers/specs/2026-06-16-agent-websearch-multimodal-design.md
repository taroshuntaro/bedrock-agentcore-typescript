# エージェントへの Web 検索ツール / マルチモーダル入力対応 — 設計書

- 日付: 2026-06-16
- ステータス: 設計合意（実装へ）
- 対象パッケージ: `@app/agent`（主）/ `@app/infra`（環境変数注入のみ）
- 前提: [agentcore-slack-agent 設計書](2026-06-14-agentcore-slack-agent-design.md)

## 背景とゴール

現状のエージェント（`apps/agent`）は `ToolLoopAgent` に `CodeInterpreterTools` だけを持ち、
入力テキストを `generate(prompt: string)` でモデルに渡している。添付ファイルは Code Interpreter
サンドボックスに**先行アップロード（eager）**され、モデルにはファイル名一覧が文字列で添えられるのみで、
画像を「見て」はいない。

本設計では汎用エージェントに 2 つの能力を足す。

1. **Web 検索ツール** — 最新情報・事実確認のための外部検索（独立・小規模）。
2. **マルチモーダル入力** — 画像 / PDF をモデルの vision 入力として直接「見せる」。これに伴いサンドボックス
   へのアップロードを **lazy（LLM がツールを選んだときのみ）** に再構成する。

2 機能は独立しているため **Web 検索 → マルチモーダル** の順に別コミットで実装する。

## 前提・想定

- **モデルは vision 対応 Claude であること（マルチモーダルの必須前提）**。既定の
  `global.anthropic.claude-sonnet-4-6` は満たす。`AGENT_MODEL_ID` は環境変数で上書き可能なため、
  vision 非対応モデルに差し替えると vision パートでエラーになる。非対応モデル運用時は画像/PDF を
  `listingOnly`（サンドボックス経路）に倒す必要がある（F3 の `PDF_VISION_ENABLED` と同様の考え方）。
- リージョンは `ap-northeast-1` 固定（既存前提）。
- ローカルに `node_modules` 未インストールのため、後述「要検証」は実装着手時に実機確認する。

## 検討した代替案（不採用）

| 論点 | 採用 | 不採用にした案と理由 |
|---|---|---|
| Web 検索の実現 | Tavily 自前ラップ | **Browser Tool**=検索用途に過剰・重い / **Anthropic ネイティブ web_search**=Bedrock(ap-northeast-1) での可否・課金が不確実 / **Code Interpreter から fetch**=サンドボックスの外部接続が不確実 |
| ツール実装形態 | 自前 `tool()` ラップ | **コミュニティ製既製ツール**（`@agentic/tavily` 等）=依存が増え、戻り値の制御性・テスト容易性が下がる |
| キー注入 | デプロイ時環境変数 | **Secrets Manager**=ローテーション等は PoC に過剰 / **SSM SecureString**=本番移行先として妥当だが初期はコード/IAM 増を避ける |
| 入力ファイル処理 | lazy（ツール駆動） | **eager 二重アップロード**=純 vision クエリでも CI セッションを無駄に起動する |

---

## 機能 A: Web 検索ツール

### 方針

外部検索 API を **Vercel AI SDK の `tool()` で自前ラップ**し、`ci.tools` と並べて `ToolLoopAgent` に渡す。
LLM が「軽い検索は web_search、ファイル処理は Code Interpreter」と使い分ける。プロバイダは LLM 向けに
設計された **Tavily**（`@tavily/core`）を用いる。

AgentCore ネイティブの Web 検索プリミティブは存在しない（標準ツールは Code Interpreter と Browser のみ）。
よって「AI SDK の `tool` に渡せる検索ツールを自前で作る」のが最もシンプルかつ制御性が高い。

### コンポーネント

#### 1. `apps/agent/src/webSearch.ts`（新規・純ロジック層）

- `createWebSearchTool(deps)` をエクスポートし、Vercel AI SDK の `tool()` を返す。
- 入力スキーマ（Zod）: `{ query: string }`。
- 戻り値の整形（純関数 `formatSearchResult` として切り出し・単体テスト対象）:
  - Tavily の `include_answer` による**合成回答**
  - **上位 5 ソース**の `title` / `url` / `snippet`
  - を LLM が読みやすい単一文字列に整形（回答をたたき台に、URL を引用できる形）。
- 失敗時（ネットワーク・レート制限・API エラー）は **catch して「検索に失敗しました: …」を文字列で返す**。
  例外を投げずエージェント全体を止めない（Code Interpreter の `isErrorResult` の流儀に揃える）。

#### 2. `apps/agent/src/agent.ts`（変更）

- `defaultDeps()` で `createWebSearchTool` を生成し、`tools: [...ci.tools, webSearchTool]` として `ToolLoopAgent` に渡す。
- `INSTRUCTIONS` に web_search の使用方針を追記（最新情報・事実確認が必要なときに使う）。

#### 3. `infra/lib/agent-stack.ts`（変更）

- Runtime の `environmentVariables` に `TAVILY_API_KEY: process.env.TAVILY_API_KEY` を注入する
  （**デプロイ時の環境変数**。値はコミットしない）。
- 本番化時は SSM Parameter Store(SecureString) へ移行可能な構造に留める。

### テスト（`apps/agent/src/webSearch.test.ts`）

- `formatSearchResult`: 合成回答 + 上位 5 ソースが整形されること、ソースが 5 件未満でも壊れないこと。
- 失敗時にエラー文字列が返ること（例外を投げない）。

### スコープ外（将来）

- AgentCore Browser Tool の併用 / フォールバック（`tools` に並べるだけで後付け可能な余地のみ残す）。
- 検索深度（`search_depth`）・件数のツール引数化。

---

## 機能 B: マルチモーダル入力（画像 / PDF）

### 方針

画像 / PDF を **モデルの vision 入力として直接渡す**。これまで「モデルがファイル内容を知る唯一の手段 =
サンドボックスに入れてコードで読む」だった前提が vision で崩れるため、サンドボックスへの書き込みは
**lazy 化**する。すなわち:

- 画像 / PDF は**常に vision で見せる**（モデルが直接理解できる）。
- サンドボックスへの書き込みは、LLM がコード作業を始め **`loadAttachments` ツールを呼んだときのみ** 行う。

これにより「この画像は何？」のような純 vision クエリでは Code Interpreter セッションを起動しない。

### コンポーネント

#### 1. `apps/agent/src/agent.ts`（変更・中核）

- **`buildMessages(text, files)`（純関数・新規）** — テストの継ぎ目。
  - `partitionFiles(files)`（純関数）で `{ visionFiles, listingOnly }` に分類する。
    - 画像（`image/png|jpeg|gif|webp`）・PDF（`application/pdf`）で、かつ**バイトサイズ上限内**のもの → `visionFiles`。
    - それ以外（csv/json/txt 等）と、**サイズ超過・未対応形式**の画像/PDF → `listingOnly`。
    - **上限判定はバイトサイズのみ**（base64 文字列長から算出）。寸法判定は画像デコードが必要で純関数で
      安価にできないため行わない（寸法超過は Bedrock 側の自動縮小/エラーに委ねる）。
    - **PDF の扱い（段階導入）**: PDF は最大 100 ページとトークンが膨らみやすいため、画像より**保守的な
      閾値（バイト/概算ページ数）**で `visionFiles` 採否を決め、超過分は `listingOnly`。さらに
      `PDF_VISION_ENABLED`（環境変数 / 既定オフでも可）で **PDF を一律 `listingOnly` に倒せるフラグ**を設ける。
      Bedrock プロバイダが `file` パート未対応だった場合（要検証 2）は本フラグをオフにして退避する。
  - 返すユーザーメッセージの content パート:
    - テキスト指示
    - `visionFiles` を `image` / `file`（PDF）パートとして付与
    - **全ファイルの名前 + MIME の一覧**（listingOnly を含む）。「コード加工が要るときは
      `loadAttachments` で取り込む」「上限超過で直接見られないものは code で処理する」旨を添える。
- `generate` の継ぎ目を変更: `AgentDeps.generate` の型を
  `generate(content: UserContent, files: AgentFile[]) => Promise<string>` とする（`content` は
  `buildMessages` が返す vision パート＋一覧テキスト、`files` は `loadAttachments` 束縛用）。
  `defaultDeps` の `generate` 実装は、**呼び出しごとに `files` を受けて `ToolLoopAgent` を組む**
  （`tools: [...ci.tools, webSearchTool, createLoadAttachmentsTool(ci, files)]`）。Bedrock プロバイダと
  `ci` インスタンスは使い回し、`ToolLoopAgent` 生成のみリクエスト毎。
- `runAgent`:
  - 先行アップロードを廃止。`buildMessages` でコンテンツを構築し `generate` を呼ぶ。
  - `stopSession()` は **セッションが開始済みのときだけ停止**するようにガードする（lazy では一度も
    開始されないケースがあるため）。

#### 2. `apps/agent/src/codeInterpreter.ts`（変更）

- **`loadAttachments` ブリッジツール**を提供する関数を追加（一括・冪等）。
  - 引数なし。初回呼び出しでリクエストの全ファイルを `input/` に書き込む
    （既存 `uploadInputFiles` のテキスト/バイナリ振り分けロジックを再利用）。
  - **セッション共有（重要）**: `loadAttachments` は `ci.getClient()` が返すのと**同一の
    Code Interpreter クライアント/セッション**を使う。`ci` インスタンスは `defaultDeps` で 1 つだけ
    生成し、`ci.tools`（executeCommand 等）と `loadAttachments` がそれを共有する。これにより
    `loadAttachments` が書いた `input/` を `ci.tools` から読める（別セッションだと不可視になる）。
- `collectOutputArtifacts`（出力回収）は変更なし。

#### 3. `INSTRUCTIONS`（変更）

- vision / Code Interpreter / loadAttachments / web_search の協調方針を追記:
  「画像・PDF は直接見える」「コードで加工する必要があるときだけ `loadAttachments` で取り込む」
  「テキスト系ファイルの中身が必要なら `loadAttachments` 後に Code Interpreter で読む」。

#### 4. `packages/contract` / `apps/consumer-slack`（**変更なし**）

- `AgentFile` は `mimeType` + base64 `data` を既に持つ。
- `downloadSlackFiles` は型を問わず全ファイルをダウンロード済み。出力経路（mrkdwn 変換・`file_uploads`）も
  Web 検索の引用 URL を含めそのまま機能する。

### データフロー（変更後）

```
Slack(thread, files)
  → consumer-slack: downloadSlackFiles → buildAgentRequest（無変更）
  → contract: invokeAgent（無変更）
  → agent:
      buildMessages(text, files)
        ├─ 画像/PDF（上限内） → vision content パート
        └─ 全ファイル名+MIME → 一覧テキスト
      ToolLoopAgent.generate（tools: ci.tools + webSearch + loadAttachments）
        └─ LLM がコード作業時のみ loadAttachments → input/ へ書き込み
      collectOutputArtifacts（output/ を回収）
  → consumer-slack: toSlackMrkdwn + files.uploadV2（無変更）
```

### テスト（`apps/agent/src/agent.test.ts` ほか）

- `partitionFiles`: 画像/PDF が vision、csv/txt が listingOnly に分類されること。
- `partitionFiles`: 上限超過・未対応形式が listingOnly に落ちること。
- `buildMessages`: vision パートと一覧テキストが正しく構築されること。ファイル無しなら従来通りテキストのみ。
- `loadAttachments`: 全ファイルが `input/` に書き込まれること（テキスト/バイナリ振り分け含む）。

### スコープ外（将来）

- 小さいテキストファイルのプロンプトインライン化（一覧表示 + ツール読み込みに一本化）。
- 画像のクライアント側リサイズ（上限超過は vision から外すのみ）。
- `loadInputFile(name)` による個別ロード（一括 `loadAttachments` で十分）。
- 音声・動画入力（Claude on Bedrock 非対応）。

---

## 実装前に要検証

ローカルに `node_modules` が無く未確認のため、実装着手時に確認する。

1. **`CodeInterpreterTools` のセッション開始タイミング** — 構築時か初回ツール呼び出し時か。後者なら
   純 vision クエリでセッション課金ゼロが成立し lazy の旨味が最大化。前者なら省けるのはアップロードのみ。
   - **実装時の確認結果（解決）**: `CodeInterpreterTools` の各ツールの `execute` 内でセッションが同期的に
     自動開始する（構築時には開始しない）。`agent.ts` の `withUsageTracking` で各ツールの `execute` を
     ラップし呼び出し時に `used` フラグを立てるため、lazy 判定（純 vision クエリではサンドボックス未使用）は
     正しく機能する。また `CodeInterpreter.stopSession()` はセッション未開始時には no-op で安全に呼べるため、
     `runAgent` の `finally` 節で `wasUsed()` ガードと組み合わせて安全に終了処理できる。
2. **Vercel AI SDK Bedrock プロバイダの content パート** — `image` パート、および **PDF の `file` パート**が
   message content でサポートされるか、正確な型。未対応なら `PDF_VISION_ENABLED` をオフにして PDF を
   `listingOnly` に退避（F3）。
   - **実装時の確認結果（確認済み）**: `ai@6` は `TextPart`/`ImagePart`/`FilePart` 型を export している
     （`@ai-sdk/provider-utils` 由来）。画像は `{ type: 'image', image: Buffer, mediaType }`、PDF は
     `{ type: 'file', data: Buffer, mediaType: 'application/pdf' }` の形で渡せる。PDF の `file` パートは
     サポートされるため、`PDF_VISION_ENABLED` は既定 `true` のままで問題ない（`agent.ts` の
     `DEFAULT_PARTITION_OPTIONS` 参照）。
3. **Bedrock / Claude の vision 上限の実値** — 画像のバイトサイズ上限（base64 ~5MB 目安）、PDF の MB / ページ数
   （`partitionFiles` のバイトサイズ閾値・F3 の PDF 閾値の根拠）。
   - **実装時の確認結果（未厳密確認）**: 正確な上限値はドキュメント上で厳密確認できなかったため、保守的な
     既定値（画像 5MB、PDF 約 4.5MB）を `DEFAULT_PARTITION_OPTIONS`（`agent.ts`）に設定して暫定対応した。
     実運用でエラーや切り捨てが発生した場合は閾値の再調整が必要になる可能性がある。
4. **`agentcore.Runtime` CDK construct の `environmentVariables`** プロパティの有無（TAVILY_API_KEY 注入）。
   - **実装時の確認結果（確認済み）**: `RuntimeProps.environmentVariables?: { [key: string]: string }`
     として存在する（`aws-cdk-lib` 2.259.0 時点）。最大 50 変数まで設定可能。これにより `TAVILY_API_KEY` を
     infra スタックから注入できる。

## 実装順序

1. **Web 検索**（独立・再構成不要）: `webSearch.ts` 追加 → `agent.ts` で tools 配列に追加 → infra で env 注入。
2. **マルチモーダル + lazy 再構成**: `buildMessages`/`partitionFiles` 追加 → `generate` 継ぎ目変更 →
   `loadAttachments` 追加 → `runAgent` の eager 廃止 + セッションガード → INSTRUCTIONS 更新。

各ステップ完了前に `pnpm test` と `pnpm typecheck` の両方を通すこと。
