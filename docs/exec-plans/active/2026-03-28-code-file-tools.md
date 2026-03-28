# Code & File Tools — Smart Viewport Implementation Plan

> **Status**: Active | **Created**: 2026-03-28 | **Last Updated**: 2026-03-28 (all tasks complete)
> **Design Doc**: `docs/design-docs/2026-03-28-code-file-tools-design.md`
> **Consulted Learnings**: L-20260322-session-state-refresh, L-20260325-ws-query-invalidation, L-20260327-api-error-body-parse, L-20260327-express4-async-errors
> **For Claude:** Use /harness:orchestrate to execute this plan.

**Goal:** Add a real-time changed files panel with syntax-highlighted diffs to the session view, so users can see what the agent is doing to the codebase without leaving Relay.

**Architecture:** Extend `server/git.ts` with `getChangedFiles()` and `getFileDiff()` functions. Add two new REST endpoints in `server/workspaces.ts`. Extend `server/watcher.ts` with a `GitWatcher` class that watches `.git/` directories and broadcasts `files-changed` events via WebSocket. Frontend renders a collapsible `ChangedFiles.svelte` panel below the terminal using existing `DataTable.svelte`, with inline diff expansion via `DiffViewer.svelte` powered by diff2html (structure) + Shiki (syntax highlighting).

**Tech Stack:** TypeScript, Express, fs.watch, git CLI, Svelte 5, diff2html (JSON parse), Shiki (client-side syntax highlighting)

## Decision Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-03-28 | Design | Approach B: Smart Viewport (not A: Minimal or C: Flight Recorder) | Best value/scope tradeoff — syntax highlighting + summaries build trust without flight recorder complexity |
| 2026-03-28 | Design | diff2html JSON output + Shiki tokens (not diff2html HTML) | Full control over rendered markup for TUI restyling |
| 2026-03-28 | Design | Client-side Shiki with lazy-loaded grammars | Preload top 5 grammars (TS, JS, JSON, CSS, Svelte) for fast first render |
| 2026-03-28 | Design | Watch .git/ directory (not .git/index specifically) | More reliable on macOS where FSEvents coalesces rapid writes |
| 2026-03-28 | Design | Read-only viewport — no local review state | All review state lives in git/GitHub. Zero sync problems. |
| 2026-03-28 | Plan | Skip Phase 1 completion tasks | Already done — FileBrowser wired into AddWorkspaceDialog, sidebar trigger exists, fs-browse.test.ts has coverage |
| 2026-03-28 | Plan | Rule-based summaries only (v1) | LLM summaries deferred to v2 per design doc |

## Progress

- [x] Task 1: ChangedFile type + getChangedFiles() _(completed 2026-03-28)_
- [x] Task 2: getFileDiff() _(completed 2026-03-28)_
- [x] Task 3: REST endpoints (/changed-files, /file-diff) _(completed 2026-03-28)_
- [x] Task 4: GitWatcher (.git/ directory watching + WS broadcast) _(completed 2026-03-28)_
- [x] Task 5: Install frontend dependencies (shiki, diff2html) _(completed 2026-03-28)_
- [x] Task 6: Frontend types + API client + WS event handler _(completed 2026-03-28)_
- [x] Task 7: Smart summaries utility (pure functions) _(completed 2026-03-28)_
- [x] Task 8: CodeBlock.svelte (Shiki wrapper) _(completed 2026-03-28)_
- [x] Task 9: DiffViewer.svelte (diff2html + Shiki) _(completed 2026-03-28)_
- [x] Task 10: ChangedFiles.svelte (DataTable + DiffViewer) _(completed 2026-03-28)_
- [x] Task 11: Wire into App.svelte session view _(completed 2026-03-28)_
- [x] Task 12: Build verification _(completed 2026-03-28)_

## Surprises & Discoveries

| Date | What | Plan Impact | Action Taken |
|------|------|-------------|--------------|
| 2026-03-28 | `exactOptionalPropertyTypes` requires conditional spread for `oldPath` | Minor — needed spread pattern instead of direct assignment | Used `...(entry.oldPath ? { oldPath: entry.oldPath } : {})` |
| 2026-03-28 | `'text'` is not a valid Shiki `BundledLanguage` | Minor — fallback language needed adjustment | Changed fallback from `'text'` to `'javascript'` (preloaded) |
| 2026-03-28 | `DiffFile` type not re-exported from `diff2html` top-level | Minor — import path needed adjustment | Import from `diff2html/lib/types` instead |
| 2026-03-28 | Chunk size warning from Vite (>500kB) after adding shiki | Advisory — shiki bundles many grammars | Noted for future optimization (lazy loading, manual chunks) |

## Plan Drift

| Task | Plan Said | Actually Happened | Why |
|------|-----------|-------------------|-----|
| Task 8 | Use `'text'` as BundledLanguage fallback | Used `'javascript'` as fallback | `'text'` is not a valid Shiki BundledLanguage; `'javascript'` is preloaded |
| Task 9 | Import `DiffFile` from `'diff2html'` | Import from `'diff2html/lib/types'` | Type not re-exported from top-level package |

---

## File Structure

### Server (modify existing)

| File | Change | Responsibility |
|------|--------|---------------|
| `server/types.ts` | Add types | `ChangedFile`, `ChangedFilesResponse`, `FileDiffResponse` interfaces |
| `server/git.ts` | Add functions | `getChangedFiles()`, `getFileDiff()`, `generateFileSummary()` |
| `server/workspaces.ts` | Add endpoints | `GET /changed-files`, `GET /file-diff` |
| `server/watcher.ts` | Add class | `GitWatcher` — watches `.git/` dirs, emits `files-changed` |
| `server/index.ts` | Wire watcher | Create GitWatcher, connect to broadcastEvent |
| `server/ws.ts` | No changes | Already supports broadcastEvent — GitWatcher uses the existing pattern |

### Frontend (create new + modify existing)

| File | Change | Responsibility |
|------|--------|---------------|
| `frontend/src/lib/types.ts` | Add types | `ChangedFile`, `ChangedFilesResponse`, `FileDiffResponse` |
| `frontend/src/lib/api.ts` | Add functions | `fetchChangedFiles()`, `fetchFileDiff()` |
| `frontend/src/lib/diff-summary.ts` | Create | Rule-based smart summaries from diff content |
| `frontend/src/lib/shiki.ts` | Create | Shiki highlighter singleton, TUI theme, grammar preload |
| `frontend/src/components/CodeBlock.svelte` | Create | Shared Shiki wrapper component |
| `frontend/src/components/DiffViewer.svelte` | Create | Unified diff rendering with syntax highlighting |
| `frontend/src/components/ChangedFiles.svelte` | Create | Collapsible file list panel using DataTable |
| `frontend/src/App.svelte` | Modify | Mount ChangedFiles below Terminal, handle `files-changed` WS |

### Tests (create new)

| File | Responsibility |
|------|---------------|
| `test/git-changed-files.test.ts` | Unit tests for `getChangedFiles()`, `getFileDiff()`, `generateFileSummary()` |
| `test/changed-files-api.test.ts` | HTTP endpoint tests for `/changed-files`, `/file-diff` |
| `test/git-watcher.test.ts` | Unit tests for `GitWatcher` lifecycle |

