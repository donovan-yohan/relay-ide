import {
  fixtureSanitization,
  makeFixtureSession,
  SANITIZED_FIXTURE_LINE_COUNT,
  SANITIZED_FIXTURE_PATH,
  sanitizedLargeDiff,
  type SanitizedAgentDetailFixture,
} from './types.js';

const thoughtContent =
  'Hermes synthetic thought: inspect the tool event before returning output.';
const commandOutput =
  'export interface SyntheticHermesValue {\n  ready: boolean;\n}';
const patch = sanitizedLargeDiff();

const fixture = {
  schemaVersion: 1,
  provider: 'hermes',
  sanitization: fixtureSanitization(),
  nativeEvents: [
    { type: 'response.created', response: { id: 'resp_synthetic_hermes' } },
    {
      type: 'response.reasoning_summary_text.delta',
      delta: thoughtContent,
    },
    {
      type: 'response.reasoning_summary_text.done',
      text: thoughtContent,
    },
    {
      type: 'response.output_item.added',
      item: {
        id: 'item_synthetic_hermes_command',
        type: 'function_call',
        call_id: 'call_synthetic_hermes_command',
        name: 'run_command',
        arguments: '{"command":"node scripts/synthetic-check.mjs"}',
      },
    },
    {
      type: 'response.output_item.added',
      item: {
        id: 'item_synthetic_hermes_patch',
        type: 'function_call',
        call_id: 'call_synthetic_hermes_patch',
        name: 'apply_patch',
        arguments: `{"path":"${SANITIZED_FIXTURE_PATH}"}`,
      },
    },
    {
      type: 'response.output_item.done',
      item: {
        id: 'item_synthetic_hermes_command',
        type: 'function_call',
        call_id: 'call_synthetic_hermes_command',
        name: 'run_command',
        arguments: '{"command":"node scripts/synthetic-check.mjs"}',
        status: 'completed',
        output: commandOutput,
      },
    },
    {
      type: 'response.output_item.done',
      item: {
        id: 'item_synthetic_hermes_patch',
        type: 'function_call',
        call_id: 'call_synthetic_hermes_patch',
        name: 'apply_patch',
        arguments: `{"path":"${SANITIZED_FIXTURE_PATH}"}`,
        status: 'completed',
        output: patch,
      },
    },
  ],
  session: makeFixtureSession({
    provider: 'hermes',
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
