# Code & File Tools Phase 3 — Full-Page Diff + Branch Comparison

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-page diff viewer with side-by-side mode, diff source toggling (working tree / staged / branch comparison), keyboard navigation, and large-diff performance optimizations to the session view.

**Architecture:** Extend the existing `DiffViewer.svelte` with side-by-side rendering and hunk navigation. Add a `DiffSourceToggle.svelte` component for switching between working tree, staged, and branch comparison modes. Create a `FullPageDiff.svelte` component that combines a narrow file sidebar (using `ChangedFiles.svelte` data) with the expanded diff viewer. Route via state-driven view toggling in `App.svelte` with URL query param support. Backend adds `getDefaultBranch()` to `server/git.ts` for branch comparison mode.

**Tech Stack:** TypeScript, Svelte 5 (runes), diff2html (JSON parse), Shiki (syntax highlighting), Express, git CLI

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-29 | State-driven view toggle (not SvelteKit router) | Follows existing App.svelte pattern — no router library in project |
| 2026-03-29 | Side-by-side as extension of DiffViewer (not new component) | Design doc says "extend with side-by-side mode" — same data pipeline, different layout |
| 2026-03-29 | Truncation at 5000 lines instead of intersection observer virtualization | Simpler, addresses immediate perf concern — virtualization deferred to future if needed |
| 2026-03-29 | Narrow file sidebar is a new `DiffFileSidebar.svelte` extracting list logic from ChangedFiles | ChangedFiles has too much panel/toggle state to cleanly reuse as a sidebar variant — cleaner to extract the file list rendering |

## Progress

- [x] Task 1: Default branch detection (backend + test) _(completed 2026-03-29)_
- [x] Task 2: Diff source toggle component _(completed 2026-03-29)_
- [x] Task 3: Wire diff source into ChangedFiles _(completed 2026-03-29)_
- [x] Task 4: Side-by-side diff rendering _(completed 2026-03-29)_
- [x] Task 5: Large diff truncation _(completed 2026-03-29)_
- [x] Task 6: Full-page diff view _(completed 2026-03-29)_
- [x] Task 7: URL routing + expand action _(completed 2026-03-29)_
- [x] Task 8: Keyboard navigation (j/k/n/p) _(completed 2026-03-29)_

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `server/git.ts` | Modify | Add `getDefaultBranch()` function |
| `server/workspaces.ts` | Modify | Add `GET /workspaces/default-branch` endpoint |
| `test/git-changed-files.test.ts` | Modify | Add tests for `getDefaultBranch()` |
| `test/changed-files-api.test.ts` | Modify | Add test for `/default-branch` endpoint |
| `frontend/src/lib/types.ts` | Modify | Add `DiffSource` type |
| `frontend/src/lib/api.ts` | Modify | Add `fetchDefaultBranch()` function |
| `frontend/src/components/DiffSourceToggle.svelte` | Create | Toggle between working/staged/branch diff sources |
| `frontend/src/components/ChangedFiles.svelte` | Modify | Integrate DiffSourceToggle, manage base state internally |
| `frontend/src/components/DiffViewer.svelte` | Modify | Add side-by-side mode, truncation, hunk markers, intersection observer |
| `frontend/src/components/DiffFileSidebar.svelte` | Create | Narrow file list for full-page diff view |
| `frontend/src/components/FullPageDiff.svelte` | Create | Full-page layout: sidebar + expanded diff viewer |
| `frontend/src/App.svelte` | Modify | Add full-page diff view routing, URL param handling, keyboard shortcuts |

---

## Task 1: Default Branch Detection (backend + test)

**Files:**
- Modify: `server/git.ts` (after `getFileDiff`, before export block ~line 904)
- Modify: `server/workspaces.ts` (after `/file-diff` endpoint ~line 1082)
- Modify: `test/git-changed-files.test.ts` (append new describe block)
- Modify: `test/changed-files-api.test.ts` (append new describe block)

- [ ] **Step 1: Write failing test for `getDefaultBranch`**

Add to the end of `test/git-changed-files.test.ts`:

```typescript
describe('getDefaultBranch', () => {
  it('returns default branch from symbolic-ref', async () => {
    const branch = await getDefaultBranch('/tmp/repo', async (_file, args) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    assert.equal(branch, 'main');
  });

  it('falls back to checking rev-parse for main then master', async () => {
    const branch = await getDefaultBranch('/tmp/repo', async (_file, args) => {
      if (args[0] === 'symbolic-ref') {
        throw new Error('not set');
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        if (args[2] === 'refs/heads/main') {
          throw new Error('not found');
        }
        if (args[2] === 'refs/heads/master') {
          return { stdout: 'abc123\n', stderr: '' };
        }
      }
      return { stdout: '', stderr: '' };
    });
    assert.equal(branch, 'master');
  });

  it('returns "main" as ultimate fallback', async () => {
    const branch = await getDefaultBranch('/tmp/repo', async () => {
      throw new Error('everything fails');
    });
    assert.equal(branch, 'main');
  });
});
```

Update the import at top of file to include `getDefaultBranch`:

```typescript
import { getChangedFiles, getFileDiff, getDefaultBranch } from '../server/git.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test --test-force-exit dist/test/git-changed-files.test.js`
Expected: FAIL — `getDefaultBranch` is not exported from `server/git.ts`

- [ ] **Step 3: Implement `getDefaultBranch` in `server/git.ts`**

Add after the `getFileDiff` function (before `const ONE_DAY_MS` at line 904):

```typescript
async function getDefaultBranch(
  repoPath: string,
  exec: ExecFileAsyncLike = execFileAsync as ExecFileAsyncLike,
): Promise<string> {
  // Try symbolic-ref first (most repos have this set)
  try {
    const { stdout } = await exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: repoPath, timeout: 5000 });
    const ref = stdout.trim();
    // "refs/remotes/origin/main" → "main"
    const prefix = 'refs/remotes/origin/';
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  } catch {
    // Not set — fall through to heuristic
  }

  // Check if main or master exists locally
  for (const candidate of ['main', 'master']) {
    try {
      await exec('git', ['rev-parse', '--verify', `refs/heads/${candidate}`], { cwd: repoPath, timeout: 5000 });
      return candidate;
    } catch {
      // Not found — try next
    }
  }

  return 'main'; // ultimate fallback
}
```