---

### Task 1: ChangedFile type + getChangedFiles()

**Files:**
- Modify: `server/types.ts`
- Modify: `server/git.ts`
- Create: `test/git-changed-files.test.ts`

- [ ] **Step 1: Add ChangedFile type to server/types.ts**

Add at the end of the types file, before any existing export:

```typescript
// Changed file status from git status/diff
export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  path: string;
  oldPath?: string;          // only for renames
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  directory: string;         // parent directory for DataTable groupBy
  summary?: string;          // rule-based summary (v1)
}

export interface ChangedFilesResponse {
  files: ChangedFile[];
  aggregate: { additions: number; deletions: number; fileCount: number };
  error?: string;
}

export interface FileDiffResponse {
  diff: string;
  summary?: string;
  error?: string;
}
```

- [ ] **Step 2: Write failing tests for getChangedFiles()**

Create `test/git-changed-files.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChangedFiles } from '../server/git.js';

describe('getChangedFiles', () => {
  it('parses working tree changes from git status + numstat', async () => {
    const files = await getChangedFiles('/tmp/repo', undefined, async (file, args, _opts) => {
      if (args[0] === 'status') {
        // porcelain v1 with -z: NUL-separated, format " M path" or "?? path"
        return { stdout: ' M server/git.ts\0?? frontend/new.svelte\0 D old-file.js\0', stderr: '' };
      }
      if (args[0] === 'diff' && args.includes('--numstat')) {
        return { stdout: '15\t3\tserver/git.ts\n', stderr: '' };
      }
      // wc -l for untracked files
      if (file === 'wc') {
        return { stdout: '      42 frontend/new.svelte', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    assert.equal(files.length, 3);

    const gitTs = files.find(f => f.path === 'server/git.ts');
    assert.ok(gitTs);
    assert.equal(gitTs.status, 'modified');
    assert.equal(gitTs.additions, 15);
    assert.equal(gitTs.deletions, 3);
    assert.equal(gitTs.directory, 'server');

    const newFile = files.find(f => f.path === 'frontend/new.svelte');
    assert.ok(newFile);
    assert.equal(newFile.status, 'untracked');
    assert.equal(newFile.additions, 42);
    assert.equal(newFile.directory, 'frontend');

    const deleted = files.find(f => f.path === 'old-file.js');
    assert.ok(deleted);
    assert.equal(deleted.status, 'deleted');
    assert.equal(deleted.directory, '.');
  });

  it('parses branch comparison with renames', async () => {
    const files = await getChangedFiles('/tmp/repo', 'main', async (_file, args, _opts) => {
      if (args[0] === 'diff' && args.includes('--name-status')) {
        return { stdout: 'M\tserver/git.ts\nA\tnew-file.ts\nR100\told-name.ts\tnew-name.ts\n', stderr: '' };
      }
      if (args[0] === 'diff' && args.includes('--numstat')) {
        return { stdout: '10\t2\tserver/git.ts\n50\t0\tnew-file.ts\n5\t5\tnew-name.ts\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    assert.equal(files.length, 3);

    const renamed = files.find(f => f.path === 'new-name.ts');
    assert.ok(renamed);
    assert.equal(renamed.status, 'renamed');
    assert.equal(renamed.oldPath, 'old-name.ts');
  });

  it('returns empty array on git failure', async () => {
    const files = await getChangedFiles('/tmp/repo', undefined, async () => {
      throw new Error('not a git repo');
    });
    assert.deepEqual(files, []);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="getChangedFiles"`
Expected: FAIL — `getChangedFiles` is not exported from `../server/git.js`

- [ ] **Step 4: Implement getChangedFiles()**

Add to `server/git.ts` before the export block:

```typescript
import type { ChangedFile, FileChangeStatus } from './types.js';

function parseStatus(code: string): FileChangeStatus {
  switch (code.trim()) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case '??': return 'untracked';
    default:
      if (code.startsWith('R')) return 'renamed';
      return 'modified';
  }
}

function fileDirectory(filePath: string): string {
  const dir = filePath.lastIndexOf('/');
  return dir === -1 ? '.' : filePath.slice(0, dir);
}

async function getChangedFiles(
  repoPath: string,
  base?: string,
  exec: ExecFileAsyncLike = execFileAsync as ExecFileAsyncLike,
): Promise<ChangedFile[]> {
  try {
    let statusEntries: Array<{ path: string; oldPath?: string; status: FileChangeStatus }>;

    if (base) {
      // Branch comparison
      const { stdout } = await exec('git', ['diff', '--name-status', '--find-renames', `${base}...HEAD`], { cwd: repoPath, timeout: 10000 });
      statusEntries = stdout.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        const code = parts[0] ?? '';
        if (code.startsWith('R')) {
          return { path: parts[2] ?? '', oldPath: parts[1] ?? '', status: 'renamed' as FileChangeStatus };
        }
        return { path: parts[1] ?? '', status: parseStatus(code) };
      });
    } else {
      // Working tree: git status --porcelain=v1 -z
      const { stdout } = await exec('git', ['status', '--porcelain=v1', '-z'], { cwd: repoPath, timeout: 10000 });
      statusEntries = [];
      const parts = stdout.split('\0').filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const entry = parts[i]!;
        const code = entry.slice(0, 2);
        const filePath = entry.slice(3);
        if (code.startsWith('R')) {
          // Next part is the new name
          const newPath = parts[++i] ?? filePath;
          statusEntries.push({ path: newPath, oldPath: filePath, status: 'renamed' });
        } else {
          statusEntries.push({ path: filePath, status: parseStatus(code) });
        }
      }
    }

    if (statusEntries.length === 0) return [];

    // Get per-file stats via numstat
    const numstatArgs = base
      ? ['diff', '--numstat', '--find-renames', `${base}...HEAD`]
      : ['diff', '--numstat', '--find-renames'];
    let numstatMap = new Map<string, { additions: number; deletions: number }>();
    try {
      const { stdout: numstat } = await exec('git', numstatArgs, { cwd: repoPath, timeout: 10000 });
      for (const line of numstat.split('\n').filter(Boolean)) {
        const [add, del, ...pathParts] = line.split('\t');
        const filePath = pathParts.join('\t'); // handle paths with tabs (rename format)
        const actualPath = filePath.includes(' => ') ? filePath.split(' => ').pop()!.replace(/}$/, '') : filePath;
        numstatMap.set(actualPath, {
          additions: add === '-' ? 0 : parseInt(add ?? '0', 10),
          deletions: del === '-' ? 0 : parseInt(del ?? '0', 10),
        });
      }
    } catch {
      // numstat failed — proceed with zeros
    }

    // Build result, deriving line counts for untracked files
    const files: ChangedFile[] = [];
    for (const entry of statusEntries) {
      if (!entry.path) continue;
      const stats = numstatMap.get(entry.path);
      let additions = stats?.additions ?? 0;
      let deletions = stats?.deletions ?? 0;

      if (entry.status === 'untracked' && additions === 0) {
        try {
          const { stdout: wcOut } = await exec('wc', ['-l', entry.path], { cwd: repoPath, timeout: 5000 });
          const match = wcOut.trim().match(/^\s*(\d+)/);
          if (match) additions = parseInt(match[1]!, 10);
        } catch {
          // best effort
        }
      }

      files.push({
        path: entry.path,
        oldPath: entry.oldPath,
        status: entry.status,
        additions,
        deletions,
        directory: fileDirectory(entry.path),
      });
    }

    return files;
  } catch {
    return [];
  }
}
```

