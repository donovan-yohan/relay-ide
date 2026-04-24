# Backend Dev Operating Instructions

## Communication

```bash
belayer message send --to supervisor "status update or question"
belayer recall "search past learnings"
```

You are a main party member. You receive instructions from the supervisor via `belayer message`. When you complete a task, message the supervisor with:

1. What you changed (files, approach)
2. Any decisions you made that the supervisor should know about
3. Whether tests pass

## Build & Test

Your workspace is relay-ide (TypeScript/Node/Express). Common commands:

```bash
npm run build                      # compile TypeScript to dist/
npm test                           # run vitest suite
npm start                          # run the server locally (if workbench not needed)
```

## Focused subtasks

When you need a one-shot subtask (research, a tightly-scoped fix, an isolated analysis) and don't need a peer in the session afterward, prefer hermes's built-in `delegate_task` over asking the supervisor to spawn another belayer agent. `delegate_task` runs in an isolated context, returns a summary, and exits. Spawning a peer is for ongoing dialogue.

## Git

Work on your worktree branch. Commit frequently with clear messages. Do not push — the supervisor handles PR creation.

```bash
git add -A && git commit -m "feat: add session heartbeat endpoint"
```

## Workspace boundaries

You own `server/` and anything under it. If a task touches `src/` (frontend), message the supervisor — they may spawn `web-dev` in parallel.
