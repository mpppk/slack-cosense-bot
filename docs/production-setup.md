# 本番セットアップ runbook

この runbook は `slack-cosense-bot` を Cloudflare Workers に初めて本番展開するときの手順である。対象の正本は [wrangler.jsonc](../wrangler.jsonc)、[Slack App Manifest template](../slack-app-manifest.template.json)、[prompts/README.md](../prompts/README.md)、および `package.json` であり、手順や値が食い違ったらそれらを優先して確認する。

この文書を追加する PR 自体は deploy を実行しない。Issue #8 は実 deploy と本番確認が終わるまで閉じず、この PR の本文では `Refs #8` とする。

> [!CAUTION]
> 秘密値はログ、shell history、commit、issue、PR、CI artifact、スクリーンショット、チャットへ出さない。`set -x`、`echo`、`printenv`、`cat` による秘密値の表示、秘密値をコマンド引数へ直書きすることを禁止する。以下のコマンドは、秘密値をプロンプトまたは保護された secret manager から渡す前提で、値そのものは記載しない。

## 0. 作業の境界と全体の流れ

本番 deploy は、承認済みの protected environment と使い捨ての CI workspace から行う。Cloudflare の Worker 名は `wrangler.jsonc` の `name`（現在は `slack-cosense-bot`）、Cosense の origin は `https://scrapbox.io`、許可 project は現在 `niki-auth,niki-ai,niki-cs,niki-tech` である。変更する場合はコードと運用責任者の承認をそろえ、channel description だけで許可範囲を広げない。

初回だけ Slack の Request URL と Worker URL の循環を解くため、次の順序にする。

1. Cloudflare を認証し、承認済み Skill を一時ファイルへ materialize する。
2. 一時 Skill を `COSENSE_SKILL_PATH` に指定して sync、typecheck、dry-run を行う。
3. `--containers-rollout=none` の **bootstrap deploy** を一度だけ行い、`workers.dev` の Worker URL を得る。これは URL を確保するための未完成状態であり、Issue #8 の完了でも、本番利用開始でもない。Slack app ができるまで外部へ URL を案内しない。
4. その URL を一時的な manifest copy に反映して Slack app を作成し、workspace へ install する。
5. Slack bot token と signing secret を得た後、4 secrets を `wrangler secret put` で登録する。
6. Slack の Request URL verification を実行し、manifest の scopes/events と URL が一致することを確認する。
7. 同じ一時 workspace で Skill の sync → typecheck → dry-run → 本番 deploy を行い、デプロイ後の確認を実施する。

既に Worker が存在する場合は、現在の URL と active deployment を確認して bootstrap deploy を省略する。Worker の名前を変えて循環を解く場合は、production とは別の staging Worker と明示すること。

## 1. 前提条件と秘密情報の原則

### 前提条件

- `origin/main` の最新 commit を基準にした、意図しない変更のない checkout。PR merge 後の `main` から deploy する。
- `package.json` が指定する Bun `1.4.0`。依存は `bun.lock` と frozen install で固定する。
- Docker Desktop または互換 engine。`wrangler.jsonc` は `image: "./Dockerfile"` を使うので、完全な deploy では Dockerfile の build が必要である。Workers Builds を使う場合も、production の deploy command は `bun run deploy`（またはその相当の `wrangler deploy`）にする。
- Cosense CLI の前提である Node 24+。本番コンテナも [Dockerfile](../Dockerfile) で `node:24-slim` を使い、`@cloudflare/sandbox` のバージョンを package と `0.12.9` にそろえている。
- Cloudflare account の Worker/Container を deploy できる権限、Slack workspace で app を作成・install できる権限、OpenRouter の key を発行できる権限、対象 Cosense project の管理者による Service Account 作業。
- `jq`（secret 名だけを抽出し、API の response から成功フラグだけを残すため）。

### この Worker の 4 secrets

| secret name | 入れるもの | 用途 |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | 対象 workspace に install した bot token | Slack Web API と Chat SDK |
| `SLACK_SIGNING_SECRET` | Slack App Credentials の signing secret | Events API request の署名検証 |
| `OPENROUTER_API_KEY` | OpenRouter で発行した API key | `wrangler.jsonc` の `OPENROUTER_MODEL` を呼ぶ provider |
| `COSENSE_PAT` | **Service Account access key（`cs_` で始まる値）** | 現行コードが settings file の `serviceAccount` に渡す Cosense 認証値 |

