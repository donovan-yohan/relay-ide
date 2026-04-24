#!/usr/bin/env bash
set -euo pipefail

# Belayer relay-ide framework: trigger contract
# Checks GitHub Issues for the next todo-labeled issue with an autoplan spec ready.
# Returns exit 0 + artifact path on stdout if ready, exit 1 if not.
#
# Workflow: issue opened → /autoplan run by orchestrator → spec written to
# .belayer/.internal/specs/ → issue labeled "todo" → belayer picks up

for cmd in gh jq; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd is required but not found" >&2; exit 1; }
done

REPO="donovan-yohan/relay-ide"
SPEC_DIR=".belayer/.internal/specs"
INTERNAL_DIR=".belayer/.internal/input"

mkdir -p "$SPEC_DIR" "$INTERNAL_DIR"

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

# Look for an existing autoplan spec for this issue
SPEC_FILE="$SPEC_DIR/issue-${ISSUE_NUMBER}-autoplan.md"

if [ ! -f "$SPEC_FILE" ]; then
  echo "No autoplan spec found for issue #${ISSUE_NUMBER} at ${SPEC_FILE}" >&2
  exit 1
fi

# Write the node context pointing at the spec
NODE_CONTEXT="$INTERNAL_DIR/node-context.json"
jq -n \
  --arg spec "$SPEC_FILE" \
  --arg issue "$ISSUE_NUMBER" \
  --arg title "$ISSUE_TITLE" \
  '{artifacts: {design_doc: $spec}, meta: {issue_number: $issue, issue_title: $title}}' \
  > "$NODE_CONTEXT"

# Claim the issue so concurrent runs don't pick the same one
gh issue edit "$ISSUE_NUMBER" --repo "$REPO" --add-label "in-progress" >/dev/null 2>&1 || true

# Output the artifact path
echo "$SPEC_FILE"
exit 0
