#!/usr/bin/env bash
# Refresh the prompt sources under prompts/.
#
# AGENTS.md is committed, while the skill may be generated from an approved
# private source for a build and must not be committed to this public repo.
# Both files are pasted into the system prompt verbatim, so a stale copy means
# the bot runs on outdated instructions.
set -euo pipefail

cd "$(dirname "$0")/.."

NIKI_REF="${NIKI_REF:-main}"
NIKI_URL="https://raw.githubusercontent.com/mpppk/niki/${NIKI_REF}/AGENTS.md"
COSENSE_SKILL_PATH="${COSENSE_SKILL_PATH:-$HOME/.claude/skills/cosense/SKILL.md}"

echo "==> cosense SKILL.md from ${COSENSE_SKILL_PATH}"
if [ ! -f "$COSENSE_SKILL_PATH" ]; then
  echo "    NOT FOUND — set COSENSE_SKILL_PATH to the skill's SKILL.md" >&2
  exit 1
fi
if [ ! -s "$COSENSE_SKILL_PATH" ]; then
  echo "    EMPTY — set COSENSE_SKILL_PATH to a non-empty skill file" >&2
  exit 1
fi
if grep -Fq 'COSENSE_SKILL_PLACEHOLDER' "$COSENSE_SKILL_PATH"; then
  echo "    PLACEHOLDER — provide the approved upstream skill through COSENSE_SKILL_PATH" >&2
  exit 1
fi

echo "==> AGENTS.md from ${NIKI_URL}"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" "$NIKI_URL" -o prompts/AGENTS.md
else
  curl -fsSL "$NIKI_URL" -o prompts/AGENTS.md
fi
echo "    $(wc -c < prompts/AGENTS.md) bytes"

# Keep the generated prompt private when the source came from a CI secret.
umask 077
cp "$COSENSE_SKILL_PATH" prompts/cosense-SKILL.md
echo "    $(wc -c < prompts/cosense-SKILL.md) bytes"
