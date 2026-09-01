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
# Copy into a mode-restricted file first, then replace the tracked destination
# atomically.  A plain cp would retain an existing destination's 0644 mode
# until chmod, briefly exposing the secret-backed prompt under that mode.
umask 077
COSENSE_DEST="prompts/cosense-SKILL.md"
COSENSE_TMP=""
cleanup() {
	if [ -n "$COSENSE_TMP" ]; then
		rm -f "$COSENSE_TMP"
	fi
}
trap cleanup EXIT

COSENSE_TMP="$(mktemp "${COSENSE_DEST}.tmp.XXXXXX")"
chmod 600 "$COSENSE_TMP"
cp "$COSENSE_SKILL_PATH" "$COSENSE_TMP"
chmod 600 "$COSENSE_TMP"
mv -f "$COSENSE_TMP" "$COSENSE_DEST"
COSENSE_TMP=""
echo "    $(wc -c < "$COSENSE_DEST") bytes"