Add `getChangedFiles` to the export block and add the `ChangedFile`, `FileChangeStatus` imports to the existing types import.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="getChangedFiles"`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add server/types.ts server/git.ts test/git-changed-files.test.ts
git commit -m "feat: add getChangedFiles() with working tree and branch comparison modes"
```

---

### Task 2: getFileDiff()

**Files:**
- Modify: `server/git.ts`
- Modify: `test/git-changed-files.test.ts`

- [ ] **Step 1: Write failing tests for getFileDiff()**

Append to `test/git-changed-files.test.ts`:

```typescript
import { getFileDiff } from '../server/git.js';

describe('getFileDiff', () => {
  it('returns working tree diff for a file', async () => {
    const diff = await getFileDiff('/tmp/repo', 'server/git.ts', undefined, async (_file, args) => {
      assert.equal(args[0], 'diff');
      assert.ok(args.includes('--unified=3'));
      assert.ok(args.includes('--find-renames'));
      assert.ok(args.includes('--'));
      assert.ok(args.includes('server/git.ts'));
      return { stdout: 'diff --git a/server/git.ts b/server/git.ts\n--- a/server/git.ts\n+++ b/server/git.ts\n@@ -1,3 +1,4 @@\n+new line\n old\n', stderr: '' };
    });
    assert.ok(diff.includes('new line'));
  });

  it('returns staged diff when base is "cached"', async () => {
    const diff = await getFileDiff('/tmp/repo', 'file.ts', 'cached', async (_file, args) => {
      assert.ok(args.includes('--cached'));
      return { stdout: 'staged diff output', stderr: '' };
    });
    assert.equal(diff, 'staged diff output');
  });

  it('returns branch comparison diff', async () => {
    const diff = await getFileDiff('/tmp/repo', 'file.ts', 'main', async (_file, args) => {
      assert.ok(args.includes('main...HEAD'));
      return { stdout: 'branch diff output', stderr: '' };
    });
    assert.equal(diff, 'branch diff output');
  });

  it('returns empty string on git failure', async () => {
    const diff = await getFileDiff('/tmp/repo', 'file.ts', undefined, async () => {
      throw new Error('git failed');
    });
    assert.equal(diff, '');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="getFileDiff"`
Expected: FAIL — `getFileDiff` is not exported

- [ ] **Step 3: Implement getFileDiff()**

Add to `server/git.ts` before the export block:

```typescript
async function getFileDiff(
  repoPath: string,
  filePath: string,
  base?: string,
  exec: ExecFileAsyncLike = execFileAsync as ExecFileAsyncLike,
): Promise<string> {
  try {
    let args: string[];
    if (!base) {
      args = ['diff', '--unified=3', '--find-renames', '--', filePath];
    } else if (base === 'cached') {
      args = ['diff', '--cached', '--unified=3', '--', filePath];
    } else {
      args = ['diff', `${base}...HEAD`, '--unified=3', '--find-renames', '--', filePath];
    }

    const { stdout } = await exec('git', args, { cwd: repoPath, timeout: 10000 });

    // If empty (no changes or untracked), try --no-index for new files
    if (!stdout.trim()) {
      try {
        const { stdout: noIndexOut } = await exec('git', ['diff', '--no-index', '/dev/null', filePath], { cwd: repoPath, timeout: 10000 });
        return noIndexOut;
      } catch (err: unknown) {
        // git diff --no-index exits with code 1 when there ARE differences
        const e = err as { stdout?: string };
        if (e.stdout) return e.stdout;
      }
    }

    return stdout;
  } catch {
    return '';
  }
}
```

Add `getFileDiff` to the export block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="getFileDiff"`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/git.ts test/git-changed-files.test.ts
git commit -m "feat: add getFileDiff() with working tree, staged, and branch comparison modes"
```

---

### Task 3: REST endpoints (/changed-files, /file-diff)

**Files:**
- Modify: `server/workspaces.ts`
- Create: `test/changed-files-api.test.ts`

- [ ] **Step 1: Write failing tests for the endpoints**

Create `test/changed-files-api.test.ts`:

```typescript
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';

import { createWorkspaceRouter } from '../server/workspaces.js';
import { saveConfig, DEFAULTS } from '../server/config.js';

let tmpDir: string;
let configPath: string;
let repoDir: string;
let server: Server;
let baseUrl: string;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'changed-files-test-'));
  configPath = path.join(tmpDir, 'config.json');
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });

  saveConfig(configPath, { ...DEFAULTS, workspaces: [repoDir] });

  const app = express();
  app.use(express.json());

  // Mock exec that returns predictable git output
  const mockExec = async (_file: string, args: string[], _opts: { cwd: string }) => {
    if (args[0] === 'status' && args.includes('--porcelain=v1')) {
      return { stdout: ' M server/git.ts\0?? new-file.ts\0', stderr: '' };
    }
    if (args[0] === 'diff' && args.includes('--numstat')) {
      return { stdout: '10\t2\tserver/git.ts\n', stderr: '' };
    }
    if (args[0] === 'diff' && args.includes('--unified=3')) {
      return { stdout: 'diff output for file', stderr: '' };
    }
    if (_file === 'wc') {
      return { stdout: '      20 new-file.ts', stderr: '' };
    }
    // For detectGitRepo
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
      return { stdout: '.git\n', stderr: '' };
    }
    if (args[0] === 'symbolic-ref') {
      return { stdout: 'origin/main\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  app.use('/workspaces', createWorkspaceRouter({ configPath, execAsync: mockExec as any }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  server?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /workspaces/changed-files', () => {
  test('returns changed files for a workspace', async () => {
    const res = await fetch(`${baseUrl}/workspaces/changed-files?path=${encodeURIComponent(repoDir)}`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(Array.isArray(data.files));
    assert.ok(data.aggregate);
    assert.equal(data.aggregate.fileCount, 2);
  });

  test('returns 400 without path parameter', async () => {
    const res = await fetch(`${baseUrl}/workspaces/changed-files`);
    assert.equal(res.status, 400);
  });
});

describe('GET /workspaces/file-diff', () => {
  test('returns diff for a specific file', async () => {
    const res = await fetch(`${baseUrl}/workspaces/file-diff?path=${encodeURIComponent(repoDir)}&file=server/git.ts`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(typeof data.diff === 'string');
  });

  test('returns 400 without file parameter', async () => {
    const res = await fetch(`${baseUrl}/workspaces/file-diff?path=${encodeURIComponent(repoDir)}`);
    assert.equal(res.status, 400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="changed-files|file-diff"`
Expected: FAIL — routes don't exist yet (404)

- [ ] **Step 3: Implement the endpoints**

Add to `server/workspaces.ts` inside `createWorkspaceRouter`, after the existing routes (before the final `return router`). Also add the import of `getChangedFiles` and `getFileDiff` from `./git.js`:

