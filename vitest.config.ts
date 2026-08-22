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
  'test/work-context-messages.test.ts',
  'test/worktree-cleanup.test.ts',
  'test/sessions.test.ts',
  // These files execute or rebuild the shared dist/bin/relay-ide.js output.
  // Keep every dist consumer in one lane so a build cannot replace modules
  // while another worker is importing the CLI.
  'test/browser-cli.test.ts',
  'test/cli-gateway-claude-tools.test.ts',
  'test/cli-gateway-codex-tools.test.ts',
  'test/cli-gateway-hermes-tools.test.ts',
  'test/cli-gateway-sessions-wait.test.ts',
  'test/cli-gateway-workflow.test.ts',
  'test/operator-client-cli.test.ts',
  'test/cli-gateway/channels-post.test.ts',
  'test/cli-gateway/events.test.ts',
  'test/hub-node-packaging.test.ts',
  'test/node-device-pair-cli.test.ts',
  'test/node-manifest-build.test.ts',
  'test/service.test.ts',
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
