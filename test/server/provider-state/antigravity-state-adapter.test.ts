import {
  mkdtemp,
  mkdir,
  appendFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAgentPatchV2 } from '../../../shared/agent-chat-protocol-v2.js';
import {
  createCliGatewayEventBus,
  type CliGatewayEventBus,
} from '../../../server/cli-gateway-event-bus.js';
import {
  LiveTailCursorStore,
  NativeSessionLiveTailManager,
} from '../../../server/provider-state/live-tail-manager.js';
import {
  AntigravityStateAdapter,
  extractUserRequestText,
} from '../../../server/provider-state/antigravity-state-adapter.js';

// Synthetic fixtures shaped like the real Antigravity CLI store (#1439):
// <stateRoot>/history.jsonl plus
// <stateRoot>/brain/<conversationId>/.system_generated/logs/transcript.jsonl.
// Fixtures are written in-test; the real ~/.gemini store is never read.
const CONV_ID = '66bd3c49-bb87-4c30-b9d7-b115f9fd2d36';
const WORKSPACE = '/tmp/repo';

interface HistoryRow {
  display?: string;
  timestamp?: number;
  workspace?: string;
  conversationId?: string;
  type?: string;
}

function historyLine(row: HistoryRow): string {
  return JSON.stringify(row);
}

interface TranscriptRecord {
  step_index?: number;
  source?: string;
  type: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: unknown[];
  [key: string]: unknown;
}

async function writeAntigravityFixture(
  historyRows: HistoryRow[],
  transcripts: Record<string, TranscriptRecord[]> = {}
): Promise<{ root: string; transcriptPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-agy-state-'));
  if (historyRows.length > 0) {
    await writeFile(
      path.join(root, 'history.jsonl'),
      `${historyRows.map(historyLine).join('\n')}\n`
    );
  }
  let transcriptPath = '';
  for (const [conversationId, records] of Object.entries(transcripts)) {
    const dir = path.join(
      root,
      'brain',
      conversationId,
      '.system_generated',
      'logs'
    );
    await mkdir(dir, { recursive: true });
    transcriptPath = path.join(dir, 'transcript.jsonl');
    await writeFile(
      transcriptPath,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    );
  }
  return { root, transcriptPath };
}

function standardHistory(): HistoryRow[] {
  return [
    {
      display: 'gemini 3.7 is not available in antigravity?',
      timestamp: 1787647189425,
      workspace: WORKSPACE,
      conversationId: CONV_ID,
    },
    // Pre-conversation rows carry no conversationId and must be ignored.
    {
      display: '/model',
      timestamp: 1787647000000,
      workspace: WORKSPACE,
      type: 'slash_command',
    },
    // A second prompt in the same conversation updates lastMessageAt only.
    {
      display: 'thanks, that explains it api_key=supersecret123',
      timestamp: 1787647300000,
      workspace: WORKSPACE,
      conversationId: CONV_ID,
    },
    // A different conversation in a different workspace (scope filtering).
    {
      display: 'other workspace conversation',
      timestamp: 1787647200000,
      workspace: '/other/repo',
      conversationId: 'aaaaaaaa-0000-0000-0000-000000000001',
    },
  ];
}