`wrangler.jsonc` の `vars` に秘密値を追加しない。4 secrets は Worker の runtime secret であり、値の検査や共有は行わず、名前だけを確認する。`CLOUDFLARE_API_TOKEN`、`COSENSE_PAT`、`COSENSE_SKILL_MD`、Slack token などを含む保護環境変数を debug output、PR log、artifact に残さない。

## 2. Cloudflare の認証

プロジェクトの Wrangler は `package.json` の devDependency を使うため、ここでは一貫して `bunx wrangler` を使用する。まずバージョンと対象 account を確認する。

```sh
bunx wrangler --version
bunx wrangler whoami
```

`whoami` が非 0 なら、次のどちらか一つを選ぶ。

### A. ローカルの対話的な OAuth

```sh
bunx wrangler login
bunx wrangler whoami
```

ブラウザ callback が使えない SSH、container、remote session では device flow を使う。

```sh
bunx wrangler login --device
bunx wrangler whoami
```

複数 account がある場合は `whoami` の account 一覧を見て、production Worker を置く account であることを確認する。必要なら account id を値として表示・保存せず、保護された shell 変数で限定する。

```sh
bunx wrangler whoami --account "$CLOUDFLARE_ACCOUNT_ID"
```

### B. API token（CI / headless）

Cloudflare dashboard の My Profile > API Tokens（account-owned token を組織で採用する場合は Manage Account > Account API Tokens）で、Worker の deploy に必要な最小権限の token を発行する。Workers Scripts と、Dockerfile container deploy で要求される現行 Containers 権限などは [Cloudflare の API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) と対象 account の policy で確認し、広すぎる全権限を付けない。Token は一度しか表示されないので、protected CI secret に直接保存する。

CI では `CLOUDFLARE_API_TOKEN` と、複数 account を確実に選ぶ必要があるときだけ `CLOUDFLARE_ACCOUNT_ID` を protected environment variable として渡す。Wrangler config に account id を固定する必要がある場合は、運用変更として別途レビューする。このリポジトリの `wrangler.jsonc` には現在 `account_id` がないため、CI では account id を環境変数で明示する。

値を表示せずに認証を確認する。

```sh
# protected environment が値を注入済みであることだけを確認する。
# `printenv` や `wrangler auth token` は実行しない。
bunx wrangler whoami
```

`CLOUDFLARE_API_TOKEN` が設定されていると OAuth の保存 credential より優先される。OAuth の確認をしたいときは、この shell の token variable を secret manager 側で外してから `whoami` を実行する。credential file や token の中身を出力しない。

## 3. OpenRouter API key

