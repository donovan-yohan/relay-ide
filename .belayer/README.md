# relay-ide Belayer Framework

Custom belayer pipeline for relay-ide. OpenCode implements (with ultrawork/autopilot), Codex reviews (adversarial, isolated context), Claude ships. Review depth is auto-routed based on change classification.

## Prerequisites

```bash
# Belayer
go install github.com/donovan-yohan/belayer/cmd/belayer@latest

# Temporal (local dev)
temporal server start-dev

# OpenCode (implementation agent)
# https://github.com/opencode-ai/opencode

# Claude Code CLI (review routing + PR authoring)
# https://docs.anthropic.com/en/docs/claude-code

# OpenAI Codex CLI (adversarial review gates)
npm i -g @openai/codex

# GitHub CLI (issue intake)
# https://cli.github.com
```

## GitHub Issues Workflow

```
backlog        →  refined       →  todo          →  [belayer]
(rough idea)      (scoped)         (belayer-ready)   (implement → review → ship)
                       │                                    │
                       └── planning skill ──────────────────┘
                           - writes implementation plan into issue body
                           - checks in-flight todo/in-progress work for file overlap
                           - if clean: promotes refined → todo
                           - if conflict: adds "Blocked by #X" and waits
```

**Labels:**
- `backlog` — rough idea, not yet scoped
- `refined` — scoped, requirements clear, awaiting implementation plan
- `todo` — planned, conflict-free, ready for belayer to pick up
- `in-progress` — belayer has claimed this issue (added by belayer)

**The planning skill** (runs upstream, not part of belayer pipeline):
1. Takes a `refined` issue
2. Reads code, writes file-level implementation plan into the issue body
3. Checks all `todo` and `in-progress` issues for file/module overlap
4. Promotes to `todo` if no conflicts, or adds dependency notes and waits

## Pipeline

```
[intake: todo issue] → implement (OpenCode) → review-router (Claude)
                                                    │
                      ┌─────────────────────────────┼─────────────────────────────────┐
                      v                             v                                 v
               full-feature-review          quick-bugfix-review               refactor-review
               (5 dims, pass: 7.0)          (3 dims, pass: 7.0)              (4 dims, pass: 7.5)
                      v                             v                                 v
                 ship (Claude)                 ship (Claude)                      ship (Claude)
                 → PR to nightly               → PR to nightly                   → PR to nightly
```

### implement

- `command: .belayer/scripts/implement.sh` (invokes OpenCode)
- Prompt includes `/ultrawork` and `/autopilot` keywords for parallel agent orchestration
- Receives the issue body as a spec file (implementation plan written by planning skill)

### review-router

- `vendor: claude`, classifies the change and picks review depth
- Routes to one of three subpipelines based on scope, risk, and change type

### review gates (subpipelines)

- `vendor: codex` (adversarial, zero implementation context)
- Each subpipeline has tuned dimensions and thresholds for its change type
- Score-then-route: Codex scores, belayer decides pass/retry/fail

### ship

- `vendor: claude`, creates PR targeting nightly
- Runs build + tests before pushing

## Usage

```bash
# Start Temporal worker
belayer worker

# Belayer polls for todo issues automatically via intake trigger
# Or run manually:
belayer climb "implement issue #170"

# Check status
belayer status
```

## File Structure

```
.belayer/
  pipeline.yaml              # Main pipeline: implement → review-router
  framework.yaml             # Framework metadata
  scripts/
    check-ready.sh           # Trigger: finds next todo issue from GitHub
    implement.sh             # Node runner: invokes OpenCode
  pipelines/
    full-feature-review.yaml # 5-dim gate (quality, spec, prod, tests, arch)
    quick-bugfix-review.yaml # 3-dim gate (correctness, regression, tests)
    refactor-review.yaml     # 4-dim gate (behavior, arch, tests, migration)
  prompts/
    implement.md             # Implementation prompt (ultrawork/autopilot)
    review.md                # Adversarial review prompt
  .internal/                 # Gitignored runtime state
```
