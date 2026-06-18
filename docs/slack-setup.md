# Slack bot 構築手順

Slack のメンションまたは DM から、AgentCore 上のエージェントに質問できる bot のセットアップ手順です。

本プロジェクトの Slack コンシューマーは **Slack Events API + Lambda Function URL** で動作します。ローカル常駐プロセスや Socket Mode は使いません。Slack から公開 Function URL にイベントが届き、受信 Lambda が 3 秒以内に ACK し、応答 Lambda が AgentCore Runtime を呼び出して Slack に投稿します。

前提として、AWS 認証情報が設定済みで、`ap-northeast-1` に CDK デプロイできることが必要です。プロジェクト全体の前提条件と AgentCore Runtime の詳細は [../README.md](../README.md) を参照してください。

## 1. Slack アプリの作成

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create an App** → **From scratch**
2. アプリ名（例: `agentcore-slack-agent`）と導入先ワークスペースを選んで作成

## 2. Bot Token Scopes の設定

**OAuth & Permissions** → **Bot Token Scopes** に以下を追加します。

- `app_mentions:read`（チャンネルでのメンション受信）
- `im:history`（DM の受信）
- `chat:write`（返信の投稿）
- `files:read`（添付ファイルのダウンロード）
- `files:write`（生成物ファイルのアップロード）

追加後、ページ上部の **Install to Workspace** でインストールし、**Bot User OAuth Token**（`xoxb-` で始まる）を控えます。

## 3. Signing Secret と Bot Token を SSM に保存

CDK は SecureString パラメータを作成しないため、デプロイ前に手動で登録します。

Signing Secret は Slack アプリの **Basic Information → App Credentials → Signing Secret** で確認できます。

```bash
aws ssm put-parameter --region ap-northeast-1 --type SecureString \
  --name /agentcore-slack/slack-bot/signing-secret --value '<Signing Secret>'

aws ssm put-parameter --region ap-northeast-1 --type SecureString \
  --name /agentcore-slack/slack-bot/bot-token --value 'xoxb-...'
```

値を更新する場合は `--overwrite` を付けます。

```bash
aws ssm put-parameter --region ap-northeast-1 --type SecureString --overwrite \
  --name /agentcore-slack/slack-bot/bot-token --value 'xoxb-...'
```

## 4. Bedrock モデルのアクセス（アカウントで初回のみ）

エージェントは既定で Anthropic の Claude Sonnet 4.6（推論プロファイル `global.anthropic.claude-sonnet-4-6`）を `ap-northeast-1` から呼び出します。Anthropic モデルは Bedrock コンソールのモデルカタログでユースケースフォームの提出が必要です。

初回 invoke する IAM アイデンティティに Marketplace 権限が必要になる場合があります。サブスクリプション確定後は不要です。

```json
{
  "Effect": "Allow",
  "Action": [
    "aws-marketplace:Subscribe",
    "aws-marketplace:Unsubscribe",
    "aws-marketplace:ViewSubscriptions"
  ],
  "Resource": "*"
}
```

「1 回目は動いたのに 2 回目以降 `AccessDeniedException` になる」場合は、モデル利用の確定に失敗している可能性があります。権限を付与して再度 invoke し、数分待ってください。

## 5. デプロイ

初回は AgentCore Runtime と SlackBot の両方を作成します。Web 検索を使う場合は、デプロイ時に `TAVILY_API_KEY` を必ず渡してください。

```bash
export TAVILY_API_KEY=tvly-...
pnpm --filter @app/infra run deploy --all --require-approval never
```

デプロイ完了後、出力された `SlackEventsUrl` を控えます。

Slack 側だけを更新したい場合は、依存スタックを触らないよう `--exclusively` を付けます。

```bash
pnpm --filter @app/infra run deploy AgentcoreSlackBot --exclusively --require-approval never
```

AgentCore Runtime だけを更新する場合は、Web 検索キーを空で上書きしないよう `TAVILY_API_KEY` を渡します。