function standardTranscript(): TranscriptRecord[] {
  return [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-08-25T08:39:49Z',
      content:
        '<USER_REQUEST>\ngemini 3.7 is not available in antigravity?\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-08-25T08:39:49Z.\n</ADDITIONAL_METADATA>',
    },
    {
      step_index: 1,
      source: 'SYSTEM',
      type: 'CONVERSATION_HISTORY',
      status: 'DONE',
      created_at: '2026-08-25T08:39:49Z',
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-08-25T08:39:50Z',
      thinking:
        'Investigating Gemini availability. The user asks about model selection.',
      tool_calls: [
        {
          name: 'list_dir',
          args: {
            DirectoryPath: '"/tmp/repo"',
            toolSummary: '"List directory contents"',
          },
        },
      ],
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'LIST_DIRECTORY',
      status: 'ERROR',
      created_at: '2026-08-25T08:39:51Z',
      content:
        'Created At: 2026-08-25T08:39:51Z\nEncountered error in step execution: Permission denied for read_file(/tmp/repo).',
    },
    {
      step_index: 4,
      source: 'MODEL',
      type: 'LIST_DIRECTORY',
      status: 'DONE',
      created_at: '2026-08-25T08:39:52Z',
      content: '{"name":"alpha","isDir":true}\n{"name":"beta.txt","size":12}',
    },
    {
      step_index: 5,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-08-25T08:39:53Z',
      content:
        'Model availability is managed through Model Selection settings; Gemini 3.7 is not enabled in this build.',
    },
    {
      step_index: 6,
      source: 'SYSTEM',
      type: 'CHECKPOINT',
      status: 'DONE',
      created_at: '2026-08-25T08:39:54Z',
    },
    {
      step_index: 7,
      source: 'MODEL',
      type: 'BRAND_NEW_UNKNOWN_STEP',
      status: 'DONE',
      created_at: '2026-08-25T08:39:55Z',
      content: 'mystery payload',
    },
  ];
}