Add `getDefaultBranch` to the export block at the bottom of `server/git.ts`:

```typescript
export {
  // ... existing exports ...
  getDefaultBranch,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test --test-force-exit dist/test/git-changed-files.test.js`
Expected: All tests PASS including the 3 new `getDefaultBranch` tests

- [ ] **Step 5: Write failing test for `/default-branch` endpoint**

Add to the end of `test/changed-files-api.test.ts`:

```typescript
describe('GET /workspaces/default-branch', () => {
  test('returns default branch for a workspace', async () => {
    const res = await fetch(`${baseUrl}/workspaces/default-branch?path=${encodeURIComponent(repoDir)}`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(typeof data.branch, 'string');
    assert.ok(data.branch.length > 0);
  });

  test('returns 400 without path parameter', async () => {
    const res = await fetch(`${baseUrl}/workspaces/default-branch`);
    assert.equal(res.status, 400);
  });
});
```

- [ ] **Step 6: Implement `/default-branch` endpoint**

Add after the `/file-diff` route in `server/workspaces.ts` (~line 1082):

```typescript
  // GET /workspaces/default-branch — detect the default branch for a repo
  router.get('/default-branch', async (req: Request, res: Response) => {
    if (typeof req.query.path !== 'string') {
      res.status(400).json({ branch: '', error: 'path parameter required' });
      return;
    }

    const resolvedRepo = validateWorkspaceAccess(req.query.path);
    if (!resolvedRepo) {
      res.status(403).json({ branch: '', error: 'path not in configured workspaces' });
      return;
    }

    try {
      const branch = await getDefaultBranch(resolvedRepo, exec);
      res.json({ branch });
    } catch (err: unknown) {
      console.warn('[workspaces] /default-branch failed for', resolvedRepo, err instanceof Error ? err.message : String(err));
      res.status(500).json({ branch: 'main', error: 'Failed to detect default branch' });
    }
  });
```

Add `getDefaultBranch` to the import from `./git.js` at the top of `server/workspaces.ts`.

- [ ] **Step 7: Run all tests to verify**

Run: `npm run build && npm test`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add server/git.ts server/workspaces.ts test/git-changed-files.test.ts test/changed-files-api.test.ts
git commit -m "feat: add getDefaultBranch() + /default-branch endpoint for branch comparison"
```

---

## Task 2: Diff Source Toggle Component

**Files:**
- Modify: `frontend/src/lib/types.ts` (~line 289, after `FileDiffResponse`)
- Modify: `frontend/src/lib/api.ts` (after `fetchFileDiff` ~line 594)
- Create: `frontend/src/components/DiffSourceToggle.svelte`

- [ ] **Step 1: Add `DiffSource` type to `types.ts`**

Add after the `FileDiffResponse` interface at the end of `frontend/src/lib/types.ts`:

```typescript
export type DiffSource = 'working' | 'staged' | 'branch';
```

- [ ] **Step 2: Add `fetchDefaultBranch` to `api.ts`**

Add after `fetchFileDiff` in `frontend/src/lib/api.ts`:

```typescript
export async function fetchDefaultBranch(repoPath: string): Promise<string> {
  const params = new URLSearchParams({ path: repoPath });
  try {
    const res = await fetch('/workspaces/default-branch?' + params.toString());
    if (!res.ok) return 'main';
    const data = await res.json() as { branch: string };
    return data.branch || 'main';
  } catch {
    return 'main';
  }
}
```

- [ ] **Step 3: Create `DiffSourceToggle.svelte`**

Create `frontend/src/components/DiffSourceToggle.svelte`:

```svelte
<script lang="ts">
  import type { DiffSource } from '../lib/types.js';

  let {
    value = 'working',
    onchange,
    defaultBranch = 'main',
  }: {
    value?: DiffSource;
    onchange: (source: DiffSource) => void;
    defaultBranch?: string;
  } = $props();

  const options: { value: DiffSource; label: string }[] = [
    { value: 'working', label: 'working tree' },
    { value: 'staged', label: 'staged' },
    { value: 'branch', label: 'branch' },
  ];
</script>

