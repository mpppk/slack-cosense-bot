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

本番で利用許諾のある Skill を使う場合は、保護された CI secret
（例: `COSENSE_SKILL_MD`）を runner 上の一時ファイルへ、ログへ出力せず mode 0600 で
materialize し、次の順で同じ job 内に実行する。`sync:prompts` は source が無い、空、
またはこのリポジトリの placeholder の場合に失敗する。

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

生成された `prompts/cosense-SKILL.md` は build/deploy の間だけ使い、commit・artifact・ログへ
残さない。secret が利用できない fork の pull request ではフォールバックのまま検査し、
本番 deploy は許可済み secret を持つ protected environment からだけ実行する。
