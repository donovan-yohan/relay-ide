import {
  fixtureSanitization,
  makeFixtureSession,
  SANITIZED_FIXTURE_LINE_COUNT,
  SANITIZED_FIXTURE_PATH,
  sanitizedLargeDiff,
  type SanitizedAgentDetailFixture,
} from './types.js';

const thoughtContent =
  'Codex synthetic thought: verify the reducer contract before applying the patch.';
const commandOutput =
  'export const syntheticCodexValue = {\n  ready: true,\n};';
const patch = sanitizedLargeDiff();

const fixture = {
  schemaVersion: 1,
  provider: 'codex',
  sanitization: fixtureSanitization(),
  nativeEvents: [
    {
      method: 'item/started',
      params: {
        threadId: 'thread_synthetic_codex',
        turnId: 'turn_synthetic_codex',
        startedAtMs: 1_000,
        item: {
          type: 'reasoning',
          id: 'reason_synthetic_codex',
          summary: [],
          content: [],
        },
      },
    },
    {
      method: 'item/reasoning/summaryPartAdded',
      params: {
        threadId: 'thread_synthetic_codex',
        turnId: 'turn_synthetic_codex',
        itemId: 'reason_synthetic_codex',
        summaryIndex: 0,
      },
    },
    {
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: 'thread_synthetic_codex',
        turnId: 'turn_synthetic_codex',
        itemId: 'reason_synthetic_codex',
        delta: thoughtContent,
        summaryIndex: 0,
      },
    },
    {
      method: 'item/completed',
      params: {
        threadId: 'thread_synthetic_codex',
        turnId: 'turn_synthetic_codex',
        completedAtMs: 2_000,
        item: {
          type: 'reasoning',
          id: 'reason_synthetic_codex',
          summary: [thoughtContent],
          content: [],
        },
      },
    },
    {
      method: 'item/started',
      params: {
        item: {
          type: 'commandExecution',
          id: 'command_synthetic_codex',
          command: 'node scripts/synthetic-check.mjs',
          cwd: '/workspace/example',
        },
      },
    },
    {
      method: 'item/commandExecution/outputDelta',
      params: { itemId: 'command_synthetic_codex', delta: commandOutput },
    },
    {
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'command_synthetic_codex',
          command: 'node scripts/synthetic-check.mjs',
          cwd: '/workspace/example',
          aggregatedOutput: commandOutput,
          exitCode: 0,
        },
      },
    },
    {
      method: 'item/started',
      params: {
        item: {
          type: 'fileChange',
          id: 'file_synthetic_codex',
          changes: [
            {
              path: SANITIZED_FIXTURE_PATH,
              kind: { type: 'update' },
              diff: '',
            },
          ],
        },
      },
    },
    {
      method: 'item/fileChange/patchUpdated',
      params: {
        itemId: 'file_synthetic_codex',
        changes: [
          {
            path: SANITIZED_FIXTURE_PATH,
            kind: { type: 'update' },
            diff: patch,
          },
        ],
      },
    },
    {
      method: 'item/completed',
      params: {
        item: {
          type: 'fileChange',
          id: 'file_synthetic_codex',
          changes: [
            {
              path: SANITIZED_FIXTURE_PATH,
              kind: { type: 'update' },
              diff: patch,
            },
          ],
          applyStatus: 'applied',
        },
      },
    },
  ],
  session: makeFixtureSession({
    provider: 'codex',
    thoughtContent,
    outputTitle: 'node scripts/synthetic-check.mjs',
    outputContent: commandOutput,
    outputLanguage: 'bash',
    applyStatus: 'applied',
  }),
  assertions: {
    thoughtContent,
    diffPath: SANITIZED_FIXTURE_PATH,
    changedLineCount: SANITIZED_FIXTURE_LINE_COUNT,
  },
} satisfies SanitizedAgentDetailFixture;

export default fixture;
