# prompts/

system prompt に貼り込むテキスト。決定事項「AGENTS.md と cosense Agent Skill は
system prompt に全文を貼る」の実体である。

`wrangler.jsonc` の `rules` で `*.md` を Text モジュールとして読み込むので、
`src/prompt.ts` から `import` するだけでバンドルに入る。実行時の fetch は無い。

| ファイル | 出所 | 更新 |
|---|---|---|
| `AGENTS.md` | [mpppk/niki](https://github.com/mpppk/niki) の `AGENTS.md` | `bun run sync:prompts` |
| `cosense-SKILL.md` | 承認済みのローカル cosense Agent Skill (`SKILL.md`) | `COSENSE_SKILL_PATH=... bun run sync:prompts` |

`AGENTS.md` は **vendored copy** なので、原本を更新したら sync を回して commit する。
規約を書き換えたのに bot が古い規約で動く、という食い違いはここでしか起きない。

## Skill のライセンス境界と build 時の注入

[`helpfeel/cosense-cli` の `skills/cosense/SKILL.md`](https://github.com/helpfeel/cosense-cli/blob/main/skills/cosense/SKILL.md)
を調査したところ、公開リポジトリには `LICENSE` がなく、GitHub の `licenseInfo` も空である。
`package.json` の MIT 表記は npm package のメタデータであり、`files` には `skills/` が含まれない
ため、この Skill をこの public リポジトリへコピーする許可とはみなさない。したがって、tracked
な `prompts/cosense-SKILL.md` は意図的に安全なフォールバックのままにする。

利用許諾のある Skill を使う build には、保護された CI secret（例: `COSENSE_SKILL_MD`）を
runner 上の一時ファイルへ、ログへ出力せず mode 0600 で materialize する。`sync:prompts` は
source が無い、空、またはこのリポジトリの placeholder の場合に失敗する。

### 検証用 dry-run（PR / ローカル）

PR やローカルでは実デプロイをせず、依存・型・Worker バンドルだけを検証する。secret を
利用できない環境では tracked な安全フォールバックをそのまま使う。許諾済み Skill の組み込み
まで検証する場合は、同じ job 内で一時ファイルを materialize してから sync し、dry-run まで
実行する。

```sh
skill_dir="$RUNNER_TEMP/cosense-skill"
trap 'rm -f "$skill_dir/SKILL.md"' EXIT
install -d -m 700 "$skill_dir"
umask 077
printf '%s' "$COSENSE_SKILL_MD" > "$skill_dir/SKILL.md"
COSENSE_SKILL_PATH="$skill_dir/SKILL.md" bun run sync:prompts
bun run typecheck
bun run deploy -- --dry-run --containers-rollout=none
```

### 本番 deploy（protected environment のみ）

本番 deploy は、許可済み secret を持つ protected environment の CI job からだけ実行する。
PR / ローカルの検証手順とは別に、同じ job 内で Skill を materialize → sync → typecheck した
後、最後に **dry-run ではない** deploy を実行する。

```sh
skill_dir="$RUNNER_TEMP/cosense-skill"
trap 'rm -f "$skill_dir/SKILL.md"' EXIT
install -d -m 700 "$skill_dir"
umask 077
printf '%s' "$COSENSE_SKILL_MD" > "$skill_dir/SKILL.md"
COSENSE_SKILL_PATH="$skill_dir/SKILL.md" bun run sync:prompts
bun run typecheck
bun run deploy -- --containers-rollout=none
```

生成された `prompts/cosense-SKILL.md` は build/deploy の間だけ使い、commit・artifact・ログへ
残さない。deploy 後に runner の workspace を破棄し、secret や生成済み prompt を保存する
step を置かない。
