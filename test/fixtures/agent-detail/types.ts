import type {
  AgentDetailCardV2,
  AgentProviderV2,
  AgentSessionV2,
} from '../../../shared/agent-chat-protocol-v2.js';

export const SANITIZED_FIXTURE_PATH = '/workspace/example/src/widget.ts';
export const SANITIZED_FIXTURE_LINE_COUNT = 500;

/**
 * A deliberately synthetic 500-line edit. The surrounding provider event
 * envelopes mirror real adapter transcripts, but every byte below was written
 * for this public fixture: no live prompts, paths, ids, output, or account data.
 */
export function sanitizedLargeDiff(): string {
  const removed = Array.from(
    { length: SANITIZED_FIXTURE_LINE_COUNT / 2 },
    (_, index) => `-export const oldValue${index + 1} = ${index + 1};`
  );
  const added = Array.from(
    { length: SANITIZED_FIXTURE_LINE_COUNT / 2 },
    (_, index) => `+export const newValue${index + 1} = ${index + 1};`
  );
  return [
    `--- a${SANITIZED_FIXTURE_PATH}`,
    `+++ b${SANITIZED_FIXTURE_PATH}`,
    '@@ -1,250 +1,250 @@',
    ...removed,
    ...added,
  ].join('\n');
}

export interface SanitizedAgentDetailFixture {
  schemaVersion: 1;
  provider: Extract<AgentProviderV2, 'claude' | 'codex' | 'hermes'>;
  sanitization: {
    method: 'hand-sanitized-structural-replay';
    containsLiveTranscriptBytes: false;
    syntheticIds: true;
    syntheticPath: typeof SANITIZED_FIXTURE_PATH;
  };
  /** Structurally faithful provider envelopes consumed by adapter tests. */
  nativeEvents: readonly Record<string, unknown>[];
  /** Adapter-normalized state consumed directly by the renderer harness. */
  session: AgentSessionV2;
  assertions: {
    thoughtContent: string;
    diffPath: typeof SANITIZED_FIXTURE_PATH;
    changedLineCount: typeof SANITIZED_FIXTURE_LINE_COUNT;
  };
}

interface FixtureSessionInput {
  provider: SanitizedAgentDetailFixture['provider'];
  thoughtContent: string;
  outputTitle: string;
  outputContent: string;
  outputLanguage: string;
  diffItemType: 'fileChange' | 'dynamicToolCall';
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function card(input: AgentDetailCardV2): AgentDetailCardV2 {
  return input;
}

export function makeFixtureSession(input: FixtureSessionInput): AgentSessionV2 {
  const provider = input.provider;
  const thoughtId = `${provider}-thought`;
  const outputId = `${provider}-output`;
  const diffId = `${provider}-diff`;
  const patch = sanitizedLargeDiff();
  const diffCard = card({
    kind: 'diff',
    title: SANITIZED_FIXTURE_PATH,
    status: 'completed',
    content: patch,
    language: 'diff',
    path: SANITIZED_FIXTURE_PATH,
    additions: SANITIZED_FIXTURE_LINE_COUNT / 2,
    deletions: SANITIZED_FIXTURE_LINE_COUNT / 2,
    sizeBytes: bytes(patch),
  });

  return {
    id: `fixture-${provider}`,
    provider,
    providerSession: { sessionId: `synthetic-${provider}-session` },
    capabilities: {
      text: true,
      reasoning: true,
      tools: true,
      commandExecution: true,
      fileChanges: true,
    },
    config: { cwd: '/workspace/example', model: `synthetic-${provider}-model` },
    live: {
      status: 'idle',
      activeTurnId: null,
      waitingOn: null,
      activeRequestIds: [],
      proposedPlanItemId: null,
      queueLength: 0,
      fastModeAvailable: false,
      error: null,
    },
    turns: [
      {
        id: `turn-${provider}`,
        providerTurnId: `synthetic-${provider}-turn`,
        status: 'completed',
        inputMessageId: `input-${provider}`,
        startedAt: '2026-07-19T00:00:00.000Z',
        completedAt: '2026-07-19T00:00:01.000Z',
        items: [
          {
            id: thoughtId,
            providerItemId: `synthetic-${thoughtId}`,
            type: 'reasoning',
            status: 'completed',
            summary: input.thoughtContent,
            detail: input.thoughtContent,
            visibility: 'summary',
            card: {
              kind: 'thought',
              title: input.thoughtContent,
              status: 'completed',
              content: input.thoughtContent,
              sizeBytes: bytes(input.thoughtContent),
            },
          },
          {
            id: outputId,
            providerItemId: `synthetic-${outputId}`,
            type: 'commandExecution',
            status: 'completed',
            command: input.outputTitle,
            cwd: '/workspace/example',
            output: input.outputContent,
            exitCode: 0,
            card: {
              kind: 'output',
              title: input.outputTitle,
              status: 'completed',
              content: input.outputContent,
              language: input.outputLanguage,
              command: input.outputTitle,
              sizeBytes: bytes(input.outputContent),
            },
          },
          input.diffItemType === 'fileChange'
            ? {
                id: diffId,
                providerItemId: `synthetic-${diffId}`,
                type: 'fileChange',
                status: 'completed',
                paths: [{ path: SANITIZED_FIXTURE_PATH, status: 'update' }],
                patch,
                applyStatus: 'applied',
                card: diffCard,
              }
            : {
                id: diffId,
                providerItemId: `synthetic-${diffId}`,
                type: 'dynamicToolCall',
                status: 'completed',
                namespace: 'fixture',
                tool: 'apply_patch',
                content: patch,
                result: { status: 'completed' },
                metadata: { contentKind: 'diff' },
                card: diffCard,
              },
        ],
      },
    ],
  };
}

export function fixtureSanitization(): SanitizedAgentDetailFixture['sanitization'] {
  return {
    method: 'hand-sanitized-structural-replay',
    containsLiveTranscriptBytes: false,
    syntheticIds: true,
    syntheticPath: SANITIZED_FIXTURE_PATH,
  };
}
