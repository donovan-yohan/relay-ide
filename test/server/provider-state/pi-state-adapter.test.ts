import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
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
  PiStateAdapter,
  piSessionDirSlug,
} from '../../../server/provider-state/pi-state-adapter.js';

// Synthetic fixtures shaped like real Pi agent session stores (#1426):
// <stateRoot>/--<cwd without leading slash, '/' -> '-'>--/<ISO>_<uuid>.jsonl.
const SESSION_ID = '019fd554-f4bc-7662-a01a-c72b5993a6d3';

async function writePiFixture(): Promise<{
  root: string;
  sessionPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-pi-state-'));
  const bucket = path.join(root, piSessionDirSlug('/tmp/repo'));
  await mkdir(bucket, { recursive: true });
  const sessionPath = path.join(
    bucket,
    `2026-08-06T04-29-02-524Z_${SESSION_ID}.jsonl`
  );
  const lines = [
    {
      type: 'session',
      version: 3,
      id: SESSION_ID,
      timestamp: '2026-08-06T04:29:02.524Z',
      cwd: '/tmp/repo',
    },
    {
      type: 'model_change',
      id: '99d1edbd',
      parentId: null,
      timestamp: '2026-08-06T04:29:03.494Z',
      provider: 'openai-codex',
      modelId: 'gpt-test',
    },
    {
      type: 'thinking_level_change',
      id: '161837f6',
      parentId: '99d1edbd',
      timestamp: '2026-08-06T04:29:03.494Z',
      thinkingLevel: 'high',
    },
    {
      type: 'message',
      id: 'b8f21465',
      parentId: '161837f6',
      timestamp: '2026-08-06T04:29:04.986Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'please check the api_key=secret123 setup' },
        ],
        timestamp: 1785990543767,
      },
    },
    {
      type: 'message',
      id: 'fd2bfe57',
      parentId: 'b8f21465',
      timestamp: '2026-08-06T04:29:09.947Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'need to inspect files' },
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'bash',
            arguments: {
              command: 'npm test',
              apiKey: 'sk-abcdefghijklmnopqrstuvwx',
            },
          },
          { type: 'text', text: 'the pi adapter can read JSONL safely' },
        ],
      },
    },
    {
      type: 'message',
      id: 'd56ae1b0',
      parentId: 'fd2bfe57',
      timestamp: '2026-08-06T04:29:10.259Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'bash',
        isError: false,
        content: [
          {
            type: 'text',
            text: 'stdout contained ghp_abcdefghijklmnopqrstuvwxyz012345 output',
          },
        ],
        details: {},
        isError2: undefined,
      },
    },
  ];
  await writeFile(
    sessionPath,
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  );
  return { root, sessionPath };
}

