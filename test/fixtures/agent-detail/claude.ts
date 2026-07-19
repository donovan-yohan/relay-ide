import {
  fixtureSanitization,
  makeFixtureSession,
  SANITIZED_FIXTURE_LINE_COUNT,
  SANITIZED_FIXTURE_PATH,
  sanitizedLargeDiff,
  type SanitizedAgentDetailFixture,
} from './types.js';

const thoughtContent =
  'Claude synthetic thought: inspect the adapter boundary before editing.';
const commandOutput =
  'export function syntheticClaudeValue(): number {\n  return 42;\n}';
const patch = sanitizedLargeDiff();

const fixture = {
  schemaVersion: 1,
  provider: 'claude',
  sanitization: fixtureSanitization(),
  nativeEvents: [
    {
      type: 'system',
      subtype: 'init',
      session_id: '00000000-0000-4000-8000-000000001198',
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_synthetic_claude_1198',
        content: [
          { type: 'thinking', thinking: thoughtContent },
          {
            type: 'tool_use',
            id: 'tool_synthetic_claude_command',
            name: 'Bash',
            input: { command: 'node scripts/synthetic-check.mjs' },
          },
          {
            type: 'tool_use',
            id: 'tool_synthetic_claude_edit',
            name: 'Edit',
            input: {
              file_path: SANITIZED_FIXTURE_PATH,
              old_string: 'synthetic old text',
              new_string: 'synthetic new text',
            },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_synthetic_claude_command',
            content: commandOutput,
          },
        ],
      },
      tool_use_result: { stdout: commandOutput, stderr: '' },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_synthetic_claude_edit',
            content: patch,
          },
        ],
      },
      tool_use_result: {
        filePath: SANITIZED_FIXTURE_PATH,
        gitDiff: { patch },
      },
    },
  ],
  session: makeFixtureSession({
    provider: 'claude',
    thoughtContent,
    outputTitle: 'node scripts/synthetic-check.mjs',
    outputContent: commandOutput,
    outputLanguage: 'bash',
    diffItemType: 'fileChange',
  }),
  assertions: {
    thoughtContent,
    diffPath: SANITIZED_FIXTURE_PATH,
    changedLineCount: SANITIZED_FIXTURE_LINE_COUNT,
  },
} satisfies SanitizedAgentDetailFixture;

export default fixture;