<div class="diff-source-toggle" role="radiogroup" aria-label="diff source">
  {#each options as opt (opt.value)}
    <button
      class="toggle-option"
      class:active={value === opt.value}
      role="radio"
      aria-checked={value === opt.value}
      onclick={() => onchange(opt.value)}
    >
      {opt.value === 'branch' ? `vs ${defaultBranch}` : opt.label}
    </button>
  {/each}
</div>

<style>
  .diff-source-toggle {
    display: flex;
    gap: 0;
    border: 1px solid var(--border, #333);
  }

  .toggle-option {
    padding: 2px 8px;
    background: transparent;
    border: none;
    border-right: 1px solid var(--border, #333);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--text-muted, #888);
    cursor: pointer;
    white-space: nowrap;
  }

  .toggle-option:last-child {
    border-right: none;
  }

  .toggle-option:hover {
    background: var(--surface-hover, #141414);
    color: var(--text, #e0e0e0);
  }

  .toggle-option.active {
    color: var(--accent, #d97757);
    background: rgba(217, 119, 87, 0.08);
  }
</style>
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Build succeeds (warnings OK, no errors)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/types.ts frontend/src/lib/api.ts frontend/src/components/DiffSourceToggle.svelte
git commit -m "feat: add DiffSource type, fetchDefaultBranch API, DiffSourceToggle component"
```

---

## Task 3: Wire Diff Source into ChangedFiles

**Files:**
- Modify: `frontend/src/components/ChangedFiles.svelte`
- Modify: `frontend/src/App.svelte` (where ChangedFiles is mounted, ~line 891)

- [ ] **Step 1: Add diff source state and toggle to ChangedFiles**

In `frontend/src/components/ChangedFiles.svelte`, update the imports (line 1-7):

```svelte
<script lang="ts">
  import type { Column } from './DataTable.svelte';
  import DataTable from './DataTable.svelte';
  import DiffViewer from './DiffViewer.svelte';
  import DiffSourceToggle from './DiffSourceToggle.svelte';
  import { fetchChangedFiles, fetchFileDiff, fetchDefaultBranch } from '../lib/api.js';
  import { generateFileSummary } from '../lib/diff-summary.js';
  import type { ChangedFile, DiffSource } from '../lib/types.js';
```

Update the props to add `onExpandFile` callback and remove the `base` prop (line 9-15):

```typescript
  let {
    workspacePath,
    onExpandFile,
  }: {
    workspacePath: string;
    onExpandFile?: (file: ChangedFile, base: string | undefined) => void;
  } = $props();
```

Add diff source state after the existing state declarations (after line 29):

```typescript
  let diffSource = $state<DiffSource>('working');
  let defaultBranch = $state('main');

  // Compute the base param from diffSource
  let base = $derived(
    diffSource === 'staged' ? 'cached'
    : diffSource === 'branch' ? defaultBranch
    : undefined
  );
```

Add a `$effect` to fetch the default branch when workspacePath changes (after the existing `$effect` at line 87-91):

```typescript
  $effect(() => {
    if (workspacePath) {
      fetchDefaultBranch(workspacePath).then(b => { defaultBranch = b; });
    }
  });
```

- [ ] **Step 2: Add toggle and expand button to the template**

In the template, add the toggle inside the `.files-content` div, before the DataTable (after line 163 `<div class="files-content">`):

```svelte
    <div class="files-toolbar">
      <DiffSourceToggle
        value={diffSource}
        onchange={(s) => { diffSource = s; }}
        {defaultBranch}
      />
    </div>
```

Add an expand button to each file row. In the `{#snippet row(file, _index)}` block, add after the stat-del span (around line 186):

```svelte
            {#if onExpandFile}
              <button
                class="expand-btn"
                title="open full diff"
                onclick|stopPropagation={() => onExpandFile(file, base)}
                aria-label="expand diff for {file.path}"
              >[↗]</button>
            {/if}
```

- [ ] **Step 3: Add CSS for toolbar and expand button**

Add to the `<style>` block in `ChangedFiles.svelte`:

```css
  .files-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border, #333);
  }

  .expand-btn {
    flex-shrink: 0;
    padding: 0 4px;
    background: transparent;
    border: 1px solid var(--border, #333);
    color: var(--text-muted, #888);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    cursor: pointer;
  }

  .expand-btn:hover {
    color: var(--accent, #d97757);
    border-color: var(--accent, #d97757);
  }
```

- [ ] **Step 4: Update App.svelte to pass onExpandFile**

In `frontend/src/App.svelte`, where ChangedFiles is mounted (~line 891), update to pass the callback:

```svelte
<ChangedFiles
  bind:this={changedFilesRef}
  workspacePath={activeSession?.cwd ?? activeSession?.repoPath ?? ''}
  onExpandFile={handleExpandFile}
/>
```

Add a placeholder handler (we'll implement the full-page diff routing in Task 7):

In the `<script>` section of App.svelte, add after the existing function definitions:

```typescript
  function handleExpandFile(file: ChangedFile, base: string | undefined) {
    // Full-page diff routing — implemented in Task 7
    console.log('[App] expand file:', file.path, 'base:', base);
  }
```

Add the `ChangedFile` type import at the top of App.svelte (to the types import line):

```typescript
import type { ChangedFile } from './lib/types.js';
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ChangedFiles.svelte frontend/src/App.svelte
git commit -m "feat: wire diff source toggle into changed files panel with expand action"
```

---

## Task 4: Side-by-Side Diff Rendering

**Files:**
- Modify: `frontend/src/components/DiffViewer.svelte`

- [ ] **Step 1: Add mode prop and side-by-side types**

Replace the `<script>` section of `frontend/src/components/DiffViewer.svelte` entirely. The new script adds `mode` prop, a line-pairing algorithm for side-by-side, and hunk ID markers for keyboard navigation:

Update the props (lines 5-13):

```typescript
  let {
    diff,
    filePath,
    loading = false,
    mode = 'unified',
    onHunkCount,
  }: {
    diff: string;
    filePath: string;
    loading?: boolean;
    mode?: 'unified' | 'side-by-side';
    onHunkCount?: (count: number) => void;
  } = $props();
```

Add the `SideBySidePair` interface after the existing interfaces (~after line 28):

```typescript
  interface SideBySidePair {
    left: { number?: number; content: string; type: 'delete' | 'context' | 'empty'; tokens: ThemedToken[] | null };
    right: { number?: number; content: string; type: 'add' | 'context' | 'empty'; tokens: ThemedToken[] | null };
  }
```

- [ ] **Step 2: Add line-pairing function and paired lines state**

Add the pairing function after the `SideBySidePair` interface:

```typescript
  function pairLines(rawLines: RawLine[]): SideBySidePair[] {
    const pairs: SideBySidePair[] = [];
    let i = 0;
    while (i < rawLines.length) {
      const line = rawLines[i]!;
      if (line.type === 'context') {
        pairs.push({
          left: { number: line.oldNumber, content: line.content, type: 'context', tokens: null },
          right: { number: line.newNumber, content: line.content, type: 'context', tokens: null },
        });
        i++;
      } else {
        // Collect consecutive deletes then inserts
        const deletes: RawLine[] = [];
        const inserts: RawLine[] = [];
        while (i < rawLines.length && rawLines[i]!.type === 'delete') {
          deletes.push(rawLines[i]!);
          i++;
        }
        while (i < rawLines.length && rawLines[i]!.type === 'add') {
          inserts.push(rawLines[i]!);
          i++;
        }
        const max = Math.max(deletes.length, inserts.length);
        for (let j = 0; j < max; j++) {
          const del = deletes[j];
          const ins = inserts[j];
          pairs.push({
            left: del
              ? { number: del.oldNumber, content: del.content, type: 'delete', tokens: null }
              : { content: '', type: 'empty', tokens: null },
            right: ins
              ? { number: ins.newNumber, content: ins.content, type: 'add', tokens: null }
              : { content: '', type: 'empty', tokens: null },
          });
        }
      }
    }
    return pairs;
  }
```

Add paired lines state after the existing `lines` state (after line 66):

```typescript
  let pairedLines = $state<SideBySidePair[]>([]);
```

- [ ] **Step 3: Update the $effect to compute paired lines and apply tokens**

Replace the existing `$effect` block (lines 68-88) with:

```typescript
  $effect(() => {
    const { rawLines, hunkHeaderMap, lang } = parsed;
    const gen = ++tokenGeneration;

    // Immediately render without syntax highlighting
    lines = rawLines.map(l => ({ ...l, tokens: null }));
    pairedLines = pairLines(rawLines);

    // Report hunk count for keyboard nav
    if (onHunkCount) onHunkCount(hunkHeaderMap.size);

    if (rawLines.length === 0) return;

    // Asynchronously apply Shiki tokens
    const codeStr = rawLines.map(l => l.content).join('\n');
    tokenizeCode(codeStr, lang).then((tokenLines) => {
      if (gen !== tokenGeneration) return;
      lines = rawLines.map((line, i) => ({
        ...line,
        tokens: tokenLines[i] ?? null,
      }));
      // Apply tokens to paired lines
      pairedLines = pairLines(rawLines).map((pair, pairIdx) => {
        // Find the original line indices for token lookup
        // Context and delete lines map to left tokens, add lines map to right tokens
        return pair;
      });
      // Simpler approach: rebuild paired lines from the now-tokenized rawLines
      const tokenized = rawLines.map((line, i) => ({
        ...line,
        tokens: tokenLines[i] ?? null,
      }));
      const newPairs = pairLines(rawLines);
      // Apply tokens by matching content
      const tokenMap = new Map<string, ThemedToken[]>();
      for (const tl of tokenized) {
        if (tl.tokens) tokenMap.set(`${tl.type}:${tl.oldNumber ?? ''}:${tl.newNumber ?? ''}:${tl.content}`, tl.tokens);
      }
      for (const pair of newPairs) {
        const lKey = `${pair.left.type === 'context' ? 'context' : 'delete'}:${pair.left.number ?? ''}:${pair.left.type === 'context' ? pair.left.number : ''}:${pair.left.content}`;
        const rKey = `${pair.right.type === 'context' ? 'context' : 'add'}::${pair.right.number ?? ''}:${pair.right.content}`;
        pair.left.tokens = tokenMap.get(lKey) ?? null;
        pair.right.tokens = tokenMap.get(rKey) ?? null;
      }
      pairedLines = newPairs;
    }).catch((err: unknown) => {
      console.warn('[DiffViewer] Shiki tokenization failed:', err);
    });
  });
```

**Note:** The token mapping above is complex. A cleaner approach: index tokens by line index in the raw array, then when building pairs, track which raw line index each pair side came from.

**Revised approach — replace the $effect with this cleaner version:**

```typescript
  $effect(() => {
    const { rawLines, hunkHeaderMap, lang } = parsed;
    const gen = ++tokenGeneration;

    // Immediately render without syntax highlighting
    const plain = rawLines.map(l => ({ ...l, tokens: null as ThemedToken[] | null }));
    lines = plain;
    pairedLines = buildPairs(plain);

    if (onHunkCount) onHunkCount(hunkHeaderMap.size);
    if (rawLines.length === 0) return;

    const codeStr = rawLines.map(l => l.content).join('\n');
    tokenizeCode(codeStr, lang).then((tokenLines) => {
      if (gen !== tokenGeneration) return;
      const highlighted = rawLines.map((line, i) => ({
        ...line,
        tokens: tokenLines[i] ?? null,
      }));
      lines = highlighted;
      pairedLines = buildPairs(highlighted);
    }).catch((err: unknown) => {
      console.warn('[DiffViewer] Shiki tokenization failed:', err);
    });
  });
```

And refactor `pairLines` to `buildPairs` which accepts `HighlightedLine[]`:

```typescript
  function buildPairs(hlines: HighlightedLine[]): SideBySidePair[] {
    const pairs: SideBySidePair[] = [];
    let i = 0;
    while (i < hlines.length) {
      const line = hlines[i]!;
      if (line.type === 'context') {
        pairs.push({
          left: { number: line.oldNumber, content: line.content, type: 'context', tokens: line.tokens },
          right: { number: line.newNumber, content: line.content, type: 'context', tokens: line.tokens },
        });
        i++;
      } else {
        const deletes: HighlightedLine[] = [];
        const inserts: HighlightedLine[] = [];
        while (i < hlines.length && hlines[i]!.type === 'delete') {
          deletes.push(hlines[i]!);
          i++;
        }
        while (i < hlines.length && hlines[i]!.type === 'add') {
          inserts.push(hlines[i]!);
          i++;
        }
        const max = Math.max(deletes.length, inserts.length);
        for (let j = 0; j < max; j++) {
          const del = deletes[j];
          const ins = inserts[j];
          pairs.push({
            left: del
              ? { number: del.oldNumber, content: del.content, type: 'delete', tokens: del.tokens }
              : { content: '', type: 'empty', tokens: null },
            right: ins
              ? { number: ins.newNumber, content: ins.content, type: 'add', tokens: ins.tokens }
              : { content: '', type: 'empty', tokens: null },
          });
        }
      }
    }
    return pairs;
  }
```

- [ ] **Step 4: Add side-by-side template**

In the template section, after the existing `{:else}` block with `.diff-content` (around line 97-114), wrap the existing unified template in a mode check and add the side-by-side variant:

Replace the `{:else}` block (the one containing `.diff-content`) with:

```svelte
  {:else if mode === 'side-by-side'}
    <div class="diff-content-sbs">
      {#each pairedLines as pair, i (i)}
        <div class="sbs-row">
          <div class="sbs-half {pair.left.type}">
            <span class="line-number">{pair.left.number ?? ''}</span>
            <span class="line-prefix">{pair.left.type === 'delete' ? '-' : pair.left.type === 'context' ? ' ' : ''}</span>
            <span class="line-content">{#if pair.left.tokens}{#each pair.left.tokens as token, j (j)}<span style="color: {token.color ?? '#e0e0e0'}">{token.content}</span>{/each}{:else}{pair.left.content}{/if}</span>
          </div>
          <div class="sbs-half {pair.right.type}">
            <span class="line-number">{pair.right.number ?? ''}</span>
            <span class="line-prefix">{pair.right.type === 'add' ? '+' : pair.right.type === 'context' ? ' ' : ''}</span>
            <span class="line-content">{#if pair.right.tokens}{#each pair.right.tokens as token, j (j)}<span style="color: {token.color ?? '#e0e0e0'}">{token.content}</span>{/each}{:else}{pair.right.content}{/if}</span>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="diff-content">
      {#each lines as line, i (i)}
        {#if parsed.hunkHeaderMap.has(i)}
          <div class="hunk-header" id="hunk-{i}">{parsed.hunkHeaderMap.get(i) ?? ''}</div>
        {/if}
        <div
          class="diff-line {line.type}"
          data-old={line.oldNumber ?? ''}
          data-new={line.newNumber ?? ''}
        >
          <span class="line-number old">{line.oldNumber ?? ''}</span>
          <span class="line-number new">{line.newNumber ?? ''}</span>
          <span class="line-prefix">{line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '}</span>
          <span class="line-content">{#if line.tokens}{#each line.tokens as token, j (j)}<span style="color: {token.color ?? '#e0e0e0'}">{token.content}</span>{/each}{:else}{line.content}{/if}</span>
        </div>
      {/each}
    </div>
  {/if}
```

Note: Add `id="hunk-{i}"` to existing hunk headers for keyboard nav (Task 8).

- [ ] **Step 5: Add side-by-side CSS**

Add to the `<style>` block in `DiffViewer.svelte`:

```css
  .diff-content-sbs {
    min-width: max-content;
  }

  .sbs-row {
    display: flex;
  }

  .sbs-half {
    flex: 1;
    display: flex;
    white-space: pre;
    min-height: 1.5em;
    overflow: hidden;
  }

  .sbs-half + .sbs-half {
    border-left: 1px solid var(--border, #333);
  }

  .sbs-half.add {
    background: rgba(74, 222, 128, 0.08);
  }

  .sbs-half.add .line-content,
  .sbs-half.add .line-prefix {
    color: var(--status-success, #4ade80);
  }

  .sbs-half.delete {
    background: rgba(248, 113, 113, 0.08);
  }

  .sbs-half.delete .line-content,
  .sbs-half.delete .line-prefix {
    color: var(--status-error, #f87171);
  }

  .sbs-half.empty {
    background: rgba(136, 136, 136, 0.03);
  }

  .sbs-half .line-number {
    display: inline-block;
    width: 3em;
    text-align: right;
    padding-right: 0.5em;
    color: #888888;
    user-select: none;
    flex-shrink: 0;
  }

  .sbs-half .line-prefix {
    display: inline-block;
    width: 1.5em;
    text-align: center;
    user-select: none;
    flex-shrink: 0;
  }

  .sbs-half .line-content {
    flex: 1;
    padding-right: 0.5em;
  }
```

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/DiffViewer.svelte
git commit -m "feat: add side-by-side diff mode with line-pairing algorithm"
```

---

## Task 5: Large Diff Truncation

**Files:**
- Modify: `frontend/src/components/DiffViewer.svelte`

- [ ] **Step 1: Add truncation state and logic**

In `DiffViewer.svelte`, add after the existing state variables:

```typescript
  const TRUNCATION_LIMIT = 5000;
  let showAll = $state(false);

  let displayLines = $derived(
    !showAll && lines.length > TRUNCATION_LIMIT
      ? lines.slice(0, TRUNCATION_LIMIT)
      : lines
  );

  let displayPairs = $derived(
    !showAll && pairedLines.length > TRUNCATION_LIMIT
      ? pairedLines.slice(0, TRUNCATION_LIMIT)
      : pairedLines
  );

  let isTruncated = $derived(
    !showAll && (lines.length > TRUNCATION_LIMIT || pairedLines.length > TRUNCATION_LIMIT)
  );
```

- [ ] **Step 2: Update template to use display arrays and add "show more" button**

In the template, replace references to `lines` with `displayLines` and `pairedLines` with `displayPairs`.

In the unified mode block, replace `{#each lines as line, i (i)}` with `{#each displayLines as line, i (i)}`.

In the side-by-side block, replace `{#each pairedLines as pair, i (i)}` with `{#each displayPairs as pair, i (i)}`.

After both the side-by-side and unified content blocks (just before the closing `{/if}` of the main conditional), add the truncation notice:

```svelte
    {#if isTruncated}
      <div class="truncation-notice">
        <span>showing {TRUNCATION_LIMIT} of {mode === 'side-by-side' ? pairedLines.length : lines.length} lines</span>
        <button class="show-more-btn" onclick={() => { showAll = true; }}>[show all]</button>
      </div>
    {/if}
```

- [ ] **Step 3: Add truncation CSS**

Add to the `<style>` block:

```css
  .truncation-notice {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid var(--border, #333);
    color: var(--text-muted, #888);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
  }

  .show-more-btn {
    background: transparent;
    border: 1px solid var(--border, #333);
    color: var(--accent, #d97757);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    cursor: pointer;
    padding: 1px 6px;
  }

  .show-more-btn:hover {
    background: rgba(217, 119, 87, 0.08);
  }
```

- [ ] **Step 4: Reset truncation state when diff changes**

In the `$effect` block where `lines` and `pairedLines` are set, add `showAll = false;` at the top (right after `const gen = ++tokenGeneration;`):

```typescript
    showAll = false;
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/DiffViewer.svelte
git commit -m "feat: truncate large diffs at 5000 lines with show-more button"
```

---

## Task 6: Full-Page Diff View

**Files:**
- Create: `frontend/src/components/DiffFileSidebar.svelte`
- Create: `frontend/src/components/FullPageDiff.svelte`

- [ ] **Step 1: Create `DiffFileSidebar.svelte`**

This is a narrow file list for the sidebar. Extracted from `ChangedFiles.svelte` data patterns but purpose-built for the full-page diff layout.

Create `frontend/src/components/DiffFileSidebar.svelte`:

```svelte
<script lang="ts">
  import type { ChangedFile } from '../lib/types.js';

  let {
    files,
    activeFile,
    onSelectFile,
  }: {
    files: ChangedFile[];
    activeFile: string | null;
    onSelectFile: (file: ChangedFile) => void;
  } = $props();

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

  function fileName(filePath: string): string {
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? filePath : filePath.slice(idx + 1);
  }

  function fileDir(filePath: string): string {
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? '' : filePath.slice(0, idx);
  }

  let focusedIndex = $state(0);

  export function moveFocus(delta: number) {
    focusedIndex = Math.max(0, Math.min(files.length - 1, focusedIndex + delta));
    const file = files[focusedIndex];
    if (file) onSelectFile(file);
  }

  export function getFocusedIndex(): number {
    return focusedIndex;
  }

  $effect(() => {
    if (activeFile) {
      const idx = files.findIndex(f => f.path === activeFile);
      if (idx >= 0) focusedIndex = idx;
    }
  });
</script>

<div class="diff-sidebar" role="listbox" aria-label="changed files">
  {#each files as file, i (file.path)}
    <button
      class="sidebar-file"
      class:active={activeFile === file.path}
      class:focused={focusedIndex === i}
      role="option"
      aria-selected={activeFile === file.path}
      data-file-index={i}
      onclick={() => { focusedIndex = i; onSelectFile(file); }}
    >
      <span class="status" style="color: {statusColor[file.status] ?? 'var(--text-muted)'}">{statusIcon[file.status] ?? '?'}</span>
      <span class="name" title={file.path}>
        {fileName(file.path)}
        {#if fileDir(file.path)}
          <span class="dir">{fileDir(file.path)}/</span>
        {/if}
      </span>
      <span class="stats">
        <span class="stat-add">+{file.additions}</span>
        <span class="stat-del">-{file.deletions}</span>
      </span>
    </button>
  {/each}
</div>

<style>
  .diff-sidebar {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    border-right: 1px solid var(--border, #333);
    min-width: 200px;
    max-width: 280px;
  }

  .sidebar-file {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-muted, #222);
    cursor: pointer;
    text-align: left;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--text, #e0e0e0);
    min-height: 28px;
  }

  .sidebar-file:hover {
    background: var(--surface-hover, #141414);
  }

  .sidebar-file.active {
    background: rgba(217, 119, 87, 0.08);
    border-left: 2px solid var(--accent, #d97757);
  }

  .sidebar-file.focused {
    outline: 1px solid var(--accent, #d97757);
    outline-offset: -1px;
  }

  .status {
    flex-shrink: 0;
    width: 12px;
    text-align: center;
    font-weight: bold;
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dir {
    color: var(--text-muted, #888);
    font-size: 0.7rem;
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .stats {
    flex-shrink: 0;
    display: flex;
    gap: 4px;
    font-size: 0.65rem;
  }

  .stat-add { color: var(--status-success, #4ade80); }
  .stat-del { color: var(--status-error, #f87171); }
</style>
```

- [ ] **Step 2: Create `FullPageDiff.svelte`**

Create `frontend/src/components/FullPageDiff.svelte`:

```svelte
<script lang="ts">
  import DiffViewer from './DiffViewer.svelte';
  import DiffFileSidebar from './DiffFileSidebar.svelte';
  import DiffSourceToggle from './DiffSourceToggle.svelte';
  import { fetchChangedFiles, fetchFileDiff, fetchDefaultBranch } from '../lib/api.js';
  import { generateFileSummary } from '../lib/diff-summary.js';
  import type { ChangedFile, DiffSource } from '../lib/types.js';

  let {
    workspacePath,
    initialFile,
    initialBase,
    onClose,
  }: {
    workspacePath: string;
    initialFile?: string;
    initialBase?: string;
    onClose: () => void;
  } = $props();

  let files = $state<ChangedFile[]>([]);
  let loading = $state(true);
  let activeFilePath = $state<string | null>(initialFile ?? null);
  let fileDiff = $state('');
  let diffLoading = $state(false);
  let diffSource = $state<DiffSource>(
    initialBase === 'cached' ? 'staged'
    : initialBase ? 'branch'
    : 'working'
  );
  let defaultBranch = $state(initialBase && initialBase !== 'cached' ? initialBase : 'main');
  let diffMode = $state<'unified' | 'side-by-side'>('unified');
  let sidebarRef = $state<DiffFileSidebar | undefined>(undefined);
  let hunkCount = $state(0);
  let summary = $state('');

  let base = $derived(
    diffSource === 'staged' ? 'cached'
    : diffSource === 'branch' ? defaultBranch
    : undefined
  );

  async function loadFiles() {
    loading = true;
    try {
      const data = await fetchChangedFiles(workspacePath, base);
      files = data.files;
      // If no active file, select the first one
      if (!activeFilePath && files.length > 0) {
        activeFilePath = files[0]!.path;
      }
    } catch {
      files = [];
    } finally {
      loading = false;
    }
  }

  async function loadDiff(filePath: string) {
    diffLoading = true;
    summary = '';
    try {
      const data = await fetchFileDiff(workspacePath, filePath, base);
      fileDiff = data.diff;
      const file = files.find(f => f.path === filePath);
      if (file && fileDiff) {
        summary = generateFileSummary(fileDiff, filePath, file.status);
      }
    } catch {
      fileDiff = '';
    } finally {
      diffLoading = false;
    }
  }

  function handleSelectFile(file: ChangedFile) {
    activeFilePath = file.path;
  }

  // Load files on mount and when diff source changes
  $effect(() => {
    void base;
    loadFiles();
  });

  // Load diff when active file changes
  $effect(() => {
    if (activeFilePath) {
      loadDiff(activeFilePath);
    }
  });

  // Fetch default branch
  $effect(() => {
    if (workspacePath) {
      fetchDefaultBranch(workspacePath).then(b => { defaultBranch = b; });
    }
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'j') {
      e.preventDefault();
      sidebarRef?.moveFocus(1);
    } else if (e.key === 'k') {
      e.preventDefault();
      sidebarRef?.moveFocus(-1);
    } else if (e.key === 'n') {
      e.preventDefault();
      scrollToHunk(1);
    } else if (e.key === 'p') {
      e.preventDefault();
      scrollToHunk(-1);
    }
  }

  let currentHunkIndex = $state(-1);

  function scrollToHunk(delta: number) {
    const target = currentHunkIndex + delta;
    if (target < 0 || target >= hunkCount) return;
    currentHunkIndex = target;
    // Find the hunk element by id
    const el = document.getElementById(`hunk-${getHunkLineIndex(target)}`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // Build hunk index → line index map from the current diff
  function getHunkLineIndex(hunkIdx: number): number {
    // The hunk headers are identified by their index in the lines array
    // We need to collect them from parsed.hunkHeaderMap
    let count = 0;
    // We can't directly access DiffViewer's parsed state from here,
    // so we search the DOM for hunk headers
    const hunks = document.querySelectorAll('.hunk-header[id^="hunk-"]');
    if (hunkIdx < hunks.length) {
      const id = hunks[hunkIdx]?.id;
      if (id) return parseInt(id.replace('hunk-', ''), 10);
    }
    return 0;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="full-page-diff">
  <div class="fpd-header">
    <button class="close-btn" onclick={onClose} aria-label="close diff view">[x] close</button>
    <span class="fpd-title">
      {#if activeFilePath}
        {activeFilePath}
        {#if summary}
          <span class="fpd-summary">— {summary}</span>
        {/if}
      {:else}
        diff view
      {/if}
    </span>
    <div class="fpd-controls">
      <DiffSourceToggle value={diffSource} onchange={(s) => { diffSource = s; }} {defaultBranch} />
      <button
        class="mode-toggle"
        onclick={() => { diffMode = diffMode === 'unified' ? 'side-by-side' : 'unified'; }}
        title="toggle unified/side-by-side"
      >
        {diffMode === 'unified' ? '[split]' : '[unified]'}
      </button>
    </div>
  </div>

  <div class="fpd-body">
    <DiffFileSidebar
      bind:this={sidebarRef}
      {files}
      activeFile={activeFilePath}
      onSelectFile={handleSelectFile}
    />
    <div class="fpd-main">
      {#if activeFilePath}
        <DiffViewer
          diff={fileDiff}
          filePath={activeFilePath}
          loading={diffLoading}
          mode={diffMode}
          onHunkCount={(c) => { hunkCount = c; currentHunkIndex = -1; }}
        />
      {:else if loading}
        <div class="fpd-empty">loading files...</div>
      {:else}
        <div class="fpd-empty">no files changed</div>
      {/if}
    </div>
  </div>

  <div class="fpd-footer">
    <span class="hint">j/k navigate files</span>
    <span class="hint">n/p jump hunks</span>
    <span class="hint">esc close</span>
  </div>
</div>

<style>
  .full-page-diff {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg, #000);
    color: var(--text, #e0e0e0);
    font-family: var(--font-mono, monospace);
  }

  .fpd-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border, #333);
    flex-shrink: 0;
  }

  .close-btn {
    background: transparent;
    border: 1px solid var(--border, #333);
    color: var(--text-muted, #888);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    cursor: pointer;
    padding: 2px 8px;
  }

  .close-btn:hover {
    color: var(--status-error, #f87171);
    border-color: var(--status-error, #f87171);
  }

  .fpd-title {
    flex: 1;
    font-size: var(--font-size-sm, 0.85rem);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fpd-summary {
    color: var(--text-muted, #888);
    font-size: var(--font-size-xs, 0.75rem);
  }

  .fpd-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .mode-toggle {
    background: transparent;
    border: 1px solid var(--border, #333);
    color: var(--text-muted, #888);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    cursor: pointer;
    padding: 2px 8px;
  }

  .mode-toggle:hover {
    color: var(--accent, #d97757);
    border-color: var(--accent, #d97757);
  }

  .fpd-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .fpd-main {
    flex: 1;
    overflow: auto;
    min-width: 0;
  }

  .fpd-main :global(.diff-viewer) {
    max-height: none;
    border: none;
  }

  .fpd-empty {
    padding: 24px;
    color: var(--text-muted, #888);
    text-align: center;
  }

  .fpd-footer {
    display: flex;
    gap: 16px;
    padding: 4px 12px;
    border-top: 1px solid var(--border, #333);
    flex-shrink: 0;
  }

  .hint {
    font-size: 0.65rem;
    color: var(--text-muted, #888);
  }

  @media (max-width: 600px) {
    .fpd-body {
      flex-direction: column;
    }

    .fpd-body :global(.diff-sidebar) {
      max-width: none;
      min-width: 0;
      max-height: 120px;
      border-right: none;
      border-bottom: 1px solid var(--border, #333);
    }
  }
</style>
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/DiffFileSidebar.svelte frontend/src/components/FullPageDiff.svelte
git commit -m "feat: add full-page diff view with file sidebar and mode toggle"
```

---

## Task 7: URL Routing + Expand Action

**Files:**
- Modify: `frontend/src/App.svelte`
- Modify: `frontend/src/lib/state/ui.svelte.ts`

- [ ] **Step 1: Add full-page diff state to UI store**

In `frontend/src/lib/state/ui.svelte.ts`, add after the `terminalFontSize` state (after line 50):

```typescript
let fullPageDiff = $state<{
  workspacePath: string;
  file?: string;
  base?: string;
} | null>(null);
```

Add to the `getUi()` return object (inside the function, after the `terminalFontSize` getter/setter):

```typescript
    get fullPageDiff() { return fullPageDiff; },
    set fullPageDiff(v: typeof fullPageDiff) { fullPageDiff = v; },
```

- [ ] **Step 2: Add URL param parsing for diff view in App.svelte**

In `frontend/src/App.svelte`, find the existing URL param handling (look for `URLSearchParams` or `window.location.search`). Add diff view URL parsing after session URL param handling:

In the script section where URL params are parsed (around the `$effect` that checks for `?session=`), add:

```typescript
  // Parse ?view=diff URL params
  $effect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'diff') {
      const path = params.get('path');
      if (path) {
        ui.fullPageDiff = {
          workspacePath: path,
          file: params.get('file') ?? undefined,
          base: params.get('base') ?? undefined,
        };
      }
      // Clean up URL
      const url = new URL(window.location.href);
      url.searchParams.delete('view');
      url.searchParams.delete('path');
      url.searchParams.delete('file');
      url.searchParams.delete('base');
      window.history.replaceState({}, '', url.toString());
    }
  });
```

- [ ] **Step 3: Wire handleExpandFile to open full-page diff**

Replace the placeholder `handleExpandFile` function added in Task 3:

```typescript
  function handleExpandFile(file: ChangedFile, base: string | undefined) {
    const workspacePath = activeSession?.cwd ?? activeSession?.repoPath ?? '';
    if (!workspacePath) return;
    ui.fullPageDiff = { workspacePath, file: file.path, base };
  }
```

- [ ] **Step 4: Add FullPageDiff rendering in App.svelte template**

Import `FullPageDiff` at the top of App.svelte:

```typescript
import FullPageDiff from './components/FullPageDiff.svelte';
```

In the template, add a conditional render that overlays the full-page diff when active. Add it right before the closing tag of the main layout container (so it overlays the session view):

```svelte
{#if ui.fullPageDiff}
  <div class="full-page-diff-overlay">
    <FullPageDiff
      workspacePath={ui.fullPageDiff.workspacePath}
      initialFile={ui.fullPageDiff.file}
      initialBase={ui.fullPageDiff.base}
      onClose={() => { ui.fullPageDiff = null; }}
    />
  </div>
{/if}
```

Add the overlay CSS to the App.svelte `<style>` block:

```css
  .full-page-diff-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: var(--bg, #000);
  }
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.svelte frontend/src/lib/state/ui.svelte.ts
git commit -m "feat: route full-page diff view with URL param support and expand action"
```

---

## Task 8: Keyboard Navigation (j/k/n/p)

**Files:**
- Modify: `frontend/src/App.svelte` (global keyboard handler)
- Modify: `frontend/src/lib/actions/registry.svelte.ts` or the action registration in App.svelte

The keyboard shortcuts (j/k for files, n/p for hunks, Esc to close) are already handled in `FullPageDiff.svelte` via `svelte:window onkeydown`. This task registers them as actions in the ActionRegistry for discoverability via the command palette.

- [ ] **Step 1: Register diff actions in App.svelte**

In the action registration section of App.svelte (where `registerGlobal` calls are made, ~lines 114-150), add:

```typescript
    registerGlobal({
      id: 'workspace.open-diff-view',
      label: 'open diff view',
      description: 'open full-page diff viewer for changed files',
      category: 'workspace',
      shortcut: { key: 'd' },
      when: (ctx) => ctx.view === 'session',
      handler: () => {
        const ws = activeSession?.cwd ?? activeSession?.repoPath ?? '';
        if (ws) ui.fullPageDiff = { workspacePath: ws };
      },
    });

    registerGlobal({
      id: 'workspace.close-diff-view',
      label: 'close diff view',
      description: 'close full-page diff viewer',
      category: 'workspace',
      shortcut: { key: 'Escape' },
      when: () => !!ui.fullPageDiff,
      handler: () => { ui.fullPageDiff = null; },
    });
```

- [ ] **Step 2: Prevent j/k/n/p from triggering in input fields**

In `FullPageDiff.svelte`, update the `handleKeydown` function to skip when typing in an input:

```typescript
  function handleKeydown(e: KeyboardEvent) {
    // Don't capture when typing in inputs
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'j') {
      e.preventDefault();
      sidebarRef?.moveFocus(1);
    } else if (e.key === 'k') {
      e.preventDefault();
      sidebarRef?.moveFocus(-1);
    } else if (e.key === 'n') {
      e.preventDefault();
      scrollToHunk(1);
    } else if (e.key === 'p') {
      e.preventDefault();
      scrollToHunk(-1);
    }
  }
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass (including new Task 1 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.svelte frontend/src/components/FullPageDiff.svelte
git commit -m "feat: register diff keyboard shortcuts in action registry"
```

---

## Surprises & Discoveries

| Date | What | Plan Impact | Action Taken |
|------|------|-------------|--------------|
| 2026-03-29 | `exactOptionalPropertyTypes` requires conditional spread for optional interface properties | Minor — affects SideBySidePair and FullPageDiff prop passing | Used conditional spread `...(val !== undefined ? { prop: val } : {})` |
| 2026-03-29 | Side-by-side mode was missing hunk headers entirely | Important — hunk headers only existed in unified template | Added `hunkHeader` field to SideBySidePair, emitted from buildPairs using hunkHeaderMap |
| 2026-03-29 | FullPageDiff loadDiff effect didn't track `base` dependency | Important — switching diff source showed stale diff | Added `void base` to the $effect for loadDiff |

## Plan Drift

| Task | Plan Said | Actually Happened | Why |
|------|-----------|-------------------|-----|
| Task 4 | Single `SideBySidePair` interface with inline types | Split into `SbsHalfLeft` + `SbsHalfRight` + `SideBySidePair` | Better type safety — left side can never be 'add', right can never be 'delete' |
| Task 4 | `pairLines(rawLines)` function | `buildPairs(hlines, hunkHeaders?)` with hunk header support | Needed hunk headers in side-by-side mode, discovered during code review |
| Overall | Intersection observer virtualization planned | Truncation at 5000 lines shipped instead | Simpler, sufficient for immediate needs — virtualization deferred |