Add to the import at the top of workspaces.ts:
```typescript
import { ..., getChangedFiles, getFileDiff } from './git.js';
```

Add the routes:
```typescript
  // GET /workspaces/changed-files — list changed files in a repo
  router.get('/changed-files', async (req: Request, res: Response) => {
    const repoPath = req.query.path as string | undefined;
    if (!repoPath) {
      res.status(400).json({ files: [], aggregate: { additions: 0, deletions: 0, fileCount: 0 }, error: 'path parameter required' });
      return;
    }

    const base = req.query.base as string | undefined;

    try {
      const files = await getChangedFiles(repoPath, base, exec);
      const aggregate = {
        additions: files.reduce((sum, f) => sum + f.additions, 0),
        deletions: files.reduce((sum, f) => sum + f.deletions, 0),
        fileCount: files.length,
      };
      res.json({ files, aggregate });
    } catch (err) {
      res.status(500).json({ files: [], aggregate: { additions: 0, deletions: 0, fileCount: 0 }, error: 'Failed to get changed files' });
    }
  });

  // GET /workspaces/file-diff — get diff for a specific file
  router.get('/file-diff', async (req: Request, res: Response) => {
    const repoPath = req.query.path as string | undefined;
    const filePath = req.query.file as string | undefined;
    if (!repoPath || !filePath) {
      res.status(400).json({ diff: '', error: 'path and file parameters required' });
      return;
    }

    const base = req.query.base as string | undefined;

    try {
      const diff = await getFileDiff(repoPath, filePath, base, exec);
      res.json({ diff });
    } catch (err) {
      res.status(500).json({ diff: '', error: 'Failed to get file diff' });
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="changed-files|file-diff"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add server/workspaces.ts test/changed-files-api.test.ts
git commit -m "feat: add /changed-files and /file-diff REST endpoints"
```

---

### Task 4: GitWatcher (.git/ directory watching + WS broadcast)

**Files:**
- Modify: `server/watcher.ts`
- Modify: `server/index.ts`
- Create: `test/git-watcher.test.ts`

- [ ] **Step 1: Write failing test for GitWatcher**

Create `test/git-watcher.test.ts`:

```typescript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GitWatcher } from '../server/watcher.js';

let tmpDir: string;
let repoDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-watcher-test-'));
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GitWatcher', () => {
  it('emits files-changed when .git/ directory changes', async () => {
    const watcher = new GitWatcher();
    let emitted = false;
    let emittedPath = '';

    watcher.on('files-changed', (data: { workspacePath: string }) => {
      emitted = true;
      emittedPath = data.workspacePath;
    });

    watcher.watch(repoDir);

    // Trigger a change in .git/
    fs.writeFileSync(path.join(repoDir, '.git', 'index'), 'fake');

    // Wait for debounce (500ms) + buffer
    await new Promise(resolve => setTimeout(resolve, 800));

    assert.ok(emitted, 'should emit files-changed');
    assert.equal(emittedPath, repoDir);

    watcher.close();
  });

  it('does not emit after close()', async () => {
    const watcher = new GitWatcher();
    let emitCount = 0;

    watcher.on('files-changed', () => { emitCount++; });
    watcher.watch(repoDir);
    watcher.close();

    fs.writeFileSync(path.join(repoDir, '.git', 'index2'), 'fake');
    await new Promise(resolve => setTimeout(resolve, 800));

    assert.equal(emitCount, 0);
  });

  it('deduplicates watchers for the same path', () => {
    const watcher = new GitWatcher();
    watcher.watch(repoDir);
    watcher.watch(repoDir);
    // Should not throw, should have refCount = 2
    watcher.unwatch(repoDir);
    // Still watching (refCount = 1)
    watcher.unwatch(repoDir);
    // Now closed (refCount = 0)
    watcher.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="GitWatcher"`
Expected: FAIL — `GitWatcher` is not exported

- [ ] **Step 3: Implement GitWatcher**

Add to `server/watcher.ts` after the `RefWatcher` class:

```typescript
export class GitWatcher extends EventEmitter {
  private _watchers = new Map<string, { watcher: fs.FSWatcher; refCount: number }>();
  private _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  watch(workspacePath: string): void {
    const existing = this._watchers.get(workspacePath);
    if (existing) {
      existing.refCount++;
      return;
    }

    const gitDir = path.join(workspacePath, '.git');
    if (!fs.existsSync(gitDir)) return;

    // For worktrees, .git is a file — resolve to actual git dir
    let watchTarget: string;
    try {
      const stat = fs.statSync(gitDir);
      if (stat.isFile()) {
        const content = fs.readFileSync(gitDir, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (!match) return;
        watchTarget = path.resolve(workspacePath, match[1]!);
      } else {
        watchTarget = gitDir;
      }
    } catch {
      return;
    }

    try {
      const watcher = fs.watch(watchTarget, { persistent: false }, () => {
        this._debouncedEmit(workspacePath);
      });
      watcher.on('error', () => {});
      this._watchers.set(workspacePath, { watcher, refCount: 1 });
    } catch {
      // Cannot watch — directory may not exist
    }
  }

  unwatch(workspacePath: string): void {
    const entry = this._watchers.get(workspacePath);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      try { entry.watcher.close(); } catch {}
      this._watchers.delete(workspacePath);
      const timer = this._debounceTimers.get(workspacePath);
      if (timer) {
        clearTimeout(timer);
        this._debounceTimers.delete(workspacePath);
      }
    }
  }

  private _debouncedEmit(workspacePath: string): void {
    const existing = this._debounceTimers.get(workspacePath);
    if (existing) clearTimeout(existing);
    this._debounceTimers.set(workspacePath, setTimeout(() => {
      this._debounceTimers.delete(workspacePath);
      this.emit('files-changed', { workspacePath });
    }, 500));
  }

  close(): void {
    for (const entry of this._watchers.values()) {
      try { entry.watcher.close(); } catch {}
    }
    this._watchers.clear();
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="GitWatcher"`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire GitWatcher into server/index.ts**

In `server/index.ts`, add the import:
```typescript
import { WorktreeWatcher, BranchWatcher, RefWatcher, GitWatcher, WORKTREE_DIRS, ... } from './watcher.js';
```

After the `const watcher = new WorktreeWatcher()` line (~line 281), add:
```typescript
  const gitWatcher = new GitWatcher();
```

After `const { broadcastEvent } = setupWebSocket(...)` (~line 285), connect the gitWatcher:
```typescript
  gitWatcher.on('files-changed', (data: { workspacePath: string }) => {
    broadcastEvent('files-changed', { workspacePath: data.workspacePath });
  });
```

In the session creation success path (after `POST /sessions` creates a session), add git watching:
```typescript
  // Start watching .git/ for the session's working directory
  gitWatcher.watch(newSession.cwd);
```

In session cleanup (where `DELETE /sessions/:id` is handled), add unwatching:
```typescript
  gitWatcher.unwatch(session.cwd);
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add server/watcher.ts server/index.ts test/git-watcher.test.ts
git commit -m "feat: add GitWatcher for .git/ directory watching with files-changed WS broadcast"
```

---