describe('AntigravityStateAdapter', () => {
  it('reports installed status when the state root exists', async () => {
    const { root } = await writeAntigravityFixture(standardHistory());
    const adapter = new AntigravityStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-25T09:00:00.000Z'),
    });

    await expect(adapter.detectInstall()).resolves.toMatchObject({
      provider: 'antigravity',
      status: 'installed',
      stateRoots: [root],
    });
  });

  it('reports unavailable status when state root does not exist', async () => {
    const adapter = new AntigravityStateAdapter({
      stateRoot: '/nonexistent/path/.gemini/antigravity-cli',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    const status = await adapter.detectInstall();
    expect(status.provider).toBe('antigravity');
    expect(status.status).toBe('unavailable');
    expect(status.diagnostics[0]?.code).toBe('AGY_STATE_ROOT_NOT_FOUND');
  });

  it('lists history-grouped sessions with bounded redacted titles and honest per-session importability', async () => {
    const { root, transcriptPath } = await writeAntigravityFixture(
      standardHistory(),
      { [CONV_ID]: standardTranscript() }
    );
    const adapter = new AntigravityStateAdapter({ stateRoot: root });

    const sessions = await adapter.listNativeSessions();
    expect(sessions).toHaveLength(2);
    const first = sessions.find((session) => session.nativeId === CONV_ID);
    expect(first).toMatchObject({
      provider: 'antigravity',
      cwd: WORKSPACE,
      createdAt: new Date(1787647189425).toISOString(),
      lastMessageAt: new Date(1787647300000).toISOString(),
      title: 'gemini 3.7 is not available in antigravity?',
      metadata: {
        nativeSessionId: CONV_ID,
        transcriptAvailable: true,
      },
    });
    expect(first?.sourcePath).toBe(transcriptPath);
    expect(first?.preview).toMatchObject({
      source: 'metadata',
      redacted: true,
    });
    // Title is bounded by PREVIEW_LIMIT even for long prompts.
    expect(first?.preview.text.length).toBeLessThanOrEqual(240);

    // Newest conversation wins ordering.
    expect(sessions[0]?.nativeId).toBe(CONV_ID);

    // Scope filtering by cwd.
    const scoped = await adapter.listNativeSessions({ cwd: '/other/repo' });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.nativeId).toBe('aaaaaaaa-0000-0000-0000-000000000001');

    // A conversation with no parseable brain transcript still lists, with an
    // honest per-session signal instead of a failed import later.
    const pbOnly = scoped[0];
    expect(pbOnly?.metadata.transcriptAvailable).toBe(false);
  });

  it('rejects caller-provided source paths outside the configured state root', async () => {
    const { root } = await writeAntigravityFixture(standardHistory(), {});
    const outsideRoot = await mkdtemp(
      path.join(tmpdir(), 'relay-agy-outside-')
    );
    const outsidePath = path.join(outsideRoot, 'escape.jsonl');
    await writeFile(outsidePath, '{}\n');
    const adapter = new AntigravityStateAdapter({ stateRoot: root });

    await expect(
      adapter.readProviderState({
        provider: 'antigravity',
        nativeId: CONV_ID,
        sourcePath: path.join(
          root,
          '..',
          path.basename(outsideRoot),
          'escape.jsonl'
        ),
      })
    ).rejects.toThrow(/state root/i);
    void outsidePath;
  });

  it('rejects non-jsonl and symlink source paths even when they appear inside the state root', async () => {
    const { root } = await writeAntigravityFixture(standardHistory(), {
      [CONV_ID]: standardTranscript(),
    });
    const plainPath = path.join(root, 'plain.txt');
    await writeFile(plainPath, 'not jsonl\n');
    const outsideRoot = await mkdtemp(
      path.join(tmpdir(), 'relay-agy-symlink-')
    );
    const outsideTarget = path.join(outsideRoot, 'outside.jsonl');
    await writeFile(outsideTarget, '{}\n');
    const linkPath = path.join(root, 'linked-outside.jsonl');
    await symlink(outsideTarget, linkPath);
    const adapter = new AntigravityStateAdapter({ stateRoot: root });

    await expect(
      adapter.readProviderState({
        provider: 'antigravity',
        nativeId: CONV_ID,
        sourcePath: plainPath,
      })
    ).rejects.toThrow(/jsonl/i);
    await expect(
      adapter.readProviderState({
        provider: 'antigravity',
        nativeId: CONV_ID,
        sourcePath: linkPath,
      })
    ).rejects.toThrow(/symlink/i);
  });

  it('imports a brain transcript into an AgentSessionV2 with reasoning evidence, tool steps, and attributed gaps', async () => {
    const { root, transcriptPath } = await writeAntigravityFixture(
      standardHistory(),
      { [CONV_ID]: standardTranscript() }
    );
    const adapter = new AntigravityStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-25T09:00:00.000Z'),
    });

    const result = await adapter.importSession({
      provider: 'antigravity',
      nativeId: CONV_ID,
      sourcePath: transcriptPath,
    });

    expect(result.provider).toBe('antigravity');
    expect(result.nativeId).toBe(CONV_ID);
    expect(result.session.provider).toBe('antigravity');
    expect(result.session.providerSession).toMatchObject({
      nativeId: CONV_ID,
      sourcePath: transcriptPath,
      stateKind: 'antigravity-transcript-jsonl',
    });
    expect(result.patches).toHaveLength(1);
    expect(result.patches.every(isAgentPatchV2)).toBe(true);

    // Exactly one non-audit turn: one USER_INPUT opened it and everything
    // after folds into it.
    const nonAuditTurns = result.session.turns.filter(
      (turn) => turn.id !== 'native-import-audit'
    );
    expect(nonAuditTurns).toHaveLength(1);
    const items = nonAuditTurns[0]?.items ?? [];
    const types = items.map((item) => item.type);

    // USER_INPUT unwraps to the real request text only.
    expect(items.find((item) => item.type === 'userMessage')).toMatchObject({
      text: 'gemini 3.7 is not available in antigravity?',
    });
    // PLANNER_RESPONSE thinking -> reasoning item.
    expect(items.find((item) => item.type === 'reasoning')).toMatchObject({
      summary: expect.stringContaining('Investigating Gemini availability'),
    });
    // Final answer lands as assistantMessage.
    expect(
      items.find((item) => item.type === 'assistantMessage')
    ).toMatchObject({
      text: expect.stringContaining('Model Selection settings'),
    });
    // Tool calls + tool steps surface as provider extensions with honest
    // ERROR status on the failed step.
    const toolSteps = items.filter((item) => item.type === 'providerExtension');
    expect(toolSteps.length).toBeGreaterThanOrEqual(3);
    expect(toolSteps.map((item) => item.status)).toContain('failed');

    // System bookkeeping attaches while a turn is open...
    expect(types.filter((type) => type === 'userMessage')).toHaveLength(1);

    // ...and unknown types are attributed gaps recorded on the audit marker —
    // never silent drops.
    expect(JSON.stringify(result.session)).toContain('BRAND_NEW_UNKNOWN_STEP');
    // Secrets never survive import.
    expect(JSON.stringify(result.session)).not.toContain('supersecret123');
    expect(JSON.stringify(result.session)).not.toContain('<USER_REQUEST>');

    // Deterministic mapping: same input, same session id + turns.
    const second = await adapter.importSession({
      provider: 'antigravity',
      nativeId: CONV_ID,
      sourcePath: transcriptPath,
    });
    expect(second.session.id).toBe(result.session.id);
    expect(second.session.turns).toEqual(result.session.turns);
  });

  it('degrades .pb-only conversations honestly by importing user turns from history with a degradation marker', async () => {
    const { root } = await writeAntigravityFixture([
      {
        display: 'what model should I use?',
        timestamp: 1787647189425,
        workspace: WORKSPACE,
        conversationId: CONV_ID,
      },
    ]);
    const adapter = new AntigravityStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-25T09:00:00.000Z'),
    });

    const result = await adapter.importSession({
      provider: 'antigravity',
      nativeId: CONV_ID,
    });

    const marker = result.session.turns[0]?.items[0] as {
      payload: Record<string, unknown>;
    };
    expect(marker.payload.degradedSource).toBe('antigravity-history-jsonl');
    expect(marker.payload.degradedReason).toBe(
      'assistant-content-not-parseable-from-pb-artifacts'
    );
    const userTurn = result.session.turns.find(
      (turn) => turn.id !== 'native-import-audit'
    );
    expect(userTurn?.items[0]).toMatchObject({
      type: 'userMessage',
      text: 'what model should I use?',
    });
  });

  it('trims oversized imports FIFO while preserving the audit marker and reporting truncation', async () => {
    const bigRows: HistoryRow[] = Array.from({ length: 24 }, (_, index) => ({
      display: `message-${index}:${'x'.repeat(20_000)}`,
      timestamp: 1787647100000 + index,
      workspace: WORKSPACE,
      conversationId: CONV_ID,
    }));
    const { root } = await writeAntigravityFixture(bigRows);
    const adapter = new AntigravityStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-25T09:30:00.000Z'),
    });

    const result = await adapter.importSession({
      provider: 'antigravity',
      nativeId: CONV_ID,
    });

    expect(result.session.turns[0]?.id).toBe('native-import-audit');
    expect(result.importTruncation).toMatchObject({
      truncated: true,
      droppedTurns: expect.any(Number),
    });
    expect(JSON.stringify(result.session)).not.toContain('message-0:');
    expect(JSON.stringify(result.session)).toContain('message-23:');
  });

  it('returns bounded provider snapshots and copyable resume argv without executing it', async () => {
    const { root, transcriptPath } = await writeAntigravityFixture(
      standardHistory(),
      { [CONV_ID]: standardTranscript() }
    );
    const adapter = new AntigravityStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-25T09:00:00.000Z'),
    });

    const snapshot = await adapter.readProviderState({
      provider: 'antigravity',
      nativeId: CONV_ID,
      sourcePath: transcriptPath,
    });

    expect(snapshot.ref).toMatchObject({
      provider: 'antigravity',
      nativeId: CONV_ID,
    });
    expect(snapshot.redaction).toEqual({
      rawPayloadStored: false,
      strategy: 'preview',
      classes: ['credential', 'secret', 'payload', 'transcript'],
    });
    expect(snapshot.summary.eventTypes).toEqual([
      'BRAND_NEW_UNKNOWN_STEP',
      'CHECKPOINT',
      'CONVERSATION_HISTORY',
      'LIST_DIRECTORY',
      'PLANNER_RESPONSE',
      'USER_INPUT',
    ]);
    expect(snapshot.summary.firstTimestamp).toBe('2026-08-25T08:39:49Z');
    expect(snapshot.summary.lastTimestamp).toBe('2026-08-25T08:39:55Z');

    expect(
      adapter.resumeCommand({ provider: 'antigravity', nativeId: CONV_ID })
    ).toEqual(['agy', '--conversation', CONV_ID]);
  });

  it('reports honest capabilities including live streaming and tool-call exposure', () => {
    const adapter = new AntigravityStateAdapter({ stateRoot: '/tmp/agy' });
    expect(adapter.capabilities).toEqual({
      canImportTranscript: true,
      canReadProviderState: true,
      canResumeNative: true,
      canStreamLiveEvents: true,
      canRespondToApprovals: false,
      canExposeToolCalls: true,
      readOnly: true,
    });
  });

  it('unwraps USER_REQUEST and falls back to full content when the wrapper is absent', () => {
    expect(
      extractUserRequestText({
        content:
          '<USER_REQUEST>\nreal question here\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>',
      })
    ).toBe('real question here');
    expect(extractUserRequestText({ content: 'plain legacy prompt' })).toBe(
      'plain legacy prompt'
    );
    expect(extractUserRequestText({ content: '' })).toBe('');
  });
});

