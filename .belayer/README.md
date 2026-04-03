# gstack Framework for Belayer

Belayer framework powered by gstack skills. Claude implements, Codex reviews (adversarial, isolated context), Claude ships. No custom scripts needed for the basic case — the pipeline is pure YAML.

## Prerequisites

All tools must have gstack skills installed:

```bash
# Claude Code CLI — install gstack skills
# See: https://github.com/anthropics/gstack

# OpenAI Codex CLI — install gstack skills
npm i -g @openai/codex
# gstack skills are discovered from .claude/skills/ or .agents/skills/

# Belayer
go install github.com/donovan-yohan/belayer/cmd/belayer@latest
```

Both Claude and Codex must have gstack set up so that skill invocations (/ship, $review, etc.) work in each agent.

## Pipeline

```
implement (Claude)  →  review (Codex, gate)  →  ship (Claude)
     ↑                      |
     └── on_retry ──────────┘
```

### implement

- `vendor: claude`, `prompt: "Implement the design specification at $INPUT"`
- Reads the design doc, implements the feature, writes tests, commits
- Trusts agent competency — no micromanagement

### review (gate)

- `vendor: codex`, `prompt: "$review"`
- Runs gstack's full /review methodology via Codex (checklist, scope drift, confidence calibration)
- H-as-feature: Codex is a different model in a different process with zero implementation context
- Belayer auto-appends structured output instructions for gate-result.json
- Scores three dimensions: code_quality, scope_compliance, production_readiness

### ship

- `vendor: claude`, `prompt: "/ship"`
- Runs gstack's /ship skill: version bump, changelog, push, create PR

## How It Works

The pipeline YAML defines agent nodes with `vendor` + `prompt`. Belayer resolves the vendor to the right CLI command, passes the prompt, and handles the output contract. No shell scripts needed.

```yaml
- name: implement
  type: agent
  vendor: claude
  prompt: 'Implement the design specification at $INPUT'
```

Belayer translates this to:

```bash
claude -p --dangerously-skip-permissions --output-format stream-json "Implement the design specification at /path/to/design.md"
```

For gate nodes, belayer auto-appends dimension scoring instructions to the prompt so the agent returns structured JSON that feeds into score-then-route.

## Extending

### With carabiner (quality learning loop)

When carabiner is available, add a custom `command:` to the implement node that calls `carabiner quality check` before prompting:

```yaml
- name: implement
  type: node
  command: .belayer/scripts/implement-with-carabiner.sh
```

The `command:` field overrides `vendor` + `prompt` for nodes that need custom logic.

### With /land-and-deploy (output verification)

Add a post-ship node for merge + monitoring:

```yaml
- name: land
  type: agent
  vendor: claude
  prompt: '/land-and-deploy'
  input: { type: pr }
  on_pass: stop
```

### Custom frameworks

Copy this pipeline.yaml and change the vendors/prompts:

```yaml
# Gemini implements, Claude reviews
- name: implement
  type: agent
  vendor: gemini
  prompt: 'Implement the design at $INPUT'

- name: review
  type: gate
  vendor: claude
  prompt: '$review'
```

Any agent with gstack skills can fill any role.

## Setup

```bash
belayer setup --framework gstack
```