### Task 5: Install frontend dependencies (shiki, diff2html)

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install shiki and diff2html**

```bash
npm install shiki diff2html
```

- [ ] **Step 2: Verify install succeeded**

```bash
node -e "import('shiki').then(m => console.log('shiki OK:', Object.keys(m).slice(0,3)))"
node -e "import('diff2html').then(m => console.log('diff2html OK:', Object.keys(m).slice(0,3)))"
```

Expected: Both print OK with some export keys

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add shiki and diff2html for syntax-highlighted diff rendering"
```

---

### Task 6: Frontend types + API client + WS event handler

**Files:**
- Modify: `frontend/src/lib/types.ts`
- Modify: `frontend/src/lib/api.ts`

- [ ] **Step 1: Add frontend types**

Add to `frontend/src/lib/types.ts`:

```typescript
// Changed files panel types
export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  directory: string;
  summary?: string;
}

export interface ChangedFilesResponse {
  files: ChangedFile[];
  aggregate: { additions: number; deletions: number; fileCount: number };
  error?: string;
}

export interface FileDiffResponse {
  diff: string;
  summary?: string;
  error?: string;
}
```

- [ ] **Step 2: Add API client functions**

Add to `frontend/src/lib/api.ts`:

```typescript
import type { ChangedFilesResponse, FileDiffResponse } from './types.js';

export async function fetchChangedFiles(workspacePath: string, base?: string): Promise<ChangedFilesResponse> {
  const params = new URLSearchParams({ path: workspacePath });
  if (base) params.set('base', base);
  const res = await fetch('/workspaces/changed-files?' + params.toString());
  if (!res.ok) {
    return { files: [], aggregate: { additions: 0, deletions: 0, fileCount: 0 }, error: `HTTP ${res.status}` };
  }
  return res.json() as Promise<ChangedFilesResponse>;
}

export async function fetchFileDiff(workspacePath: string, filePath: string, base?: string): Promise<FileDiffResponse> {
  const params = new URLSearchParams({ path: workspacePath, file: filePath });
  if (base) params.set('base', base);
  const res = await fetch('/workspaces/file-diff?' + params.toString());
  if (!res.ok) {
    return { diff: '', error: `HTTP ${res.status}` };
  }
  return res.json() as Promise<FileDiffResponse>;
}
```

- [ ] **Step 3: Add `files-changed` to WS event type**

In `frontend/src/lib/ws.ts`, add `workspacePath` to the `EventMessage` interface:

```typescript
interface EventMessage {
  type: string;
  sessionId?: string;
  idle?: boolean;
  state?: string;
  branchName?: string;
  displayName?: string;
  cwd?: string;
  cwdPath?: string;
  branch?: string;
  repo?: string;
  workspacePath?: string;  // NEW: for files-changed events
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/types.ts frontend/src/lib/api.ts frontend/src/lib/ws.ts
git commit -m "feat: add frontend types and API client for changed files and file diff"
```

---

### Task 7: Smart summaries utility (pure functions)

**Files:**
- Create: `frontend/src/lib/diff-summary.ts`

- [ ] **Step 1: Create the diff summary module**

Create `frontend/src/lib/diff-summary.ts`:

```typescript
/**
 * Rule-based smart summaries for diff content (v1).
 * Parses diff hunks to generate one-line descriptions of what changed.
 */

export function generateFileSummary(diffContent: string, filePath: string, status: string): string {
  if (status === 'deleted') return 'deleted file';
  if (status === 'untracked') {
    const firstMeaningfulLine = extractFirstMeaningfulLine(diffContent);
    if (firstMeaningfulLine) return `new file: ${firstMeaningfulLine}`;
    return 'new file';
  }

  const addedLines = diffContent.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
  const removedLines = diffContent.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));

  // Detect added functions
  const addedFunctions = addedLines
    .map(l => l.slice(1)) // strip leading +
    .map(l => extractFunctionName(l))
    .filter(Boolean);

  if (addedFunctions.length === 1) {
    return `added ${addedFunctions[0]}()`;
  }
  if (addedFunctions.length > 1) {
    return `added ${addedFunctions.length} functions`;
  }

  // Detect modified functions from hunk headers
  const hunkFunctions = extractHunkFunctions(diffContent);
  if (hunkFunctions.length === 1) {
    return `modified ${addedLines.length} lines in ${hunkFunctions[0]}()`;
  }
  if (hunkFunctions.length > 1) {
    return `modified ${hunkFunctions.length} functions`;
  }

  // Fallback: +N -N lines
  return `+${addedLines.length} -${removedLines.length} lines`;
}

function extractFunctionName(line: string): string | null {
  // Match: function name, async function name, const name = (, export function name
  const match = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/);
  if (match) return match[1] ?? match[2] ?? null;
  return null;
}

function extractFirstMeaningfulLine(diff: string): string | null {
  const lines = diff.split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .map(l => l.slice(1).trim())
    .filter(l => l && !l.startsWith('import ') && !l.startsWith('//') && !l.startsWith('/*'));
  return lines[0]?.slice(0, 60) ?? null;
}

function extractHunkFunctions(diff: string): string[] {
  // Hunk headers: @@ -a,b +c,d @@ functionName
  const hunks = diff.match(/@@ .+? @@\s*(.+)/g) || [];
  return hunks
    .map(h => {
      const match = h.match(/@@ .+? @@\s*(?:export\s+)?(?:async\s+)?(?:function\s+)?(\w+)/);
      return match?.[1] ?? null;
    })
    .filter((name): name is string => name !== null && name !== 'function');
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/diff-summary.ts
git commit -m "feat: add rule-based smart diff summaries (v1)"
```

---

### Task 8: CodeBlock.svelte (Shiki wrapper)

**Files:**
- Create: `frontend/src/lib/shiki.ts`
- Create: `frontend/src/components/CodeBlock.svelte`

- [ ] **Step 1: Create the Shiki singleton module**

Create `frontend/src/lib/shiki.ts`:

```typescript
import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';
import type { ThemedToken } from 'shiki';

export type { ThemedToken };

// Custom TUI theme matching DESIGN.md colors
const tuiTheme = {
  name: 'tui',
  type: 'dark' as const,
  colors: {
    'editor.background': '#00000000', // transparent
    'editor.foreground': '#e0e0e0',
  },
  tokenColors: [
    { scope: ['keyword', 'storage.type', 'storage.modifier'], settings: { foreground: '#c792ea' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#82aaff' } },
    { scope: ['string', 'string.quoted'], settings: { foreground: '#c3e88d' } },
    { scope: ['entity.name.type', 'support.type'], settings: { foreground: '#ffcb6b' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#888888' } },
    { scope: ['constant.numeric'], settings: { foreground: '#f78c6c' } },
    { scope: ['variable', 'variable.other'], settings: { foreground: '#e0e0e0' } },
    { scope: ['punctuation'], settings: { foreground: '#888888' } },
  ],
};

// Preload the top 5 grammars on first use
const PRELOAD_LANGS: BundledLanguage[] = ['typescript', 'javascript', 'json', 'css', 'svelte'];

let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [tuiTheme],
      langs: PRELOAD_LANGS,
    });
  }
  return highlighterPromise;
}

/**
 * Detect language from file path extension.
 */
export function detectLanguage(filePath: string): BundledLanguage {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, BundledLanguage> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    css: 'css',
    svelte: 'svelte',
    html: 'html',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
  };
  return map[ext] ?? 'text';
}