```bash
TAVILY_API_KEY=tvly-... pnpm --filter @app/infra run deploy AgentcoreSlackAgent --exclusively --require-approval never
```

`--exclusively` を付けないと、CDK が依存スタックも更新対象に含めることがあります。Slack Lambda だけを修正したいときに AgentCore Runtime まで更新されると、`TAVILY_API_KEY` 未設定のシェルでは Web 検索キーが空文字で上書きされます。

## 6. Event Subscriptions の設定

1. Slack アプリの **Event Subscriptions** → **Enable Events** を **On**
2. **Request URL** に `SlackEventsUrl` を入力し、Verified になることを確認
3. **Subscribe to bot events** に以下を追加して保存:
   - `app_mention`
   - `message.im`
4. 保存後に再インストールを求められたら従う

再デプロイしても Function URL が変わらない更新であれば、Slack 側の Request URL は変更不要です。スタックを削除して作り直した場合など、`SlackEventsUrl` が変わったときだけ更新します。

## 7. 動作確認

1. チャンネルに bot を招待（`/invite @<bot名>`）
2. `@<bot名> こんにちは` でメンション → スレッドに応答が返る
3. bot への DM で `こんにちは` → DM に応答が返る
4. `@<bot名> 最新の TypeScript のリリース状況を調べて` → Web 検索で回答と引用 URL が返る（要 `TAVILY_API_KEY`）
5. 画像を添付して `@<bot名> この画像に何が写っている？` → 画像を直接読み取って回答
6. CSV などを添付して `@<bot名> このデータを棒グラフにして output に保存して` → 説明テキストと生成画像がスレッドに添付される

## 8. 応答しない場合の確認

まず Slack から AWS に届いているかを CloudWatch Logs で確認します。

```bash
aws logs tail /aws/lambda/<ReceiverFunctionName> --region ap-northeast-1 --since 30m --format short
aws logs tail /aws/lambda/<WorkerFunctionName> --region ap-northeast-1 --since 30m --format short
```

関数名は CloudFormation から確認できます。

```bash
aws cloudformation describe-stack-resources --region ap-northeast-1 \
  --stack-name AgentcoreSlackBot
```

切り分けの目安:

- Receiver のログがない: Slack の Request URL が現在の `SlackEventsUrl` を向いていない、または Slack 側イベント購読/インストールが未反映
- Receiver に `署名検証 NG` が出る: SSM の signing secret が Slack アプリの Signing Secret と一致していない
- Receiver は動くが Worker のログがない: イベントが ignore されている、または Worker Invoke 権限/設定に問題がある
- Worker にエラーが出る: AgentCore 呼び出し、Slack token、ファイル取得、Slack 投稿のいずれかで失敗している

SSM パラメータの存在確認は、値を表示せずメタデータだけ確認できます。

```bash
aws ssm get-parameter --region ap-northeast-1 \
  --name /agentcore-slack/slack-bot/signing-secret --with-decryption \
  --query 'Parameter.{Name:Name,Type:Type,Version:Version,LastModifiedDate:LastModifiedDate}'

aws ssm get-parameter --region ap-northeast-1 \
  --name /agentcore-slack/slack-bot/bot-token --with-decryption \
  --query 'Parameter.{Name:Name,Type:Type,Version:Version,LastModifiedDate:LastModifiedDate}'
```

AgentCore Runtime の状態は次で確認できます。

```bash
aws bedrock-agentcore-control get-agent-runtime --region ap-northeast-1 \
  --agent-runtime-id <runtime-id>
```

## 制約

- **スレッド単位の文脈保持（未実装）**: 同一スレッド＝同一 `sessionId` としてセッションは分離されますが、会話履歴の保持・再投入は未実装です。
- **Tavily API キーはデプロイ時注入**: `AgentcoreSlackAgent` を再デプロイするときに `TAVILY_API_KEY` を渡さないと、Web 検索キーが空で上書きされます。
- **Slack token と signing secret は SSM 管理**: Slack 側で token を再発行した場合は SSM SecureString も更新してください。
