#!/usr/bin/env bash
set -euo pipefail

# Belayer gstack framework: trigger contract
# Checks for APPROVED design docs in the gstack projects directory.
# Returns exit 0 + artifact path on stdout if ready, exit 1 if not.

# Resolve project slug from git remote
SLUG=$(git remote get-url origin 2>/dev/null \
  | sed 's|.*[:/]\([^/]*/[^/]*\)\.git$|\1|;s|.*[:/]\([^/]*/[^/]*\)$|\1|' \
  | tr '/' '-' \
  | tr -cd 'a-zA-Z0-9._-') || true
SLUG="${SLUG:-$(basename "$(pwd)" | tr -cd 'a-zA-Z0-9._-')}"

PROJECTS_DIR="$HOME/.gstack/projects/$SLUG"

[ -d "$PROJECTS_DIR" ] || exit 1

CONSUMED_FILE="$PROJECTS_DIR/.consumed"

# Find most recent APPROVED design doc not yet consumed
for doc in $(ls -t "$PROJECTS_DIR"/*-design-*.md 2>/dev/null); do
  if grep -q "^Status: APPROVED" "$doc" 2>/dev/null; then
    BASENAME=$(basename "$doc")
    if ! grep -qF "$BASENAME" "$CONSUMED_FILE" 2>/dev/null; then
      # Output the artifact path. Consumption is owned by the caller (belayer poller).
      echo "$doc"
      exit 0
    fi
  fi
done

exit 1
