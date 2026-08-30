// #1448 drift guard. The repo inventory memo is only as correct as its
// invalidation wiring, and that wiring lives inside `main()` in
// `server/index.ts` — a scope no unit test can reach. The unit tests in
// `repo-inventory-cache.test.ts` prove `invalidate()` behaves; this file proves
// it is actually CALLED from every mutation signal the hub observes.
//
// If you add a new hub-observed mutation that changes repo, branch, worktree,
// or upstream-ref state, add its handler here and wire the invalidation. If you
// intentionally decide a signal must NOT invalidate, delete its row and say why
// in the PR — a silent removal is what this guard exists to catch.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const INDEX_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'server',
  'index.ts'
);

const INVALIDATE_CALL = 'repoInventoryCache.invalidate();';

/**
 * Each row is a mutation signal and the anchor that opens its handler. The
 * guard asserts `invalidate()` appears inside the handler body — within
 * `windowLines` of the anchor, which is generous enough to survive comment and
 * formatting churn but tight enough that it cannot match a neighbouring call.
 */
const WIRED_MUTATION_SIGNALS: Array<{
  signal: string;
  anchor: string;
  windowLines: number;
}> = [
  {
    signal: 'branch change observed by the branch watcher (git checkout)',
    anchor: 'const branchWatcher = new BranchWatcher((cwdPath, newBranch) => {',
    windowLines: 20,
  },
  {
    signal: 'worktree add/remove observed by the worktree fs watcher',
    anchor: "watcher.on('worktrees-changed', () => {",
    windowLines: 4,
  },
  {
    signal: 'upstream ref moved (push/fetch) observed by the ref watcher',
    anchor: 'const refWatcher = new RefWatcher((cwdPath, branch) => {',
    windowLines: 8,
  },
  {
    signal: 'worktree created through the workspace router',
    anchor: 'onWorktreeCreated: () => {',
    windowLines: 4,
  },
  {
    signal: 'config.repos changed through the workspace router',
    anchor: 'onWorkspacesChanged: () => {',
    windowLines: 4,
  },
  {
    signal: 'worktree deleted through the worktree cleanup route',
    anchor: "// Broadcast worktrees-changed so all clients refresh",
    windowLines: 3,
  },
];

function lines(): string[] {
  return fs.readFileSync(INDEX_PATH, 'utf8').split('\n');
}

describe('repo inventory cache invalidation wiring (server/index.ts)', () => {
  const source = lines();

  it.each(WIRED_MUTATION_SIGNALS)(
    'invalidates on: $signal',
    ({ anchor, windowLines }) => {
      const anchorIndex = source.findIndex((line) => line.includes(anchor));
      expect(
        anchorIndex,
        `anchor not found in server/index.ts: ${anchor}`
      ).toBeGreaterThanOrEqual(0);

      const window = source
        .slice(anchorIndex, anchorIndex + windowLines + 1)
        .join('\n');
      expect(window).toContain(INVALIDATE_CALL);
    }
  );

  it('wires exactly the signals this guard knows about', () => {
    const callCount = source.filter((line) =>
      line.includes(INVALIDATE_CALL)
    ).length;
    expect(callCount).toBe(WIRED_MUTATION_SIGNALS.length);
  });
});
