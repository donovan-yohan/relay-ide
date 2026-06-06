import { defineConfig } from 'vitest/config';

// Files that spawn many real `git` / `tmux` subprocesses and race
// under default vitest file-parallelism — timeouts fire deterministically
// when many child processes contend for CPU. Routed to a project with
// `fileParallelism: false` so files in this group run one at a time;
// everything else stays in the parallel pool.
//
// Note: `testTimeout` does NOT inherit from the top-level `test` config
// into vitest 4 projects (verified empirically — removing it from
// projects let tests fail at exactly 5000ms, the vitest default).
// Re-declared on each project; keep them in sync.
const SERIAL_SUBPROCESS_FILES = [
  'test/git-divergence.test.ts',
  'test/git-watcher.test.ts',
  'test/workspace-divergence-api.test.ts',
  'test/worktree-cleanup.test.ts',
  'test/sessions.test.ts',
];

const PROJECT_TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'serial-subprocess',
          include: SERIAL_SUBPROCESS_FILES,
          testTimeout: PROJECT_TEST_TIMEOUT_MS,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'parallel',
          include: ['test/**/*.test.ts'],
          exclude: ['test/e2e/**', ...SERIAL_SUBPROCESS_FILES],
          testTimeout: PROJECT_TEST_TIMEOUT_MS,
        },
      },
    ],
  },
});
