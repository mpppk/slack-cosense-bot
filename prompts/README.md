# prompts/

system prompt に貼り込むテキスト。決定事項「AGENTS.md と cosense Agent Skill は
system prompt に全文を貼る」の実体である。

`wrangler.jsonc` の `rules` で `*.md` を Text モジュールとして読み込むので、
`src/prompt.ts` から `import` するだけでバンドルに入る。実行時の fetch は無い。

| ファイル | 出所 | 更新 |
|---|---|---|
| `AGENTS.md` | [mpppk/niki](https://github.com/mpppk/niki) の `AGENTS.md` | `npm run sync:prompts` |
| `cosense-SKILL.md` | ローカルの cosense Agent Skill (`SKILL.md`) | `npm run sync:prompts` |

どちらも **vendored copy** なので、原本を更新したら sync を回して commit する。
規約を書き換えたのに bot が古い規約で動く、という食い違いはここでしか起きない。
