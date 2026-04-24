#!/usr/bin/env bash
set -euo pipefail

# Belayer relay-ide framework: implementation node runner
# Legacy script — the new pipeline uses belayer agent nodes directly.
# Kept for manual invocation or fallback scenarios.
#
# Reads node-context.json for the spec file path, then spawns a belayer agent.

for cmd in jq belayer; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd is required but not found" >&2; exit 1; }
done

CONTEXT_FILE=".belayer/.internal/input/node-context.json"

if [ ! -f "$CONTEXT_FILE" ]; then
  echo "ERROR: node-context.json not found at $CONTEXT_FILE" >&2
  exit 1
fi

# Extract the input artifact path from node context.
INPUT_PATH=$(jq -r '.artifacts.design_doc // (.artifacts | to_entries | first | .value) // empty' "$CONTEXT_FILE")

if [ -z "$INPUT_PATH" ]; then
  echo "ERROR: no input path found in node context" >&2
  exit 1
fi

# Spawn the supervisor agent to orchestrate implementation.
# The supervisor will read the spec and spawn backend-dev/web-dev as needed.
belayer spawn --name supervisor --identity supervisor --profile default \
  --task "Implement the autoplan spec at $INPUT_PATH. Read the spec, spawn the appropriate implementers, run review and QA, then commit, push, and open a PR targeting nightly."

# Signal completion to belayer.
belayer node-complete