describe('PiStateAdapter', () => {
  it('reports installed status when the sessions directory exists and is readable', async () => {
    const { root } = await writePiFixture();
    const adapter = new PiStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-06T00:10:00.000Z'),
    });

    await expect(adapter.detectInstall()).resolves.toMatchObject({
      provider: 'pi',
      status: 'installed',
      stateRoots: [root],
    });
  });

  it('reports unavailable status when state root does not exist', async () => {
    const adapter = new PiStateAdapter({
      stateRoot: '/nonexistent/path/that/does/not/exist/.pi/agent/sessions',
      now: () => new Date('2026-01-01T00:10:00.000Z'),
    });

    const status = await adapter.detectInstall();
    expect(status.provider).toBe('pi');
    expect(status.status).toBe('unavailable');
    expect(status.diagnostics[0]?.code).toBe('PI_STATE_ROOT_NOT_FOUND');
  });

  it('lists native sessions from the cwd bucket with redacted previews', async () => {
    const { root, sessionPath } = await writePiFixture();
    const adapter = new PiStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-06T00:10:00.000Z'),
    });

    const sessions = await adapter.listNativeSessions({ cwd: '/tmp/repo' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: 'pi',
      nativeId: SESSION_ID,
      sourcePath: sessionPath,
      cwd: '/tmp/repo',
      createdAt: '2026-08-06T04:29:02.524Z',
      lastMessageAt: '2026-08-06T04:29:10.259Z',
      capabilities: {
        canImportTranscript: true,
        canReadProviderState: true,
        canResumeNative: true,
        canStreamLiveEvents: true,
        readOnly: true,
      },
    });
    expect(sessions[0]?.preview.source).toBe('transcript');
    expect(sessions[0]?.preview.text).toContain('api_key=[redacted]');
    expect(sessions[0]?.preview.text).not.toContain('secret123');

    // Scope filtering: a different cwd matches nothing (no such bucket).
    expect(await adapter.listNativeSessions({ cwd: '/other/repo' })).toEqual(
      []
    );
  });

  it('rejects caller-provided source paths outside the configured state root', async () => {
    const { root } = await writePiFixture();
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'relay-pi-outside-'));
    const outsidePath = path.join(outsideRoot, 'escape.jsonl');
    await writeFile(
      outsidePath,
      `${JSON.stringify({ type: 'session', id: 'escape' })}\n`
    );
    const adapter = new PiStateAdapter({ stateRoot: root });

    await expect(
      adapter.readProviderState({
        provider: 'pi',
        nativeId: 'escape',
        sourcePath: path.join(
          root,
          '..',
          path.basename(outsideRoot),
          'escape.jsonl'
        ),
      })
    ).rejects.toThrow(/state root/i);
  });

  it('rejects non-jsonl and symlink source paths even when they appear inside the state root', async () => {
    const { root } = await writePiFixture();
    const nonJsonlPath = path.join(
      root,
      piSessionDirSlug('/tmp/repo'),
      'not-json.txt'
    );
    await writeFile(nonJsonlPath, '{}\n');
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'relay-pi-symlink-'));
    const outsidePath = path.join(outsideRoot, 'outside.jsonl');
    await writeFile(
      outsidePath,
      `${JSON.stringify({ type: 'session', id: 'outside' })}\n`
    );
    const linkPath = path.join(
      root,
      piSessionDirSlug('/tmp/repo'),
      'linked-outside.jsonl'
    );
    await symlink(outsidePath, linkPath);
    const adapter = new PiStateAdapter({ stateRoot: root });

    await expect(
      adapter.readProviderState({
        provider: 'pi',
        nativeId: 'not-json',
        sourcePath: nonJsonlPath,
      })
    ).rejects.toThrow(/jsonl/i);
    await expect(
      adapter.readProviderState({
        provider: 'pi',
        nativeId: 'outside',
        sourcePath: linkPath,
      })
    ).rejects.toThrow(/symlink/i);
  });

  it('rejects JSONL source files above the explicit byte limit before import', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-pi-oversize-'));
    const bucket = path.join(root, piSessionDirSlug('/tmp/repo'));
    await mkdir(bucket, { recursive: true });
    const sessionPath = path.join(bucket, `huge_${SESSION_ID}.jsonl`);
    await writeFile(
      sessionPath,
      `${JSON.stringify({ type: 'session', id: SESSION_ID })}\n${'x'.repeat(5_100_000)}`
    );
    const adapter = new PiStateAdapter({ stateRoot: root });

    await expect(
      adapter.importSession({
        provider: 'pi',
        nativeId: SESSION_ID,
        sourcePath: sessionPath,
      })
    ).rejects.toThrow(/exceeds/i);
  });

  it('truncates JSONL parsing at the explicit event limit and reports source metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-pi-event-limit-'));
    const bucket = path.join(root, piSessionDirSlug('/tmp/repo'));
    await mkdir(bucket, { recursive: true });
    const sessionPath = path.join(bucket, `event-limit_${SESSION_ID}.jsonl`);
    const lines = Array.from({ length: 5_010 }, () => ({
      type: 'model_change',
      id: 'x',
      timestamp: '2026-08-06T04:29:03.494Z',
    }));
    await writeFile(
      sessionPath,
      `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`
    );
    const adapter = new PiStateAdapter({ stateRoot: root });

    const snapshot = await adapter.readProviderState({
      provider: 'pi',
      nativeId: SESSION_ID,
      sourcePath: sessionPath,
    });

    expect(snapshot.summary.lineCount).toBe(5_000);
    expect(snapshot.summary.readTruncation).toMatchObject({
      truncated: true,
      reason: 'event-limit',
      maxEvents: 5_000,
      parsedEvents: 5_000,
    });
    expect(JSON.stringify(snapshot)).not.toContain('"parsedEvents":5010');
  });

  it('imports a Pi JSONL fixture into an AgentSessionV2 read model with an audit marker', async () => {
    const { root, sessionPath } = await writePiFixture();
    const adapter = new PiStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-06T00:10:00.000Z'),
    });

    const result = await adapter.importSession({
      provider: 'pi',
      nativeId: SESSION_ID,
      sourcePath: sessionPath,
    });

    expect(result.provider).toBe('pi');
    expect(result.session.provider).toBe('pi');
    expect(result.session.providerSession).toMatchObject({
      nativeId: SESSION_ID,
      sourcePath: sessionPath,
      stateKind: 'pi-jsonl',
    });
    expect(result.session.turns[0]?.items[0]).toMatchObject({
      type: 'providerExtension',
      namespace: 'provider-state-import',
      payload: {
        event: 'native-session-imported',
        sourceProvider: 'pi',
        importSource: 'pi-jsonl',
        readOnly: true,
      },
    });
    expect(result.session.turns.at(-1)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'userMessage',
          text: expect.stringContaining('api_key=[redacted]'),
        }),
        expect.objectContaining({
          type: 'reasoning',
          summary: 'need to inspect files',
        }),
        expect.objectContaining({
          type: 'commandExecution',
          command: 'npm test',
          metadata: { sourceProvider: 'pi', readOnlyImport: true },
        }),
        expect.objectContaining({
          type: 'assistantMessage',
          text: 'the pi adapter can read JSONL safely',
        }),
      ])
    );
    // Tool results land as attributed pi-namespaced extension items.
    expect(result.session.turns.at(-1)?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'providerExtension',
          namespace: 'pi',
          payload: expect.objectContaining({
            kind: 'tool_result',
            toolName: 'bash',
          }),
        }),
      ])
    );
    expect(JSON.stringify(result.session)).not.toContain(
      'sk-abcdefghijklmnopqrstuvwx'
    );
    expect(JSON.stringify(result.session)).not.toContain('secret123');
    expect(result.patches).toHaveLength(1);
    expect(result.patches.every(isAgentPatchV2)).toBe(true);

    // Deterministic mapping: same input, same patches.
    const second = await adapter.importSession({
      provider: 'pi',
      nativeId: SESSION_ID,
      sourcePath: sessionPath,
    });
    expect(second.session.id).toBe(result.session.id);
    expect(second.session.turns).toEqual(result.session.turns);
  });

  it('logs unmapped event types as gaps instead of dropping them silently', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-pi-gap-'));
    const bucket = path.join(root, piSessionDirSlug('/tmp/repo'));
    await mkdir(bucket, { recursive: true });
    const sessionPath = path.join(bucket, `gap_${SESSION_ID}.jsonl`);
    const lines = [
      {
        type: 'session',
        version: 3,
        id: SESSION_ID,
        cwd: '/tmp/repo',
        timestamp: '2026-08-06T04:29:02.524Z',
      },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-08-06T04:29:04.986Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      },
      {
        type: 'brand_new_unknown_event',
        id: 'x1',
        parentId: 'u1',
        timestamp: '2026-08-06T04:29:05.000Z',
        data: { odd: true },
      },
    ];
    await writeFile(
      sessionPath,
      `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`
    );
    const adapter = new PiStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-06T00:10:00.000Z'),
    });

    const result = await adapter.importSession({
      provider: 'pi',
      nativeId: SESSION_ID,
      sourcePath: sessionPath,
    });
    const marker = result.session.turns[0]?.items[0];
    expect(marker).toMatchObject({
      type: 'providerExtension',
      payload: expect.objectContaining({
        event: 'native-session-imported',
        unmappedEventTypes: { brand_new_unknown_event: 1 },
      }),
    });
    // The unknown record contributed no turn items beyond the audit marker.
    const nonAuditTurns = result.session.turns.filter(
      (t) => t.id !== 'native-import-audit'
    );
    expect(nonAuditTurns).toHaveLength(1);
    expect(nonAuditTurns[0]?.items.map((i) => i.type)).toContain('userMessage');
    // The unknown record's payload must not leak into the imported transcript;
    // only the audit marker carries the gap attribution.
    const transcriptWithoutMarker = JSON.stringify(
      nonAuditTurns.map((t) => t.items)
    );
    expect(transcriptWithoutMarker).not.toContain('odd');
    expect(transcriptWithoutMarker).not.toContain('brand_new_unknown_event');
  });

  it('trims oversized imports FIFO while preserving the audit marker and reporting truncation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-pi-large-'));
    const bucket = path.join(root, piSessionDirSlug('/tmp/repo'));
    await mkdir(bucket, { recursive: true });
    const sessionPath = path.join(bucket, `large_${SESSION_ID}.jsonl`);
    const lines = [
      {
        type: 'session',
        version: 3,
        id: SESSION_ID,
        cwd: '/tmp/repo',
        timestamp: '2026-08-06T04:29:02.524Z',
      },
      ...Array.from({ length: 24 }, (_, index) => ({
        type: 'message',
        id: `large-user-${index}`,
        parentId: index === 0 ? null : `large-user-${index - 1}`,
        timestamp: `2026-08-06T04:${String(index + 30).padStart(2, '0')}:00.000Z`,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: `message-${index}:${'x'.repeat(20_000)}` },
          ],
        },
      })),
    ];
    await writeFile(
      sessionPath,
      `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`
    );
    const adapter = new PiStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-06T01:30:00.000Z'),
    });

    const result = await adapter.importSession({
      provider: 'pi',
      nativeId: SESSION_ID,
      sourcePath: sessionPath,
    });

    expect(result.session.turns[0]?.id).toBe('native-import-audit');
    expect(result.importTruncation).toMatchObject({
      truncated: true,
      droppedTurns: expect.any(Number),
    });
    expect(result.session.config.providerOptions?.importTruncation).toEqual(
      result.importTruncation
    );
    expect(JSON.stringify(result.session)).not.toContain('message-0:');
    expect(JSON.stringify(result.session)).toContain('message-23:');
    expect(result.session.turns.length).toBeLessThan(lines.length);
  });

  it('returns bounded provider snapshots and copyable resume argv without executing it', async () => {
    const { root, sessionPath } = await writePiFixture();
    const adapter = new PiStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-06T00:10:00.000Z'),
    });

    const snapshot = await adapter.readProviderState({
      provider: 'pi',
      nativeId: SESSION_ID,
      sourcePath: sessionPath,
    });

    expect(snapshot.ref).toMatchObject({
      provider: 'pi',
      nativeId: SESSION_ID,
    });
    expect(snapshot.redaction).toEqual({
      rawPayloadStored: false,
      strategy: 'preview',
      classes: ['credential', 'secret', 'payload', 'transcript'],
    });
    expect(snapshot.summary).toMatchObject({
      lineCount: 6,
      byteCount: expect.any(Number),
      hashSha256: expect.any(String),
      eventTypes: [
        'message',
        'model_change',
        'session',
        'thinking_level_change',
      ],
      firstTimestamp: '2026-08-06T04:29:02.524Z',
      lastTimestamp: '2026-08-06T04:29:10.259Z',
    });
    expect(
      adapter.resumeCommand({ provider: 'pi', nativeId: SESSION_ID })
    ).toEqual(['pi', '--resume', SESSION_ID]);
  });

  it('reports honest capabilities including live streaming', () => {
    const adapter = new PiStateAdapter({ stateRoot: '/tmp/pi' });
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
});

