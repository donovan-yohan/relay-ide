#!/usr/bin/env bash
set -euo pipefail

# Belayer relay-ide framework: trigger contract
# Checks GitHub Issues for the next todo-labeled issue ready for implementation.
# Returns exit 0 + artifact path on stdout if ready, exit 1 if not.
#
# Workflow: backlog → refined → [planning skill] → todo → [belayer picks up]
# Issues in "todo" are guaranteed conflict-free by the planning skill.

for cmd in gh jq; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd is required but not found" >&2; exit 1; }
done

REPO="donovan-yohan/relay-ide"
INTERNAL_DIR=".belayer/.internal/input"

mkdir -p "$INTERNAL_DIR"

# Fetch the 5 oldest todo issues in one API call (created asc, small page).
# Enough headroom to filter out in-progress without over-fetching.
ISSUE_JSON=$(gh api "repos/$REPO/issues?labels=todo&state=open&sort=created&direction=asc&per_page=5" 2>/dev/null) || exit 1

# Filter out issues already claimed (in-progress label), pick the first (oldest)
AVAILABLE=$(echo "$ISSUE_JSON" | jq -r '
  [.[] | select(.labels | map(.name) | index("in-progress") | not)]
  | first // empty
')

[ -n "$AVAILABLE" ] || exit 1

ISSUE_NUMBER=$(echo "$AVAILABLE" | jq -r '.number')
ISSUE_TITLE=$(echo "$AVAILABLE" | jq -r '.title')
ISSUE_BODY=$(echo "$AVAILABLE" | jq -r '.body')

# Write the issue as a spec file for the implement node.
# Use printf to avoid shell expansion of issue content (security).
SPEC_FILE="$INTERNAL_DIR/issue-${ISSUE_NUMBER}.md"
{
  printf '# Issue #%s: %s\n\n' "$ISSUE_NUMBER" "$ISSUE_TITLE"
  printf '%s\n' "$ISSUE_BODY"
} > "$SPEC_FILE"

# Claim the issue so concurrent runs don't pick the same one
gh issue edit "$ISSUE_NUMBER" --repo "$REPO" --add-label "in-progress" 2>/dev/null || true

# Output the artifact path
echo "$SPEC_FILE"
exit 0
