#!/usr/bin/env bash
set -euo pipefail

# Belayer relay-ide framework: trigger contract
# Checks GitHub Issues for the next todo-labeled issue ready for implementation.
# Returns exit 0 + artifact path on stdout if ready, exit 1 if not.
#
# Workflow: backlog → refined → [planning skill] → todo → [belayer picks up]
# Issues in "todo" are guaranteed conflict-free by the planning skill.

REPO="donovan-yohan/relay-ide"
INTERNAL_DIR=".belayer/.internal/input"

mkdir -p "$INTERNAL_DIR"

# Find the oldest todo issue not already in progress
# The planning skill ensures todo issues have no blocking conflicts.
ISSUE_JSON=$(gh issue list \
  --repo "$REPO" \
  --label "todo" \
  --state open \
  --json number,title,body,labels \
  --limit 10 2>/dev/null) || exit 1

# Filter out issues that have an "in-progress" label (already claimed by belayer)
AVAILABLE=$(echo "$ISSUE_JSON" | jq -r '
  [.[] | select(.labels | map(.name) | index("in-progress") | not)]
  | sort_by(.number)
  | first // empty
')

[ -n "$AVAILABLE" ] || exit 1

ISSUE_NUMBER=$(echo "$AVAILABLE" | jq -r '.number')
ISSUE_TITLE=$(echo "$AVAILABLE" | jq -r '.title')
ISSUE_BODY=$(echo "$AVAILABLE" | jq -r '.body')

# Write the issue as a spec file for the implement node
SPEC_FILE="$INTERNAL_DIR/issue-${ISSUE_NUMBER}.md"
cat > "$SPEC_FILE" <<SPEC
# Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}

${ISSUE_BODY}
SPEC

# Output the artifact path
echo "$SPEC_FILE"
exit 0