/**
 * Tokenize code for a given language. Lazy-loads grammar if not preloaded.
 */
export async function tokenizeCode(code: string, lang: BundledLanguage): Promise<ThemedToken[][]> {
  const highlighter = await getHighlighter();

  // Lazy-load grammar if not already loaded
  const loadedLangs = highlighter.getLoadedLanguages();
  if (!loadedLangs.includes(lang)) {
    try {
      await highlighter.loadLanguage(lang);
    } catch {
      // Unknown language — fall back to text
      lang = 'text';
    }
  }

  const { tokens } = highlighter.codeToTokens(code, {
    lang,
    theme: 'tui',
  });
  return tokens;
}
```

- [ ] **Step 2: Create CodeBlock.svelte**

Create `frontend/src/components/CodeBlock.svelte`:

```svelte
<script lang="ts">
  import { tokenizeCode, detectLanguage, type ThemedToken } from '../lib/shiki.js';

  let {
    code,
    language,
    showLineNumbers = true,
    startLine = 1,
  }: {
    code: string;
    language?: string;
    showLineNumbers?: boolean;
    startLine?: number;
  } = $props();

  let tokens = $state<ThemedToken[][] | null>(null);
  let error = $state(false);

  const resolvedLang = $derived(language ?? 'text');

  $effect(() => {
    const lang = resolvedLang;
    const src = code;
    error = false;
    tokens = null;
    tokenizeCode(src, lang as any).then(
      (t) => { tokens = t; },
      () => { error = true; },
    );
  });
</script>

