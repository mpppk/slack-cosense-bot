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
npm install
npm run sync:prompts   # prompts/ の vendored copy を更新する
```

`prompts/cosense-SKILL.md` は初期状態ではプレースホルダである。**sync を回さずにデプロイしない。**

### 2. Slack アプリ

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
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put OPENROUTER_API_KEY
wrangler secret put COSENSE_PAT
```

ローカルは `.dev.vars.example` を `.dev.vars` にコピーして埋める。

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
npm run typecheck
wrangler deploy
```

## Cosense の認証

CLI が読む環境変数は `COSENSE_PAT` **だけ**である (`cosense login --help` で確認)。
`cosense login` は TTY 専用なので、コンテナ内で対話ログインはできない。

決定事項は「bot 専用の Service Account」だが、**Service Account の資格情報を
`COSENSE_PAT` として渡せるかは未確認**である。渡せない場合は、コンテナ起動時に
`~/.cosense/settings.json` (dir 0700 / file 0600) を書き込む処理が要る。
最初のデプロイで確かめること。

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
