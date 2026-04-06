#!/usr/bin/env bash
set -euo pipefail

# Belayer relay-ide framework: implementation node runner
# Invokes OpenCode with ultrawork/autopilot for parallel agent execution.
#
# Reads node-context.json for the spec file path, then delegates to opencode.

for cmd in jq opencode; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd is required but not found" >&2; exit 1; }
done

CONTEXT_FILE=".belayer/.internal/input/node-context.json"

if [ ! -f "$CONTEXT_FILE" ]; then
  echo "ERROR: node-context.json not found at $CONTEXT_FILE" >&2
  exit 1
fi

# Extract the input artifact path from node context.
# Core writes artifacts as a map (e.g. {"design_doc": "path/to/spec.md"}).
INPUT_PATH=$(jq -r '.artifacts.design_doc // (.artifacts | to_entries | first | .value) // empty' "$CONTEXT_FILE")

if [ -z "$INPUT_PATH" ]; then
  echo "ERROR: no input path found in node context" >&2
  exit 1
fi

# Read the prompt template
PROMPT_FILE=".belayer/prompts/implement.md"
if [ -f "$PROMPT_FILE" ]; then
  PROMPT=$(cat "$PROMPT_FILE")
  # Replace %{INPUT} with actual path
  PROMPT="${PROMPT//%\{INPUT\}/$INPUT_PATH}"
else
  PROMPT="Implement the specification at $INPUT_PATH. Use /ultrawork and /autopilot for parallel execution."
fi

# Invoke OpenCode with the prompt
# OpenCode reads CLAUDE.md/AGENTS.md and activates ultrawork/autopilot from keywords in the prompt
exec opencode --prompt "$PROMPT"
