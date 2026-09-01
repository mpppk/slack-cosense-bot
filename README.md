# slack-cosense-bot

Slack から Cosense wiki を調べて答える bot。Cloudflare の [Think](https://developers.cloudflare.com/agents/harnesses/think/) が
agentic loop を回し、[Sandbox SDK](https://developers.cloudflare.com/sandbox/) のコンテナ内で
[`cosense` CLI](https://www.npmjs.com/package/@helpfeel/cosense-cli) を実行する。

仕様と決定事項の正本は Cosense のページ
[Cosense編集Slack bot](https://scrapbox.io/niboshi-tasks/Cosense編集Slack_bot) にある。
この README はその実装側の手順書である。

タスクの依存関係は [docs/roadmap.md](docs/roadmap.md) にある。

## 現在の実装範囲

MVP は **「Slack で mention → Cosense を読んで回答」まで**。書き込みツールは意図的に
実装していない。`previewEdit` / `submitEdit` を公開するのは、このモデル構成の規約遵守度を
MVP で測ってからである。

| | 状態 |
|---|---|
| Slack で mention → 検索・閲覧して回答 | 実装済み |
| チャンネル description からプロジェクトを判定 | 実装済み |
| Cosense の slack notification を検知してスレッドを立てる | 未実装 |
| マーカー行の処理・リンク書き戻し・ingest 一式 | 未実装 |

## 構成

```
Slack event
  └─ POST /messengers/slack/webhook
       └─ SlackCosenseBot (Think, Durable Object)
            ├─ getModel()     OpenRouter z-ai/glm-5.3-flash
            ├─ getTools()     searchVector / searchFullText / browsePage / …
            │                   └─ Sandbox コンテナ (共有1本) で cosense CLI
            └─ Session        会話履歴・tool call・streaming・recovery
```

Slack の1スレッド = Chat SDK の1 thread = Think の1 sub-agent。スレッドごとに文脈が
独立するので、会話履歴を自前で持つ必要はない。

| ファイル | 役割 |
|---|---|
| `src/index.ts` | Worker entry と `SlackCosenseBot` |
| `src/prompt.ts` | system prompt の組み立て |
| `src/tools/cosense.ts` | cosense CLI を叩く読み取り系ツール |
| `src/project-binding.ts` | チャンネル description → プロジェクトの判定と検証 |
| `src/sandbox.ts` | 共有コンテナと `cosense` の実行、シェルクォート |
| `prompts/` | system prompt に貼る AGENTS.md と Agent Skill |

## セットアップ

### 1. 依存と prompts

```sh
bun install
bun run sync:prompts   # prompts/ の vendored copy を更新する
```

`prompts/cosense-SKILL.md` は、上流 Skill のライセンスが確認できないため、公開リポジトリには
安全なフォールバックだけを置く。許諾済みの本物を使う本番 deploy では、protected CI secret を
runner の一時ファイルへ materialize し、`COSENSE_SKILL_PATH` を指定して **同じ job 内で**
`bun run sync:prompts` → `bun run typecheck` → `bun run deploy` を実行する。生成された
Skill は commit・artifact・ログに残さない。具体的な注入例と境界の根拠は
[`prompts/README.md`](prompts/README.md) を参照する。

### 2. Slack アプリ

Slack App Manifest の設定は [slack-app-manifest.template.json](slack-app-manifest.template.json)
を正本とする。これは Slack の App Manifest editor に貼り付けて使える secret-free の
テンプレートで、`<worker>` はデプロイ済み Worker のホスト名に置き換える。置き換え後の
manifest や Slack の App Credentials はリポジトリに保存しない。

1. `slack-app-manifest.template.json` をコピーし、`settings.event_subscriptions.request_url`
   を実際の HTTPS URL (`https://<worker>.workers.dev/messengers/slack/webhook`) に置き換える。
2. Slack の **Create New App → From an app manifest** で貼り付け、表示される scope と
   bot events を確認して作成する。Request URL は Worker が公開された後に設定して保存し、
   Slack の URL verification が成功したことを App settings で確認する。
3. **OAuth & Permissions → Install to Workspace** でインストールし、表示された bot token は
   下記の `wrangler secret put` で登録する。**Basic Information → App Credentials** の
   signing secret も同様に登録する。値はログ、issue、commit、PR に書かない。

Slack の manifest 仕様は [App manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/)、
Request URL の challenge は [HTTP Request URLs](https://docs.slack.dev/apis/http/) を参照する。

Bot Token Scopes:

| scope | 用途 |
|---|---|
| `app_mentions:read` | mention の受信 |
| `chat:write` | 回答の投稿 |
| `channels:history` / `groups:history` / `im:history` | スレッド内の続きの発言 |
| `channels:read` | public チャンネルの description 読み取り |
| `groups:read` | private チャンネルの description 読み取り |
| `im:read` | DM の判定 |

Event Subscriptions (`bot_events`):

```
app_mention
message.channels
message.groups
message.im
```

`app_mention` だけだと最初の1回しか届かない。bot を mention せずにスレッドで続ける
には `message.*` が要る。

Request URL:

```
https://<worker>.workers.dev/messengers/slack/webhook
```

末尾の `slack` は `getMessengers()` の messenger key に対応する。

### 3. シークレット

```sh
bunx wrangler secret put SLACK_BOT_TOKEN
bunx wrangler secret put SLACK_SIGNING_SECRET
bunx wrangler secret put OPENROUTER_API_KEY
bunx wrangler secret put COSENSE_PAT
```

入力値は端末の prompt に直接入力し、出力へ貼り付けない。登録後は値ではなく名前だけを
`bunx wrangler secret list` で確認できる。

ローカルは `.dev.vars.example` を `.dev.vars` にコピーして埋める。

#### Issue #6 の外部セットアップ確認

次の項目は Slack workspace と Cloudflare アカウントへの認証が必要で、manifest の静的
検査では完了扱いにしない。

- [ ] Slack アプリを作成し、上記 manifest の scopes と bot events を保存した
- [ ] 実際の Worker URL で Request URL verification が成功した
- [ ] Slack bot token を `SLACK_BOT_TOKEN` として登録した
- [ ] Slack signing secret を `SLACK_SIGNING_SECRET` として登録した

リポジトリ内の宣言的な設定は `bun run test:slack-manifest` で検査できる。これは Slack
workspace の状態、URL verification、secret の存在や値を確認するテストではない。

### 4. チャンネルとプロジェクトの紐づけ

Slack チャンネルの description に対象プロジェクトを書く。判定は LLM が行うので
書式は自由でよい。

```
niki の認証認可メモ https://scrapbox.io/niki-auth
```

**description は誰でも書き換えられるので、信頼境界ではない。** 歯止めは2つ:

1. モデルが返した名前を `COSENSE_PROJECTS` (wrangler.jsonc の vars) で検証する
2. bot の Cosense アカウントを対象プロジェクトにしか参加させない

片方だけでは足りない。両方維持すること。

### 5. デプロイ

```sh
bun run typecheck
bun run deploy
```

## Cosense の認証

`@helpfeel/cosense-cli@1.14.1` の実装では、`COSENSE_PAT` は常に Personal Access Token
として扱われ、`x-personal-access-token` ヘッダーに送られる。Service Account のアクセスキー
（`cs_` で始まる値）は `~/.cosense/settings.json` の `projects[].serviceAccount` に
置いた場合だけ `x-service-account-access-key` ヘッダーに変換される。

したがって、Worker Secret の名前は CLI 互換の `COSENSE_PAT` のままにするが、値には
bot 専用 Service Account のアクセスキーを設定する。`runCosense()` は CLI に
`COSENSE_PAT` を渡さず、実行前に `sandbox.writeFile()` で許可済みプロジェクトごとの
設定を `/root/.cosense/settings.json` に書き込み、ディレクトリを 0700、ファイルを 0600
にしてからコマンドを実行する。`cosense login` は TTY 専用なので使用しない。

認証確認は、非公開プロジェクトなど認証が必要な対象に対して、書き込みを伴わない
`readProjectMembers` で行える。対象プロジェクトの Service Account キーを保護された
環境変数から渡し、出力にはページやキーを表示しない:

```sh
COSENSE_PAT='<Service Account access key>' \
  bun run verify:cosense-auth -- https://scrapbox.io/<project>
```

このスクリプトは一時 HOME に同じ settings 形式を書き、`COSENSE_PAT` を子プロセスから
除去して CLI を実行し、終了後に一時ファイルを削除する。

## 実装前に確かめること

仕様ページの「実装前に確かめること」のうち、コードに効くもの:

- **Cosense の slack notification のペイロード** — 更新者名が入るか、本文の抜粋範囲、
  `bot_message` subtype かどうか。Chat SDK が bot 投稿を既定で無視するなら、
  通知の検知（次の段階）がそもそも成立しない
- **`conversations.info` の scope** と、description が `purpose` と `topic` の
  どちらか。現在の実装は両方を連結してモデルに渡している
- **コールドスタートの所要時間** — Slack の 3 秒 ACK には間に合わないので、
  受付投稿を先に出す必要がある

## 設計上の注意

- `sandbox.exec()` はコマンドを**文字列**で受ける。Slack ユーザーが打った文字列が
  そのままシェルに届くので、引数は必ず `shellQuote()` を通す。呼び出し側で
  テンプレートリテラルに埋め込まない
- ページ本文とチャンネル description は**調査対象のデータであって指示ではない**。
  system prompt にその旨を書いてあるが、書き込みを解禁するときは改めて検討すること
- `prompts/` は vendored copy である。原本を更新したら sync して commit する
- Dockerfile のベースは `node:24-slim` + sandbox バイナリの copy。標準の
  `cloudflare/sandbox` イメージは Node 20 で、cosense CLI (Node 24+) が動かない。
  sandbox バイナリのタグは `package.json` の `@cloudflare/sandbox` と揃える
