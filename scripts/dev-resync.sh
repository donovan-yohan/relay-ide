#!/usr/bin/env bash
# Per-machine resync helper for the synced-git-checkout federated dev workflow.
# Pulls the current branch, reinstalls, rebuilds, and refreshes the global
# `relay-ide` symlink so subsequent CLI invocations run from this checkout.
#
# Usage:
#   scripts/dev-resync.sh              # pull current branch, rebuild, npm link
#   scripts/dev-resync.sh --no-pull    # skip git pull (already pulled)
#   scripts/dev-resync.sh --no-link    # skip npm link (don't shadow global install)
#
# See docs/FEDERATED_DEV.md for the full workflow.

set -euo pipefail

DO_PULL=1
DO_LINK=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) DO_PULL=0 ;;
    --no-link) DO_LINK=0 ;;
    --help|-h)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ "$DO_PULL" = "1" ]; then
  echo "==> git pull"
  git pull --ff-only
fi

echo "==> npm ci"
npm ci

echo "==> npm run build"
npm run build

if [ "$DO_LINK" = "1" ]; then
  echo "==> npm link --force"
  npm link --force
fi

VERSION_OUT="$(node dist/bin/relay-ide.js --version)"
echo "==> relay-ide --version reports: $VERSION_OUT"
echo "done."