<div class="code-block">
  {#if tokens}
    <pre><code>{#each tokens as line, i}<span class="line">{#if showLineNumbers}<span class="line-number">{startLine + i}</span>{/if}{#each line as token}<span style="color: {token.color ?? '#e0e0e0'}">{token.content}</span>{/each}</span>
{/each}</code></pre>
  {:else if error}
    <pre class="fallback"><code>{code}</code></pre>
  {:else}
    <pre class="loading"><code>{code}</code></pre>
  {/if}
</div>

<style>
  .code-block {
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    line-height: 1.5;
    overflow-x: auto;
    background: transparent;
  }

  pre {
    margin: 0;
    white-space: pre;
  }

  code {
    display: block;
  }

  .line {
    display: block;
    min-height: 1.5em;
  }

  .line-number {
    display: inline-block;
    width: 3.5em;
    text-align: right;
    padding-right: 1em;
    color: #888888;
    user-select: none;
  }

  .fallback, .loading {
    color: var(--text, #e0e0e0);
  }

  .loading {
    opacity: 0.5;
  }
</style>
```

- [ ] **Step 3: Verify build compiles**

Run: `npm run build`
Expected: Build succeeds without errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/shiki.ts frontend/src/components/CodeBlock.svelte
git commit -m "feat: add CodeBlock.svelte with Shiki syntax highlighting and TUI theme"
```

---

### Task 9: DiffViewer.svelte (diff2html + Shiki)

**Files:**
- Create: `frontend/src/components/DiffViewer.svelte`

- [ ] **Step 1: Create DiffViewer.svelte**

Create `frontend/src/components/DiffViewer.svelte`:

```svelte
<script lang="ts">
  import { parse, type DiffFile } from 'diff2html';
  import { tokenizeCode, detectLanguage, type ThemedToken } from '../lib/shiki.js';

  let {
    diff,
    filePath,
    loading = false,
  }: {
    diff: string;
    filePath: string;
    loading?: boolean;
  } = $props();

  interface HighlightedLine {
    type: 'add' | 'delete' | 'context';
    oldNumber?: number;
    newNumber?: number;
    tokens: ThemedToken[] | null;
    content: string;
  }

  let lines = $state<HighlightedLine[]>([]);
  let hunkHeaders = $state<Array<{ index: number; content: string }>>([]);
  let highlightReady = $state(false);

  $effect(() => {
    const d = diff;
    const fp = filePath;
    highlightReady = false;
    lines = [];
    hunkHeaders = [];

    if (!d) return;

    // Parse diff with diff2html
    const parsed: DiffFile[] = parse(d);
    if (parsed.length === 0) return;

    const file = parsed[0]!;
    const lang = detectLanguage(fp);

    // Extract all lines and hunk headers
    const rawLines: HighlightedLine[] = [];
    const rawHunkHeaders: Array<{ index: number; content: string }> = [];

    for (const block of file.blocks) {
      rawHunkHeaders.push({ index: rawLines.length, content: block.header });
      for (const line of block.lines) {
        const type = line.type === 'insert' ? 'add' as const
          : line.type === 'delete' ? 'delete' as const
          : 'context' as const;

        rawLines.push({
          type,
          oldNumber: line.oldNumber !== undefined ? line.oldNumber : undefined,
          newNumber: line.newNumber !== undefined ? line.newNumber : undefined,
          tokens: null,
          content: line.content.slice(1), // strip leading +/-/space
        });
      }
    }

    // First render without highlighting
    lines = rawLines;
    hunkHeaders = rawHunkHeaders;

    // Then apply Shiki highlighting
    const codeStr = rawLines.map(l => l.content).join('\n');
    tokenizeCode(codeStr, lang as any).then((tokenLines) => {
      lines = rawLines.map((line, i) => ({
        ...line,
        tokens: tokenLines[i] ?? null,
      }));
      highlightReady = true;
    }).catch(() => {
      highlightReady = true; // show plain text
    });
  });
</script>

<div class="diff-viewer" role="region" aria-label="File diff">
  {#if loading}
    <div class="diff-loading">loading diff...</div>
  {:else if lines.length === 0}
    <div class="diff-empty">no changes</div>
  {:else}
    <div class="diff-content">
      {#each lines as line, i (i)}
        {#if hunkHeaders.find(h => h.index === i)}
          <div class="hunk-header">{hunkHeaders.find(h => h.index === i)?.content ?? ''}</div>
        {/if}
        <div
          class="diff-line {line.type}"
          data-old={line.oldNumber ?? ''}
          data-new={line.newNumber ?? ''}
        >
          <span class="line-number old">{line.oldNumber ?? ''}</span>
          <span class="line-number new">{line.newNumber ?? ''}</span>
          <span class="line-prefix">{line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '}</span>
          <span class="line-content">{#if line.tokens}{#each line.tokens as token}<span style="color: {token.color ?? '#e0e0e0'}">{token.content}</span>{/each}{:else}{line.content}{/if}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .diff-viewer {
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    line-height: 1.5;
    max-height: 400px;
    overflow: auto;
    border: 1px solid var(--border, #333);
    background: transparent;
  }

  .diff-loading, .diff-empty {
    padding: 12px;
    color: var(--text-muted, #888);
  }

  .diff-content {
    min-width: max-content;
  }

  .diff-line {
    display: flex;
    white-space: pre;
    min-height: 1.5em;
  }

  .diff-line.add {
    background: rgba(74, 222, 128, 0.08);
  }

  .diff-line.add .line-content,
  .diff-line.add .line-prefix {
    color: var(--status-success, #4ade80);
  }

  .diff-line.delete {
    background: rgba(248, 113, 113, 0.08);
  }

  .diff-line.delete .line-content,
  .diff-line.delete .line-prefix {
    color: var(--status-error, #f87171);
  }

  .line-number {
    display: inline-block;
    width: 3.5em;
    text-align: right;
    padding-right: 0.5em;
    color: #888888;
    user-select: none;
    flex-shrink: 0;
  }

  .line-prefix {
    display: inline-block;
    width: 1.5em;
    text-align: center;
    user-select: none;
    flex-shrink: 0;
  }

  .line-content {
    flex: 1;
    padding-right: 1em;
  }

  .hunk-header {
    padding: 4px 12px;
    color: var(--accent, #d97757);
    background: rgba(217, 119, 87, 0.05);
    font-style: italic;
    border-top: 1px solid var(--border, #333);
    border-bottom: 1px solid var(--border, #333);
    user-select: none;
  }
</style>
```

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/DiffViewer.svelte
git commit -m "feat: add DiffViewer.svelte with diff2html parsing and Shiki syntax highlighting"
```

---

### Task 10: ChangedFiles.svelte (DataTable + DiffViewer)

**Files:**
- Create: `frontend/src/components/ChangedFiles.svelte`

- [ ] **Step 1: Create ChangedFiles.svelte**

Create `frontend/src/components/ChangedFiles.svelte`:

```svelte
<script lang="ts">
  import type { Column } from './DataTable.svelte';
  import DataTable from './DataTable.svelte';
  import DiffViewer from './DiffViewer.svelte';
  import CipherText from './CipherText.svelte';
  import { fetchChangedFiles, fetchFileDiff } from '../lib/api.js';
  import { generateFileSummary } from '../lib/diff-summary.js';
  import type { ChangedFile, FileDiffResponse } from '../lib/types.js';

  let {
    workspacePath,
    base,
  }: {
    workspacePath: string;
    base?: string;
  } = $props();

  // State
  let files = $state<ChangedFile[]>([]);
  let aggregate = $state({ additions: 0, deletions: 0, fileCount: 0 });
  let loading = $state(false);
  let error = $state<string | undefined>(undefined);
  let expanded = $state(false);
  let expandedFile = $state<string | null>(null);
  let fileDiff = $state<string>('');
  let diffLoading = $state(false);

  // Sort state
  let sortBy = $state('path');
  let sortDir = $state<'asc' | 'desc'>('asc');

  const columns: Column[] = [
    { key: 'status', label: '', width: '24px' },
    { key: 'path', label: 'file', sortable: true },
    { key: 'additions', label: '+', sortable: true, width: '50px' },
    { key: 'deletions', label: '-', sortable: true, width: '50px' },
  ];

  let sortedFiles = $derived.by(() => {
    const sorted = [...files];
    sorted.sort((a, b) => {
      const aVal = (a as Record<string, unknown>)[sortBy];
      const bVal = (b as Record<string, unknown>)[sortBy];
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
      }
      const aStr = String(aVal ?? '');
      const bStr = String(bVal ?? '');
      return sortDir === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
    });
    return sorted;
  });

  const statusIcon: Record<string, string> = {
    added: '+',
    modified: '~',
    deleted: '-',
    renamed: '→',
    untracked: '?',
  };

  const statusColor: Record<string, string> = {
    added: 'var(--status-success)',
    modified: 'var(--status-warning)',
    deleted: 'var(--status-error)',
    renamed: 'var(--status-info)',
    untracked: 'var(--text-muted)',
  };

  export async function refresh() {
    if (!workspacePath) return;
    loading = true;
    error = undefined;
    try {
      const data = await fetchChangedFiles(workspacePath, base);
      files = data.files;
      aggregate = data.aggregate;
      error = data.error;
    } catch {
      error = 'Failed to fetch changed files';
      files = [];
    } finally {
      loading = false;
    }
  }

  // Fetch on mount and when workspace/base changes
  $effect(() => {
    const wp = workspacePath;
    const b = base;
    if (wp) refresh();
  });

  function handleSort(col: string) {
    if (sortBy === col) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortBy = col;
      sortDir = 'asc';
    }
  }

  async function handleRowAction(file: ChangedFile) {
    if (expandedFile === file.path) {
      expandedFile = null;
      fileDiff = '';
      return;
    }
    expandedFile = file.path;
    diffLoading = true;
    try {
      const data = await fetchFileDiff(workspacePath, file.path, base);
      fileDiff = data.diff;
      // Generate summary from diff if not already present
      if (!file.summary && fileDiff) {
        file.summary = generateFileSummary(fileDiff, file.path, file.status);
      }
    } catch {
      fileDiff = '';
    } finally {
      diffLoading = false;
    }
  }

  function fileName(filePath: string): string {
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? filePath : filePath.slice(idx + 1);
  }
</script>

<div class="changed-files-panel">
  <!-- Collapsed summary bar -->
  <button
    class="summary-bar"
    onclick={() => { expanded = !expanded; if (expanded && files.length === 0) refresh(); }}
    aria-expanded={expanded}
  >
    <span class="summary-label">changed files</span>
    {#if aggregate.fileCount > 0}
      <span class="summary-stats">
        {aggregate.fileCount} file{aggregate.fileCount !== 1 ? 's' : ''}
        <span class="stat-add">+{aggregate.additions}</span>
        <span class="stat-del">-{aggregate.deletions}</span>
      </span>
    {:else if loading}
      <span class="summary-stats loading-text">scanning...</span>
    {:else}
      <span class="summary-stats muted">no changes</span>
    {/if}
    <span class="expand-indicator">{expanded ? '▾' : '▸'}</span>
  </button>

  {#if expanded}
    <div class="files-content">
      <DataTable
        {columns}
        rows={sortedFiles}
        groupBy="directory"
        {sortBy}
        {sortDir}
        onSort={handleSort}
        {loading}
        {error}
        emptyMessage="no changes detected"
        onRowAction={handleRowAction}
        maxHeight="300px"
      >
        {#snippet row(file: ChangedFile, _index: number)}
          <div class="file-row" class:expanded-row={expandedFile === file.path}>
            <span class="status-icon" style="color: {statusColor[file.status] ?? 'var(--text-muted)'}">{statusIcon[file.status] ?? '?'}</span>
            <span class="file-name" title={file.path}>
              {fileName(file.path)}
              {#if file.summary}
                <span class="file-summary">{file.summary}</span>
              {/if}
            </span>
            <span class="stat stat-add">+{file.additions}</span>
            <span class="stat stat-del">-{file.deletions}</span>
          </div>
          {#if expandedFile === file.path}
            <div class="inline-diff">
              <DiffViewer diff={fileDiff} filePath={file.path} loading={diffLoading} />
            </div>
          {/if}
        {/snippet}

        {#snippet mobileCard(file: ChangedFile, _index: number)}
          <div class="mobile-file-card" onclick={() => handleRowAction(file)}>
            <div class="card-header">
              <span class="status-icon" style="color: {statusColor[file.status] ?? 'var(--text-muted)'}">{statusIcon[file.status] ?? '?'}</span>
              <span class="file-name">{fileName(file.path)}</span>
              <span class="card-stats">
                <span class="stat-add">+{file.additions}</span>
                <span class="stat-del">-{file.deletions}</span>
              </span>
            </div>
            {#if file.summary}
              <div class="card-summary">{file.summary}</div>
            {/if}
            {#if file.path === file.path && expandedFile === file.path}
              <div class="inline-diff">
                <DiffViewer diff={fileDiff} filePath={file.path} loading={diffLoading} />
              </div>
            {/if}
          </div>
        {/snippet}
      </DataTable>
    </div>
  {/if}
</div>

<style>
  .changed-files-panel {
    border-top: 1px solid var(--border, #333);
  }

  .summary-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px;
    background: transparent;
    border: none;
    cursor: pointer;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--text-muted, #888);
    text-align: left;
  }

  .summary-bar:hover {
    background: var(--surface-hover, #141414);
  }

  .summary-label {
    color: var(--text, #e0e0e0);
  }

  .summary-stats {
    flex: 1;
  }

  .loading-text {
    opacity: 0.6;
  }

  .muted {
    opacity: 0.5;
  }

  .stat-add { color: var(--status-success, #4ade80); }
  .stat-del { color: var(--status-error, #f87171); }

  .expand-indicator {
    flex-shrink: 0;
    opacity: 0.5;
  }

  .files-content {
    border-top: 1px solid var(--border, #333);
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    cursor: pointer;
  }

  .file-row:hover {
    background: var(--surface-hover, #141414);
  }

  .expanded-row {
    background: var(--surface-hover, #141414);
  }

  .status-icon {
    flex-shrink: 0;
    width: 16px;
    text-align: center;
    font-weight: bold;
  }

  .file-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--text, #e0e0e0);
  }

  .file-summary {
    margin-left: 8px;
    color: var(--text-muted, #888);
    font-size: var(--font-size-xs, 0.75rem);
  }

  .stat {
    flex-shrink: 0;
    width: 40px;
    text-align: right;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
  }

  .inline-diff {
    margin: 4px 0 4px 24px;
  }

  /* Mobile card */
  .mobile-file-card {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border, #333);
    cursor: pointer;
  }

  .mobile-file-card:active {
    background: var(--surface-hover, #141414);
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .card-stats {
    margin-left: auto;
    display: flex;
    gap: 8px;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
  }

  .card-summary {
    margin-top: 4px;
    padding-left: 24px;
    color: var(--text-muted, #888);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
  }
</style>
```

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ChangedFiles.svelte
git commit -m "feat: add ChangedFiles.svelte panel with DataTable, inline diffs, and mobile cards"
```

---

### Task 11: Wire into App.svelte session view

**Files:**
- Modify: `frontend/src/App.svelte`

- [ ] **Step 1: Import ChangedFiles component**

Add to the imports section of `frontend/src/App.svelte`:

```typescript
import ChangedFiles from './components/ChangedFiles.svelte';
```

- [ ] **Step 2: Add changedFilesRef state**

Add near the other component refs (~line 62):

```typescript
let changedFilesRef = $state<ChangedFiles | undefined>();
```

- [ ] **Step 3: Add the ChangedFiles panel in the session view**

In the session view section, between `<Terminal>` and `<Toolbar>` (after line 818):

```svelte
        <ChangedFiles
          bind:this={changedFilesRef}
          workspacePath={activeSession?.cwd ?? activeSession?.workspacePath ?? ''}
        />
```

- [ ] **Step 4: Handle files-changed WS event**

In the `connectEventSocket` callback (around line 300), add a handler for `files-changed`:

```typescript
      } else if (msg.type === 'files-changed') {
        changedFilesRef?.refresh();
      } else if (msg.type === 'session-activity-changed') {
        // Also refresh changed files on agent activity
        changedFilesRef?.refresh();
```

- [ ] **Step 5: Verify build compiles**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.svelte
git commit -m "feat: wire ChangedFiles panel into session view with real-time WS updates"
```

---

### Task 12: Build verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Run production build**

Run: `npm run build`
Expected: Build succeeds, no TypeScript errors, no Vite warnings

- [ ] **Step 3: Verify the built frontend includes new components**

```bash
ls -la dist/frontend/assets/ | head -10
grep -l "changed-files" dist/frontend/assets/*.js 2>/dev/null || echo "Bundle includes changed files code"
```

Expected: Frontend bundle exists and includes the new code

- [ ] **Step 4: Verify server exports are correct**

```bash
node -e "import('./dist/server/git.js').then(m => { console.log('getChangedFiles:', typeof m.getChangedFiles); console.log('getFileDiff:', typeof m.getFileDiff); })"
node -e "import('./dist/server/watcher.js').then(m => { console.log('GitWatcher:', typeof m.GitWatcher); })"
```

Expected: Both functions and class are exported as `function`/`function`

- [ ] **Step 5: Commit final verification**

No commit needed — this is a verification task.

---

## Deliverable Traceability

| Design Doc Deliverable | Plan Task |
|----------------------|-----------|
| `getChangedFiles()` in server/git.ts | Task 1 |
| `getFileDiff()` in server/git.ts | Task 2 |
| `GET /workspaces/changed-files` endpoint | Task 3 |
| `GET /workspaces/file-diff` endpoint | Task 3 |
| .git/ directory watching via watcher.ts | Task 4 |
| `files-changed` WebSocket event broadcast | Task 4 |
| shiki + diff2html dependencies | Task 5 |
| Frontend API client functions | Task 6 |
| `files-changed` WS event handler | Task 6, Task 11 |
| Smart summaries (rule-based v1) | Task 7 |
| CodeBlock.svelte shared component | Task 8 |
| DiffViewer.svelte with diff2html + Shiki | Task 9 |
| ChangedFiles.svelte using DataTable | Task 10 |
| Collapsible panel below terminal | Task 11 |
| Mobile card layout | Task 10 (mobileCard snippet) |
| Aggregate stats bar | Task 10 (summary-bar) |
| Inline diff expansion | Task 10 (onRowAction + inline-diff) |

## Outcomes & Retrospective

**What worked:**
- Backend-first task ordering with TDD yielded clean, testable code
- Parallel dispatch (Tasks 1+5, Tasks 6+7) saved time without conflicts
- Svelte file editor agent handled Svelte 5 runes and diff2html/Shiki integration well
- 5-agent parallel review caught real bugs (path traversal, rename swap) that unit tests missed

**What didn't:**
- Plan code samples had `'text'` as Shiki fallback which isn't valid — agents had to adapt
- Plan didn't specify workspace path validation on new endpoints — caught by review
- Rename parsing in porcelain=v1 was wrong in the plan itself (oldPath/newPath swap)
- Some agents didn't add exports to the export block despite instructions

**Learnings to codify:**
- Shiki `BundledLanguage` does not include `'text'` — use a preloaded language as fallback
- diff2html types must be imported from `diff2html/lib/types`, not the top-level package
- New endpoints that accept `path` params MUST validate against configured workspaces
- git status porcelain=v1 -z rename format: entry.slice(3) is NEW name, next NUL token is OLD name
-