1. [OpenRouter の key settings](https://openrouter.ai/settings/keys) で production 用に用途を明記した API key を作成する。可能なら expiry と spending limit を組織の運用方針に合わせる。
2. key の平文は発行時だけ表示され、後から取得できない。表示された値を clipboard、shell history、ログ、ファイルへ残さず、直ちに secret manager の保護入力へ渡す。
3. Cloudflare Worker の secret prompt へ直接入力する。

```sh
bunx wrangler secret put OPENROUTER_API_KEY
```

`wrangler.jsonc` の `OPENROUTER_MODEL` は現在 `z-ai/glm-5.3-flash` である。モデル名を変える場合は、key の作成とは別のレビュー対象にする。OpenRouter の bearer 認証は Worker provider が行うので、key を curl、test fixture、manifest、`vars` へ書かない。

## 4. Cosense Service Account

### 管理者が行う作業

公開されている一次資料で確認できるのは、Cosense の project settings の **Service Accounts** から登録し、Service Account Access Key を取得し、対象 project 内の読み取り API に使うこと、他 project へはアクセスできないことまでである。したがって、次を対象 Cosense の管理者作業として依頼する。

1. bot 専用の Service Account を作成する。
2. `wrangler.jsonc` の `COSENSE_PROJECTS` に列挙された対象 project（現在は `niki-auth`、`niki-ai`、`niki-cs`、`niki-tech`）へ、その Service Account を参加させる／対象として許可する。
3. Service Account Access Key を発行して保護された secret manager へ渡す。

どの project をどの画面で招待するか、同じ account/key を複数 project に参加させられるか、project ごとに別 key が必要かは、公開資料だけでは組織固有の承認フローを確定できない。管理者に確認し、推測で member 招待、権限付与、API 呼び出しをしない。現在のコードは一つの `COSENSE_PAT` 値を許可された全 project の settings に設定するため、4 project すべてで有効であることを管理者に確認できない場合は deploy を止め、project ごとの key 設計を先に変更する。

### なぜ secret 名が `COSENSE_PAT` なのか

これは本物の PAT を使うという意味ではない。`@helpfeel/cosense-cli` の CLI 互換名が `COSENSE_PAT` であり、環境変数で渡すと CLI は常に Personal Access Token として扱う。一方 `cs_` の Service Account access key は、project entry の `~/.cosense/settings.json` に `serviceAccount` として置いたときに `x-service-account-access-key` header へ変換される。

このリポジトリの `src/sandbox.ts` は、Cosense CLI 実行前に共有 container の `/root/.cosense/settings.json` を一時的に作り、directory を `0700`、file を `0600` にして、`COSENSE_PAT` 自体を CLI 子プロセスへ渡さない。`cosense login` は TTY 前提なので本番手順では使わない。

### read-only verifier

まず secret を Worker へ登録する前に、対象 project ごとに `readProjectMembers` を使う read-only verifier を実行する。verifier は temporary HOME に settings を作り、CLI の stdout/stderr を転送せず、終了後に temporary tree を削除する。キーは literal としてコマンドへ書かず、protected shell または secret manager から注入する。

対話 shell の例（入力は画面に表示されず、終了後に variable を消す）。

```sh
read -r -s COSENSE_PAT
export COSENSE_PAT
bun run verify:cosense-auth -- https://scrapbox.io/niki-auth
bun run verify:cosense-auth -- https://scrapbox.io/niki-ai
bun run verify:cosense-auth -- https://scrapbox.io/niki-cs
bun run verify:cosense-auth -- https://scrapbox.io/niki-tech
unset COSENSE_PAT
```

期待結果は各コマンドの終了 status `0` と、project 名だけを含む pass 表示である。失敗時に CLI の raw response、key、ページ本文を貼らない。成功しない project が一つでもあれば、Service Account の参加・origin・`COSENSE_PROJECTS` を管理者と確認して止める。

## 5. 利用許諾済み Cosense Skill の build-time 注入

`prompts/cosense-SKILL.md` は、上流 Skill を無断再配布しないための安全な fallback であり、tracked file に `COSENSE_SKILL_PLACEHOLDER` がある。fallback を本番へ deploy してはならない。利用許諾を確認できる Skill の全文を、protected CI secret（例: `COSENSE_SKILL_MD`）または許諾済みのローカル `SKILL.md` として同じ build job にだけ渡す。

`sync:prompts` は `COSENSE_SKILL_PATH` の source を検査して `prompts/cosense-SKILL.md` を生成し、`src/prompt.ts` が Text module として Worker bundle に取り込む。runtime で fetch したり、placeholder を deploy 後に差し替えたりする機能ではない。

CI の先頭で、secret value を表示せず mode `0600` の一時ファイルへ materialize する。`RUNNER_TEMP` は CI runner が提供する一時ディレクトリに置き換え、local で行う場合も repository 外の一時 directory を使う。

```sh
set -eu
umask 077
: "${COSENSE_SKILL_MD:?protected COSENSE_SKILL_MD is required}"

skill_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/cosense-skill.XXXXXX")"
chmod 700 "$skill_dir"
skill_file="$skill_dir/SKILL.md"
install -m 600 /dev/null "$skill_file"
printf '%s' "$COSENSE_SKILL_MD" > "$skill_file"
chmod 600 "$skill_file"
export COSENSE_SKILL_PATH="$skill_file"

cleanup_skill() {
  rm -f -- "$skill_file"
  rmdir -- "$skill_dir" 2>/dev/null || true
}
trap cleanup_skill EXIT HUP INT TERM
```

以降の `sync`、検証、deploy はこの同じ job、同じ workspace で完了させる。

```sh
bun run sync:prompts

if rg -n 'COSENSE_SKILL_PLACEHOLDER' prompts/cosense-SKILL.md; then
  echo 'production preflight failed: placeholder Skill is still present' >&2
  exit 1
fi
```

生成された `prompts/cosense-SKILL.md` は build/deploy の間だけ存在させる。job 終了時に上の trap で source file を削除し、CI workspace と generated prompt を artifact として保存しない。local の通常 worktreeで本番注入を行わず、やむを得ず行った場合は generated prompt を commit せず、クリーンな disposable checkout を破棄してから次の作業へ進む。

## 6. Slack App Manifest と bootstrap

### manifest を正本どおり使う

[slack-app-manifest.template.json](../slack-app-manifest.template.json) は secret-free の正本である。`<worker>` だけを実際の Worker host に置き換えた一時 copy を Slack の manifest editor に貼り付け、置換後の manifest を repository、PR、artifact に保存しない。tracked template 自体は placeholder のまま `bun run test:slack-manifest` で検査する。

Worker の Request URL は次の一つである。

```text
https://<worker>.workers.dev/messengers/slack/webhook
```

`/messengers/slack/webhook` の `slack` は `src/index.ts` の `getMessengers()` の messenger key と一致する。末尾、host、scheme の誤りを避ける。Slack の Request URL は case-sensitive である。

### bootstrap 順序

Slack manifest は event subscription がある場合に Request URL または Socket Mode が必要であり、この template は Socket Mode を使わない。そのため URL がまだ無い段階で `<worker>` を実際の production manifest として保存しない。

1. Section 5 の Skill source を同じ protected job に materialize し、sync → typecheck → dry-run を行う。
2. Worker が未作成なら、`--containers-rollout=none` の bootstrap deploy を行う。これは Worker code を activate して URL を得るだけで、container image/instance を更新しない。Slack app がまだ無く、4 secrets もそろっていないので、利用開始とは扱わない。

   ```sh
   bun run deploy -- --containers-rollout=none
   ```

3. deploy output または Cloudflare dashboard で `https://<worker>.workers.dev` を確認する。値を issue、ログ、artifact に貼らず、manifest editor の一時入力だけに使う。
4. template の scopes/events を変えず、`settings.event_subscriptions.request_url` だけを実 URL に置き換えて **Create New App → From an app manifest** で作成する。manifest 作成後も Request URL が未検証なら、次の secrets 登録後に App settings で verification を実行する。
5. **OAuth & Permissions → Install to Workspace**（既存 app の変更なら Reinstall）を実行する。Bot User OAuth Token を取得し、表示された token は直ちに `SLACK_BOT_TOKEN` 用の保護された入力へ渡す。
6. **Basic Information → App Credentials** から signing secret を取得し、保護された入力へ渡す。deprecated verification token は使わない。
7. Section 7 の 4 secrets を登録してから、Event Subscriptions の Request URL verification を保存する。Slack が送る `url_verification` challenge に Worker が応答し、App settings に成功表示が出ることを確認する。

Request URL verification は secrets が無い bootstrap Worker に先に行わない。`SLACK_SIGNING_SECRET` が無い状態で署名検証に失敗するからである。Slack の retry を使う前に、最新 Worker が正しい URL で active か、app 側 URL が path まで一致するかを確認する。

### scopes と bot events

template の値を次の表と突き合わせる。追加 scope は要求せず、追加・変更したときは Slack が要求する再 install を行う。

| 種別 | 現行値 | 用途 |
| --- | --- | --- |
| bot scope | `app_mentions:read` | mention を受信 |
| bot scope | `chat:write` | thread へ回答を投稿 |
| bot scope | `channels:history` / `groups:history` / `im:history` | 継続 thread の発言を読む |
| bot scope | `channels:read` / `groups:read` / `im:read` | `conversations.info` で description を読む |
| bot event | `app_mention` | mention で調査を開始 |
| bot event | `message.channels` / `message.groups` / `message.im` | mention 後の subscribed thread、DM の続き |

`app_mention` だけでは mention 後に bot を再 mention しない thread の続きが届かない。`src/index.ts` は `direct-message`、`mention`、`subscribed-thread` を listen するので、template の `message.*` を削除しない。bot を利用する test channel へ `/invite @cosense-bot` で招待する。

## 7. 4 secrets の登録と名前だけの検査

Section 6 の Slack token/signing secret、Section 3 の OpenRouter key、Section 4 の Cosense Service Account key がすべて保護された入力として準備できた後に実行する。

`wrangler secret put` は入力を prompt で受け、現行 Wrangler ではそのたびに Worker の version/deployment を作成する。したがって4回の途中で endpoint を利用開始せず、最後に Section 9 の full deploy を行う。値を引数、pipe、ファイルへ書かない。

```sh
bunx wrangler secret put SLACK_BOT_TOKEN
bunx wrangler secret put SLACK_SIGNING_SECRET
bunx wrangler secret put OPENROUTER_API_KEY
bunx wrangler secret put COSENSE_PAT
```

登録後は secret の値を取得せず、名前だけを抽出する。

```sh
bunx wrangler secret list --format=json | jq -r '.[].name' | sort
```

少なくとも次の4行だけが確認できることを期待する（他の既存 secret がある場合は、追加の名前の用途も管理者と確認する）。

```text
COSENSE_PAT
OPENROUTER_API_KEY
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
```

`secret list` の出力、CI log、スクリーンショットへ secret value が現れることはない。期待名が欠ける場合は Section 11 の missing secret を参照し、値を貼り直さない。

## 8. preflight

production Skill を注入した protected job で、次をこの順に実行する。PR の通常検証では tracked fallback のまま dry-run してよいが、その成果物を本番へ deploy しない。production job では Section 5 の placeholder check が必ず成功すること。

```sh
bun install --frozen-lockfile
bun test
bun run test:slack-manifest
bun run typecheck
bun run deploy -- --dry-run --containers-rollout=none
git diff --check
git status --short
```

さらに production job では、generated Skill が残った状態や placeholder を見逃さない。

```sh
if rg -n 'COSENSE_SKILL_PLACEHOLDER' prompts/cosense-SKILL.md; then
  echo 'ERROR: production deploy must not contain COSENSE_SKILL_PLACEHOLDER' >&2
  exit 1
fi

if git status --short | rg '(^|/)\.dev\.vars($|\.|/)|(^|/)\.env($|\.|/)'; then
  echo 'ERROR: local secret file is present in the deploy workspace' >&2
  exit 1
fi
```

`bun run test:slack-manifest` は tracked template の構造、scopes/events、secret-like な値だけを検査し、Slack workspace の install、URL verification、secret の存在を検査しない。`wrangler deploy --dry-run` は bundle を compile するだけで live deploy しない。また `--containers-rollout=none` は container image/instance を意図的に更新しないため、これは preflight 専用である。

production job では `sync:prompts` 後に generated `prompts/cosense-SKILL.md` の差分が一時的に存在するため、上の preflight はそれを失敗扱いにしない。実 deploy 後に source file と generated prompt を trap/ephemeral workspace cleanup で削除し、commit や artifact を作る前に `git status --short` で generated diff が残っていないことを確認する。

## 9. 本番 deploy

4 secrets の登録、Slack URL verification、preflight が完了した protected environment で、Section 5 の temporary Skill source をまだ保持した同じ job から実行する。

```sh
# COSENSE_SKILL_PATH は Section 5 で export 済み。値は表示しない。
bun run sync:prompts

if rg -n 'COSENSE_SKILL_PLACEHOLDER' prompts/cosense-SKILL.md; then
  echo 'ERROR: placeholder Skill; aborting before production deploy' >&2
  exit 1
fi

bun run typecheck
bun run deploy -- --dry-run --containers-rollout=none
bun run deploy
```

最後の `bun run deploy` が package script の実 deploy である。通常は Wrangler の default rollout を使う。Worker と container image の互換性を短い切り替え窓で保つ必要がある変更だけは、承認を得て次を使える。

```sh
bun run deploy -- --containers-rollout=immediate
```

本番で `--containers-rollout=none` を最後のコマンドにしてはならない。これは Worker code だけを deploy し、Dockerfile image と container instance を更新しない。Cloudflare の container deploy は Worker を先に active にしてから image build/push と rollout を行うため、Docker build や rollout の失敗が Worker activation 後に起こりうる。出力を保存する場合は deployment/version id と status だけにし、secret、Skill 本文、Cosense/Slack payload を含めない。

deploy 後、temporary source file は Section 5 の trap で削除する。protected CI workspace 全体を破棄し、generated `prompts/cosense-SKILL.md`、CI secret、作業 tree を artifact に保存しない。production deploy の commit は許諾済み Skill の生成差分を含めない。

## 10. 本番確認

### Worker の deployment/version

まず active production と version id を確認する。出力は端末で確認するだけにし、全文を PR や chat に貼らない。

```sh
bunx wrangler deployments status --name slack-cosense-bot --json
bunx wrangler deployments list --name slack-cosense-bot --json
bunx wrangler versions list --name slack-cosense-bot --json
```

期待結果は、Section 9 の deploy が最新の active deployment であること、Worker version id と作成時刻が記録できること、container deploy を行った場合は rollout が完了または Cloudflare dashboard が示す状態であること。初回 container provisioning は数分かかることがある。必要なら [Cloudflare の Containers command](https://developers.cloudflare.com/workers/wrangler/commands/containers/) で container の状態を確認するが、raw log に秘密や request payload を含めない。

### 署名なしの安全な応答

公開 endpoint が誤って内部情報を返さず、Slack webhook が署名なし request を処理しないことを、body を捨てて status code だけで確認する。

```sh
WORKER_URL='https://<worker>.workers.dev'
curl -sS -o /dev/null -w '%{http_code}\n' "$WORKER_URL/"
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST "$WORKER_URL/messengers/slack/webhook" \
  -H 'content-type: application/json' \
  --data '{}'
```

root は現在の `index.ts` では `Not found` の `404` が期待値である。webhook への署名なし POST は `401` / `403` / その他の安全な `4xx` が期待値で、`200` として event を処理してはならない。body は表示・保存しない。Slack の本物の challenge payload を手作業で作ってログへ出さず、URL verification は Slack App settings から行う。

### Slack の認証と channel metadata

Bot token は protected environment からだけ渡し、API response は `ok` と `error` だけに絞る。`set -x` を有効にせず、raw JSON を保存・貼り付けない。

```sh
curl -sS -X POST https://slack.com/api/auth.test \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  | jq '{ok, error}'

curl -sS -G https://slack.com/api/conversations.info \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  --data-urlencode "channel=${SLACK_TEST_CHANNEL_ID}" \
  | jq '{ok, error}'
```

期待結果は両方とも `{"ok":true,"error":null}` 相当である。`conversations.info` の成功 response に含まれる channel name、topic、purpose、member 情報を terminal output に出さない。test channel の description に、`COSENSE_PROJECTS` に含まれる非機密の対象 project を示す説明を設定し、別 project 名や外部 URL を書かない。

### Cosense read-only verifier

Section 4 の verifier を、4 project すべてに対して再実行する。期待結果は read-only の `readProjectMembers` が exit `0` になり、ページの読み書きや編集 API を呼ばないことである。出力は pass/fail と project 名だけにし、key、member list、ページ本文、CLI raw response を出さない。

### 専用 test channel の mention / thread

本番の専用 test channel にだけ bot を招待し、Cosense の非機密な承認済み test page を使う。機密本文や実ユーザー情報を入力せず、Slack 画面の回答をログ・PR・artifact にコピーしない。

1. channel description に許可された project を明記する。
2. `@cosense-bot` を mention して、検索・閲覧を依頼する。
3. bot が thread に回答し、参照した page title と URL を含むことを確認する。
4. 同じ thread に bot を再 mention せず短い追質問を送り、`subscribed-thread` として続きに応答することを確認する。
5. bot が page を作成・編集・削除しないことを確認する。

期待結果は、署名済み Slack event が webhook に届き、bot が許可 project 内の read-only tool のみを使い、thread に安全な回答を返すこと。cosense CLI の実行失敗時も secret や raw response を Slack/Cloudflare log に漏らさない。

## 11. トラブルシュート

### `unauthenticated` / Cloudflare account が違う

- `bunx wrangler whoami` を実行し、認証 account が Worker の account と一致するか確認する。
- local は `bunx wrangler login`（remote は `--device`）、CI は protected `CLOUDFLARE_API_TOKEN` と必要なら `CLOUDFLARE_ACCOUNT_ID` を使う。
- `CLOUDFLARE_API_TOKEN` が stale だと OAuth より優先されるので、OAuth を検査するときは token variable を外す。
- `account_id` を推測して `wrangler.jsonc` に書かない。複数 account の場合は dashboard の account details と `whoami --account` で確認する。

### `missing secret` / API key error

- `bunx wrangler secret list --format=json | jq -r '.[].name' | sort` で名前だけ確認する。
- 4 名のどれかが無ければ `bunx wrangler secret put <NAME>` を再実行する。値を shell history、file、PR に書かない。
- Slack `invalid_auth` / `token_revoked` なら app を再 install して bot token を rotation し、signing secret が変わった場合も同様に更新する。
- OpenRouter の認証失敗は key の有効性、期限、利用上限を OpenRouter dashboard で管理者が確認する。
- `secret put` は即時に version/deployment を作るため、4つそろうまで test traffic を流さず、最後に Section 9 の full deploy を行う。

### Slack Request URL verification が失敗する

- URL が `https://<worker>.workers.dev/messengers/slack/webhook` と完全一致し、`/messengers/slack/webhook` の path と大小文字を変えていないか確認する。
- `deployments status` で URL が bootstrap code ではなく、4 secrets 登録後の active Worker を向いていることを確認する。
- Slack app の signing secret が `SLACK_SIGNING_SECRET`、bot token が `SLACK_BOT_TOKEN` に入っているかを名前だけで確認する。
- Cloudflare Access、別 proxy、TLS error、Worker の `404` path mismatch がないかを見る。Slack App settings の Retry を使う前に修正を deploy する。
- Slack が送る challenge の body を手動で issue/log に貼らない。署名検証と challenge 応答は Slack adapter/Worker に任せる。

### Cosense Service Account が失敗する

- `COSENSE_PAT` が `cs_` で始まる Service Account access key であることを、値を表示せず secret manager の metadata で確認する。
- `COSENSE_ORIGIN` が `https://scrapbox.io`、対象 project が `COSENSE_PROJECTS` に一致しているか確認する。
- 同じ key が4 projectすべてへ管理者によって参加・許可されているか確認する。公開一次資料で確認できない org 固有の招待・権限手順を推測しない。
- Section 4 の verifier を一つの project URL ずつ実行し、`readProjectMembers` の read-only 成功だけを確認する。`cosense login` や CLI へ `COSENSE_PAT` を渡す方式へ戻さない。
- 個別 key が必要だと判明したら、単一 `COSENSE_PAT` を前提にした現在のコードを先に変更し、別の secret 名を勝手に追加しない。

### Docker / container の build・rollout が失敗する

- `image: "./Dockerfile"` は Docker または互換 engine が必要である。Docker を起動するか、Cloudflare Workers Builds の production job で full `wrangler deploy` を実行する。
- Node は `node:24-slim`、cosense CLI は Node 24+、sandbox binary は package と同じ `0.12.9` であることを確認する。タグを推測で変えない。
- preflight の `--containers-rollout=none` は Worker bundle の dry-run に限る。実 image を更新する本番では `bun run deploy` または承認済みの `--containers-rollout=immediate` を使う。
- 初回 provisioning は数分かかり、Worker が先に active になってから container が準備される。先に Worker URL が返っても、Slack test を急いで開始せず、container status/log を確認する。
- Cloudflare docs が説明する通り deploy は完全な transaction ではない。image build/push/rollout の失敗後に Worker code が active になっている場合は、無闇に再 deployせず、version と container state を記録して Section 12 の rollback 判断をする。

### Skill placeholder が残っている

次で一致したら本番 deploy を中止する。

```sh
rg -n 'COSENSE_SKILL_PLACEHOLDER' prompts/cosense-SKILL.md
```

許諾済み Skill を protected source から mode `0600` の一時 file へ materialize し、`COSENSE_SKILL_PATH` を export して `bun run sync:prompts` からやり直す。placeholder のコメントを手編集で消したり、未許諾の上流 Skill を public repository へ commit したりしない。

### macOS の credential/keychain 警告

Wrangler が credential の保存場所や keychain について warning を出した場合、credential file の中身を開いてコピーしない。macOS の Keychain が利用可能なら、次で保存先と認証状態だけを確認する。

```sh
CLOUDFLARE_AUTH_USE_KEYRING=true bunx wrangler whoami
```

keychain を使えない CI/headless job では OAuth を無理に保存せず、protected `CLOUDFLARE_API_TOKEN` を使う。`--no-use-keyring` は組織の方針として plaintext credential を許可するときだけ選び、出力や artifact に credential を残さない。

## 12. rollback

現行 Wrangler のコマンドを確認してから、既知の正常 version id へ戻す。version id を推測したり、古い `versions deploy` 手順を rollback の代わりに使ったりしない。

```sh
bunx wrangler --version
bunx wrangler rollback --help
bunx wrangler deployments list --name slack-cosense-bot --json
bunx wrangler versions list --name slack-cosense-bot --json
```

確認した既知の正常な `<VERSION_ID>` を一つ選んでから、次を実行する。

```sh
bunx wrangler rollback '<VERSION_ID>' \
  --name slack-cosense-bot \
  --message 'rollback to the approved known-good version'
```

version id を指定しない `bunx wrangler rollback --name slack-cosense-bot` は現行 Wrangler が「latest の一つ前に upload された version」を選ぶ既定動作だが、incident では対象を曖昧にしないため明示 id を優先する。rollback は指定 version で新しい deployment を直ちに作り、traffic をその version に向ける。直前 deploy の container image を自動で直す操作ではなく、Durable Object migration や KV/R2 などの resource 変更が間にあると rollback できないことがある。

rollback 後は次を再確認する。

```sh
bunx wrangler deployments status --name slack-cosense-bot --json
bunx wrangler versions list --name slack-cosense-bot --json
```

その後 Section 10 の安全な unsigned endpoint、Slack `auth.test` / `conversations.info`、Cosense read-only verifier、専用 test channel を再実行する。credential 漏えいが疑われる場合は rollback だけで済ませず、Slack/OpenRouter/Cosense/Cloudflare の provider 側で revoke/rotate し、値を出さずに `secret put` で更新する。

## 13. 完了チェックリストと Issue の扱い

### 本番完了

- [ ] 最新 `origin/main` を基準に frozen install、全 test、manifest validator、typecheck が成功した。
- [ ] Cloudflare の `whoami` が正しい account を示し、認証情報を出力・保存していない。
- [ ] 承認済み Skill が build-time に mode `0600` の一時 file から注入され、production bundle に `COSENSE_SKILL_PLACEHOLDER` が無い。
- [ ] OpenRouter key が `OPENROUTER_API_KEY` に登録され、key の値がログ/PR/artifact に無い。
- [ ] bot 用 Cosense Service Account が `COSENSE_PROJECTS` の全 project に管理者承認で参加し、4 project の read-only verifier が成功した。
- [ ] Slack app を manifest から作成し、template と同じ scopes/events、Socket Mode disabled、install、bot token、signing secret を確認した。
- [ ] `https://<worker>.workers.dev/messengers/slack/webhook` の Request URL verification が成功した。
- [ ] `secret list` で4 secret の**名前だけ**を確認した。
- [ ] `bun run deploy -- --dry-run --containers-rollout=none` が成功し、最後に `bun run deploy`（または承認済み immediate rollout）が完了した。
- [ ] `deployments status/list` と `versions list` で active version/rollout を確認した。
- [ ] 公開 root と未署名 webhook が安全な status を返し、body を保存していない。
- [ ] Slack `auth.test` と `conversations.info` が成功フラグだけを返し、専用 test channel の mention/thread が期待どおり動いた。
- [ ] Skill source、generated prompt、secret、Cosense/Slack の実データを cleanup し、CI workspace と artifact に残していない。

### Issue を閉じられる条件

| Issue | `Closes` にできる条件 | この PR での扱い |
| --- | --- | --- |
| [#3](https://github.com/mpppk/slack-cosense-bot/issues/3) | `COSENSE_PAT` に `cs_` Service Account key を登録し、許可された全 project で read-only verifier が成功し、値を漏らしていない。 | 条件を満たした実環境の作業後に判断する。 |
| [#6](https://github.com/mpppk/slack-cosense-bot/issues/6) | manifest の scopes/events、workspace install、bot token/signing secret、実 Worker URL の Request URL verification が完了している。 | 条件を満たした Slack workspace 作業後に判断する。 |
| [#8](https://github.com/mpppk/slack-cosense-bot/issues/8) | #3・#6・承認済み Skill 注入がそろい、placeholder 無しの本番 bundle を実 deploy し、version/container、safe endpoint、Slack、Cosense、専用 test channel の確認まで完了している。 | **この PR は実 deploy をしないため `Refs #8`。`Closes #8` と書かない。** |

## 参照リンク（一次資料）

### リポジトリ内の正本

- [README.md](../README.md)
- [prompts/README.md](../prompts/README.md)
- [wrangler.jsonc](../wrangler.jsonc)
- [Slack App Manifest template](../slack-app-manifest.template.json)
- [read-only verifier](../scripts/verify-cosense-auth.ts)

### Cloudflare / Wrangler

- [Wrangler general commands: login, whoami, API token precedence, keyring](https://developers.cloudflare.com/workers/wrangler/commands/general/)
- [Wrangler Workers commands: deploy, dry-run, secrets, deployments, versions, rollback](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- [Workers configuration: account_id and `CLOUDFLARE_ACCOUNT_ID`](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Create a Cloudflare API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Deploy Containers](https://developers.cloudflare.com/containers/guides/deploy/)
- [Container rollouts](https://developers.cloudflare.com/containers/configuration/rollouts/)
- [Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

### Slack

- [Configuring apps with app manifests](https://api.slack.com/reference/manifests)
- [App manifest reference](https://docs.slack.dev/reference/app-manifest/)
- [Using HTTP Request URLs and URL verification](https://docs.slack.dev/apis/events-api/using-http-request-urls/)
- [`url_verification` event](https://docs.slack.dev/reference/events/url_verification)
- [Verifying requests from Slack with signing secret](https://api.slack.com/docs/verifying-requests-from-slack)
- [`auth.test` method](https://api.slack.com/methods/auth.test)
- [`conversations.info` method and required scopes](https://docs.slack.dev/reference/methods/conversations.info/)
- [Creating an app from app settings, scopes, install, and events](https://docs.slack.dev/app-management/quickstart-app-settings/)

### OpenRouter

- [OpenRouter Quickstart: bearer authentication and model API](https://openrouter.ai/docs/quickstart)
- [Create a new OpenRouter API key](https://openrouter.ai/docs/api/api-reference/api-keys/create-keys)
- [OpenRouter key settings](https://openrouter.ai/settings/keys)

### Cosense

- [Official `helpfeel/cosense-cli` repository](https://github.com/helpfeel/cosense-cli)
- [Official Cosense Skill command list, including `readProjectMembers`](https://github.com/helpfeel/cosense-cli/blob/main/skills/cosense/SKILL.md)
- [Cosense official Help: Service Account](https://scrapbox.io/help-jp/Service_Account)
