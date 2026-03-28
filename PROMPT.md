# Implementation: Code & File Tools — Smart Viewport

**Priority: WAVE 0 — Fully independent. Start anytime.**

## Pre-flight Checks

```bash
# 1. Current state
git status
git log --oneline -3

# 2. Pull latest nightly
git fetch origin nightly
git rebase origin/nightly

# 3. No cross-stream dependencies. Verify existing Phase 1 code:
ls frontend/src/components/FileBrowser.svelte 2>/dev/null || echo "FileBrowser not found"
grep -r "browse" server/ --include="*.ts" -l || echo "Browse endpoint not found"

# 4. Design doc exists
cat docs/design-docs/2026-03-28-code-file-tools-design.md | head -5
```

No dependencies on other streams. Fully parallel.

## Design Doc

Read fully: `docs/design-docs/2026-03-28-code-file-tools-design.md`

## What This Stream CONSUMES

Nothing from other streams. Uses only existing infrastructure:
- `server/git.ts` — extend with `getChangedFiles()` and `getFileDiff()`
- `server/watcher.ts` — extend with `.git/` directory watching for `files-changed` events
- `server/ws.ts` — broadcast `files-changed` WebSocket event
- `frontend/src/components/DataTable.svelte` — reuse for file list

## What This Stream PRODUCES

### Contract: WebSocket Event

```typescript
// New event: files-changed
{ sessionId: string; workspacePath: string }
// Fired when fs.watch detects changes in .git/ directory
// Debounced 500ms
```

### Contract: New Endpoints

```
GET /workspaces/changed-files?path=<repoPath>&base=<ref>
  → { files: ChangedFile[], aggregate: { additions, deletions, fileCount }, error?: string }

GET /workspaces/file-diff?path=<repoPath>&file=<filePath>&base=<ref>
  → { diff: string, summary?: string, error?: string }
```

### Contract: New Components

```
ChangedFiles.svelte — Collapsible panel below terminal, uses DataTable
DiffViewer.svelte   — Unified diff with Shiki syntax highlighting
CodeBlock.svelte    — Shared Shiki wrapper (reusable across features)
```

## Implementation Order (from design doc)

Phase 1 completion and Phase 2 can proceed in parallel:

**Phase 1 Completion (2-3 hours):**
1. Wire FileBrowser into AddWorkspaceDialog
2. Add sidebar "browse filesystem" trigger
3. Tests for browse API
4. Build verification

**Phase 2 — Changed Files Panel (3-5 days):**
1. `getChangedFiles()` + `getFileDiff()` in server/git.ts
2. New endpoints in server/workspaces.ts
3. Extend watcher.ts with .git/ directory watching
4. ChangedFiles.svelte using DataTable
5. DiffViewer.svelte with diff2html + Shiki
6. CodeBlock.svelte shared component
7. Smart summaries (rule-based v1)
8. Mobile layout (card view)

**Phase 3 (follow-up):** Full-page diff, side-by-side toggle, keyboard nav
**Phase 4 (low priority):** Open in external editor

## What NOT to Build

- Agent flight recorder (Phase 2.5) → future extension
- LLM-powered summaries (v2) → future extension
- Local review state / commenting → explicitly out of scope (read-only viewport)
- Editor launch (Phase 4) → low priority, user rarely uses editors

## Dependencies: npm packages to add

- `shiki` — syntax highlighting (lazy-loaded grammars, client-side)
- `diff2html` — diff parsing (JSON output mode only, not HTML)

## Process

1. Run `/harness:plan` for Phase 1 completion + Phase 2
2. Run `/harness:orchestrate`
3. Run `/harness:complete`
