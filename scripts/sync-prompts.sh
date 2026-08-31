#!/usr/bin/env bash
# Refresh the vendored prompt sources under prompts/.
#
# Both files are pasted into the system prompt verbatim, so a stale copy means
# the bot runs on an outdated version of the conventions. Run this whenever
# either source changes, then commit the result.
set -euo pipefail

cd "$(dirname "$0")/.."

NIKI_REF="${NIKI_REF:-main}"
NIKI_URL="https://raw.githubusercontent.com/mpppk/niki/${NIKI_REF}/AGENTS.md"
COSENSE_SKILL_PATH="${COSENSE_SKILL_PATH:-$HOME/.claude/skills/cosense/SKILL.md}"

echo "==> AGENTS.md from ${NIKI_URL}"
auth=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi
curl -fsSL "${auth[@]}" "$NIKI_URL" -o prompts/AGENTS.md
echo "    $(wc -c < prompts/AGENTS.md) bytes"

echo "==> cosense SKILL.md from ${COSENSE_SKILL_PATH}"
if [ -f "$COSENSE_SKILL_PATH" ]; then
  cp "$COSENSE_SKILL_PATH" prompts/cosense-SKILL.md
  echo "    $(wc -c < prompts/cosense-SKILL.md) bytes"
else
  echo "    NOT FOUND — set COSENSE_SKILL_PATH to the skill's SKILL.md" >&2
  exit 1
fi