describe('normalizePiLiveEvent via NativeSessionLiveTailManager', () => {
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

  it('streams a live-tail cursor fixture in order onto the scoped topic', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-pi-tail-'));
    const file = path.join(root, `tail_${SESSION_ID}.jsonl`);
    const lines = [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: SESSION_ID,
        timestamp: '2026-08-06T04:29:02.524Z',
        cwd: '/tmp/repo',
      }),
      JSON.stringify({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-08-06T04:29:04.986Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'check the token=abc123 setup' }],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-08-06T04:29:09.947Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'inspecting files' },
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'bash',
              arguments: { command: 'ls' },
            },
            { type: 'text', text: 'done looking' },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'r1',
        parentId: 'a1',
        timestamp: '2026-08-06T04:29:10.259Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'tool finished' }],
        },
      }),
    ];
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8');

    const bus = createCliGatewayEventBus();
    const collected = collect(bus);
    const manager = makeManager(root, bus);
    manager.watch({ provider: 'pi', nativeId: SESSION_ID, sourcePath: file });
    // Deterministic single poll instead of waiting on the interval; also
    // proves durable cursors resume without replay: the second manager shares
    // only the cursor store and must consume no new bytes.
    manager.pollAll();
    manager.stopAll();

    const resumed = makeManager(root, bus);
    resumed.watch({ provider: 'pi', nativeId: SESSION_ID, sourcePath: file });
    resumed.pollAll();
    resumed.stopAll();

    // Restart consumed no new bytes -> exactly the first poll's events, in order.
    expect(collected.events).toEqual([
      {
        kind: 'session-started',
        nativeId: SESSION_ID,
        text: '',
        providerEvent: 'session',
      },
      {
        kind: 'user-message',
        nativeId: SESSION_ID,
        text: 'check the token=[redacted] setup',
        providerEvent: 'message:user',
      },
      {
        kind: 'reasoning',
        nativeId: SESSION_ID,
        text: 'inspecting files',
        providerEvent: 'message:assistant',
      },
      {
        kind: 'tool-call',
        nativeId: SESSION_ID,
        text: 'bash ls',
        providerEvent: 'message:assistant',
      },
      {
        kind: 'assistant-message',
        nativeId: SESSION_ID,
        text: 'done looking',
        providerEvent: 'message:assistant',
      },
      {
        kind: 'tool-result',
        nativeId: SESSION_ID,
        text: 'tool finished',
        providerEvent: 'message:toolResult',
      },
    ]);
  });

  it('publishes explicit gaps for metadata records and unknown events — never silent drops', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-pi-tail-gap-'));
    const file = path.join(root, `gap_${SESSION_ID}.jsonl`);
    const lines = [
      JSON.stringify({
        type: 'model_change',
        id: 'm1',
        parentId: null,
        timestamp: '2026-08-06T04:29:03.494Z',
        modelId: 'gpt-test',
      }),
      JSON.stringify({
        type: 'future_unknown_type',
        id: 'z1',
        parentId: 'm1',
        timestamp: '2026-08-06T04:29:04.000Z',
      }),
    ];
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8');

    const bus = createCliGatewayEventBus();
    const collected = collect(bus);
    const manager = makeManager(root, bus);
    manager.watch({ provider: 'pi', nativeId: SESSION_ID, sourcePath: file });
    manager.pollAll();
    manager.stopAll();

    expect(collected.events).toEqual([
      {
        kind: 'gap',
        nativeId: SESSION_ID,
        text: '',
        providerEvent: 'model_change',
      },
      {
        kind: 'gap',
        nativeId: SESSION_ID,
        text: '',
        providerEvent: 'future_unknown_type',
      },
    ]);
  });
});