describe('normalizeAntigravityLiveEvent via NativeSessionLiveTailManager', () => {
  let managers: NativeSessionLiveTailManager[] = [];

  afterEach(() => {
    for (const manager of managers) manager.stopAll();
    managers = [];
  });

  interface Collected {
    bus: CliGatewayEventBus;
    events: Record<string, unknown>[];
  }

  function collect(bus: CliGatewayEventBus): Collected {
    const events: Record<string, unknown>[] = [];
    bus.subscribe('native-sessions', (event) => {
      const payload = event.payload as Record<string, unknown>;
      events.push({
        kind: payload['kind'],
        nativeId: payload['nativeId'],
        text: payload['text'],
        providerEvent: payload['providerEvent'],
      });
    });
    return { bus, events };
  }

  function makeManager(configDir: string, bus: CliGatewayEventBus) {
    const manager = new NativeSessionLiveTailManager({
      eventBus: bus,
      cursorStore: new LiveTailCursorStore(configDir),
    });
    managers.push(manager);
    return manager;
  }

  async function tailFixture(records: TranscriptRecord[]): Promise<{
    root: string;
    file: string;
  }> {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-agy-tail-'));
    const dir = path.join(root, 'brain', CONV_ID, '.system_generated', 'logs');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'transcript.jsonl');
    await writeFile(
      file,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    );
    return { root, file };
  }

  it('streams appended transcript records in order onto the scoped topic with durable cursors across restart', async () => {
    const { root, file } = await tailFixture([
      {
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-08-25T08:39:49Z',
        content: '<USER_REQUEST>check the token=abc123 setup</USER_REQUEST>',
      },
    ]);

    const bus = createCliGatewayEventBus();
    const collected = collect(bus);
    const manager = makeManager(root, bus);
    manager.watch({
      provider: 'antigravity',
      nativeId: CONV_ID,
      sourcePath: file,
    });
    manager.pollAll();

    // Later appends: thinking, a tool call, then the answer — all from ONE
    // appended PLANNER_RESPONSE record, emitted in file order.
    await appendFile(
      file,
      `${JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-08-25T08:40:00Z',
        thinking: 'thinking about files',
        tool_calls: [{ name: 'read_file', args: {} }],
        content: 'all done looking',
      })}\n`
    );
    manager.pollAll();
    manager.stopAll();

    // A fresh manager sharing ONLY the durable cursor store must consume no
    // new bytes — no replay, no gap (#1428 restart semantics).
    const resumed = makeManager(root, bus);
    resumed.watch({
      provider: 'antigravity',
      nativeId: CONV_ID,
      sourcePath: file,
    });
    resumed.pollAll();
    resumed.stopAll();

    expect(collected.events).toEqual([
      {
        kind: 'user-message',
        nativeId: CONV_ID,
        text: 'check the token=[redacted] setup',
        providerEvent: 'USER_INPUT',
      },
      {
        kind: 'reasoning',
        nativeId: CONV_ID,
        text: 'thinking about files',
        providerEvent: 'PLANNER_RESPONSE:thinking',
      },
      {
        kind: 'tool-call',
        nativeId: CONV_ID,
        text: 'read_file',
        providerEvent: 'PLANNER_RESPONSE:tool_calls:read_file',
      },
      {
        kind: 'assistant-message',
        nativeId: CONV_ID,
        text: 'all done looking',
        providerEvent: 'PLANNER_RESPONSE',
      },
    ]);
  });

  it('holds back a torn trailing line until its newline arrives', async () => {
    const { root, file } = await tailFixture([]);
    const pending = JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-08-25T08:39:49Z',
      content: '<USER_REQUEST>torn line message</USER_REQUEST>',
    });

    const bus = createCliGatewayEventBus();
    const collected = collect(bus);
    const manager = makeManager(root, bus);
    manager.watch({
      provider: 'antigravity',
      nativeId: CONV_ID,
      sourcePath: file,
    });
    manager.pollAll();
    expect(collected.events).toEqual([]);

    // Torn write: half the line lands with no terminating newline yet.
    await appendFile(
      file,
      `${pending.slice(0, Math.floor(pending.length / 2))}`
    );
    manager.pollAll();
    expect(collected.events).toEqual([]);

    // The writer finishes the line; now exactly one event appears.
    await appendFile(
      file,
      `${pending.slice(Math.floor(pending.length / 2))}\n`
    );
    manager.pollAll();
    expect(collected.events).toEqual([
      {
        kind: 'user-message',
        nativeId: CONV_ID,
        text: 'torn line message',
        providerEvent: 'USER_INPUT',
      },
    ]);
    manager.stopAll();
  });

  it('publishes explicit attributed gaps for system records and unknown types — never silent drops', async () => {
    const { root, file } = await tailFixture([
      {
        step_index: 1,
        source: 'SYSTEM',
        type: 'CONVERSATION_HISTORY',
        status: 'DONE',
        created_at: '2026-08-25T08:39:49Z',
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'LIST_DIRECTORY',
        status: 'ERROR',
        created_at: '2026-08-25T08:39:51Z',
        content: 'Permission denied for read_file(/tmp/repo)',
      },
      {
        step_index: 99,
        source: 'MODEL',
        type: 'brand_new_unknown_event',
        status: 'DONE',
        created_at: '2026-08-25T08:39:59Z',
      },
    ]);

    const bus = createCliGatewayEventBus();
    const collected = collect(bus);
    const manager = makeManager(root, bus);
    manager.watch({
      provider: 'antigravity',
      nativeId: CONV_ID,
      sourcePath: file,
    });
    manager.pollAll();
    manager.stopAll();

    expect(collected.events).toEqual([
      {
        kind: 'gap',
        nativeId: CONV_ID,
        text: '',
        providerEvent: 'CONVERSATION_HISTORY',
      },
      {
        kind: 'tool-result',
        nativeId: CONV_ID,
        text: 'Permission denied for read_file(/tmp/repo)',
        providerEvent: 'LIST_DIRECTORY:ERROR',
      },
      {
        kind: 'gap',
        nativeId: CONV_ID,
        text: '',
        providerEvent: 'brand_new_unknown_event',
      },
    ]);
  });
});
