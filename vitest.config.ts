import { defineConfig } from 'vitest/config';

// Files that spawn many real `git` / `tmux` subprocesses and race
// under default vitest file-parallelism — timeouts fire deterministically
// when many child processes contend for CPU. Pinned to a singleFork
// project so they run sequentially regardless of how many other test
// files are in flight; everything else stays parallel.
const SERIAL_SUBPROCESS_FILES = [
  'test/git-divergence.test.ts',
  'test/git-watcher.test.ts',
  'test/workspace-divergence-api.test.ts',
  'test/sessions.test.ts',
];

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    projects: [
      {
        test: {
          name: 'serial-subprocess',
          include: SERIAL_SUBPROCESS_FILES,
          environment: 'node',
          testTimeout: 30_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'parallel',
          include: ['test/**/*.test.ts'],
          exclude: ['test/e2e/**', ...SERIAL_SUBPROCESS_FILES],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
    ],
  },
});
