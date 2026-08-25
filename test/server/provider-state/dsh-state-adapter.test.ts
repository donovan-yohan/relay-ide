import {
  mkdtemp,
  mkdir,
  appendFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
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
  DshStateAdapter,
  dshProjectSlug,
} from '../../../server/provider-state/dsh-state-adapter.js';

// Synthetic fixtures shaped like real DeepSeek Harness session stores (#1426):
// <stateRoot>/<project-slug>/session-<uuid>/session.jsonl.zstd where the log is
// CONCATENATED zstd frames of JSONL records. Fixtures are generated in-test via
// node:zlib zstdCompressSync (one frame per batch); the real ~/.dsh store is
// never read by tests.
const SESSION_ID = 'session-4b762458-d2e0-4ac4-8777-a6e3f239f296';

interface DshRecord {
  type: string;
  seq?: number;
  time?: number;
  data?: unknown;
}

function frameRecords(records: DshRecord[]): Buffer {
  const plaintext = `${records
    .map((record) => JSON.stringify(record))
    .join('\n')}\n`;
  return zstdCompressSync(Buffer.from(plaintext, 'utf8'));
}

function headerRecord(): DshRecord {
  return {
    type: 'session',
    version: 0,
    id: SESSION_ID,
    createdAt: 1787593028737,
    cwd: '/tmp/repo',
    delegationDepth: 0,
  };
}

async function writeDshFixture(
  frames: DshRecord[][],
  sessionId: string = SESSION_ID
): Promise<{ root: string; sessionPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-dsh-state-'));
  const bucket = path.join(root, dshProjectSlug('/tmp/repo'));
  await mkdir(path.join(bucket, sessionId), { recursive: true });
  const sessionPath = path.join(bucket, sessionId, 'session.jsonl.zstd');
  await writeFile(sessionPath, Buffer.concat(frames.map(frameRecords)));
  return { root, sessionPath };
}

function standardFrames(): DshRecord[][] {
  return [
    [headerRecord()],
    [
      {
        type: 'permission/preset',
        seq: 0,
        time: 1787593028740,
        data: { preset: 'workspace-write' },
      },
      {
        type: 'sandbox/mode',
        seq: 1,
        time: 1787593028741,
        data: { mode: 'workspace-write' },
      },
      {
        type: 'turn/start',
        seq: 2,
        time: 1787593028743,
        data: { turn: 1 },
      },
      {
        type: 'user/message',
        seq: 3,
        time: 1787593028822,
        data: {
          content: [
            { type: 'text', text: 'please check the api_key=secret123 setup' },
          ],
          source: { kind: 'user' },
          role: 'user',
          id: '176f31ee-43a2-4b75-821a-4a1153e48058',
        },
      },
      // Harness-internal user-role injection must NOT become a user turn.
      {
        type: 'user/message',
        seq: 4,
        time: 1787593028823,
        data: {
          content: [{ type: 'text', text: 'plugin snapshot payload' }],
          source: {
            kind: 'plugin',
            plugin: '@deepseek-ai/dsh-system-prompt',
            form: 'snapshot',
          },
          role: 'user',
        },
      },
      {
        type: 'reasoning-chunks',
        seq: 5,
        time: 1787593057000,
        data: {
          turn: 1,
          step: 1,
          index: 0,
          dt: [25, 26],
          texts: ['need to inspect ', 'files first'],
        },
      },
      {
        type: 'assistant/chunk',
        seq: 6,
        time: 1787593057343,
        data: {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'DSH-' },
        },
      },
      {
        type: 'assistant/message',
        seq: 7,
        time: 1787593057344,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'the dsh adapter can read framed zstd safely',
              },
            ],
            id: '4abce271-10d3-4724-a6b3-81e87f029a90',
          },
          usage: { inputTokens: 12611, outputTokens: 8 },
        },
      },
      {
        type: 'turn/end',
        seq: 8,
        time: 1787593057345,
        data: { turn: 1, reason: { kind: 'completed' } },
      },
    ],
  ];
}

describe('DshStateAdapter', () => {
  it('reports installed status when the sessions directory exists and is readable', async () => {
    const { root } = await writeDshFixture(standardFrames());
    const adapter = new DshStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-24T00:10:00.000Z'),
    });

    await expect(adapter.detectInstall()).resolves.toMatchObject({
      provider: 'dsh',
      status: 'installed',
      stateRoots: [root],
    });
  });

  it('reports unavailable status when state root does not exist', async () => {
    const adapter = new DshStateAdapter({
      stateRoot: '/nonexistent/path/that/does/not/exist/.dsh/sessions',
      now: () => new Date('2026-01-01T00:10:00.000Z'),
    });

    const status = await adapter.detectInstall();
    expect(status.provider).toBe('dsh');
    expect(status.status).toBe('unavailable');
    expect(status.diagnostics[0]?.code).toBe('DSH_STATE_ROOT_NOT_FOUND');
  });

  it('decodes multi-frame logs into summaries with redacted previews and honest capabilities', async () => {
    const { root, sessionPath } = await writeDshFixture(standardFrames());
    const adapter = new DshStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-24T00:10:00.000Z'),
    });

    const sessions = await adapter.listNativeSessions({ cwd: '/tmp/repo' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: 'dsh',
      nativeId: SESSION_ID,
      sourcePath: sessionPath,
      cwd: '/tmp/repo',
      createdAt: new Date(1787593028737).toISOString(),
      lastMessageAt: new Date(1787593057345).toISOString(),
      capabilities: {
        canImportTranscript: true,
        canReadProviderState: true,
        canResumeNative: true,
        canStreamLiveEvents: true,
        readOnly: true,
      },
    });
    expect(sessions[0]?.title).toBeUndefined();
    // First real user message wins over harness-internal injections.
    expect(sessions[0]?.preview.source).toBe('transcript');
    expect(sessions[0]?.preview.text).toContain('api_key=[redacted]');
    expect(sessions[0]?.preview.redacted).toBe(true);

    // Scope filtering: a different cwd matches nothing (no such bucket).
    expect(await adapter.listNativeSessions({ cwd: '/other/repo' })).toEqual(
      []
    );
  });

  it('prefers the latest session/title record for title and metadata preview', async () => {
    const frames: DshRecord[][] = [
      [headerRecord()],
      [
        {
          type: 'session/title',
          seq: 11,
          time: 1787593028823,
          data: {
            title: 'Reply with exactly DSH-RC2-OK and',
            messageSeqs: [3],
          },
        },
      ],
    ];
    const { root } = await writeDshFixture(frames);
    const adapter = new DshStateAdapter({ stateRoot: root });

    const sessions = await adapter.listNativeSessions();
    expect(sessions[0]?.title).toBe('Reply with exactly DSH-RC2-OK and');
    expect(sessions[0]?.preview).toMatchObject({
      source: 'metadata',
      redacted: false,
    });
  });

  it('skips torn trailing frames gracefully without failing the whole listing', async () => {
    const { root, sessionPath } = await writeDshFixture(standardFrames());
    const full = frameRecords([
      {
        type: 'turn/start',
        seq: 20,
        time: 1787593060000,
        data: { turn: 2 },
      },
      {
        type: 'user/message',
        seq: 21,
        time: 1787593060100,
        data: {
          content: [{ type: 'text', text: 'second turn message' }],
          source: { kind: 'user' },
          role: 'user',
        },
      },
    ]);
    // Simulate an incremental writer torn mid-frame: keep only half the bytes.
    await appendFile(
      sessionPath,
      full.subarray(0, Math.floor(full.length / 2))
    );

    const adapter = new DshStateAdapter({ stateRoot: root });
    const sessions = await adapter.listNativeSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.nativeId).toBe(SESSION_ID);
    // The torn frame's records are not visible yet; last record stays turn 1.
    expect(sessions[0]?.lastMessageAt).toBe(
      new Date(1787593057345).toISOString()
    );

    // Once the writer closes the frame, the same file lists cleanly.
    await appendFile(sessionPath, full.subarray(Math.floor(full.length / 2)));
    const after = await adapter.listNativeSessions();
    expect(after[0]?.lastMessageAt).toBe(new Date(1787593060100).toISOString());
  });

  it('rejects caller-provided source paths outside the configured state root', async () => {
    const { root } = await writeDshFixture(standardFrames());
    const outsideRoot = await mkdtemp(
      path.join(tmpdir(), 'relay-dsh-outside-')
    );
    const outsidePath = path.join(outsideRoot, 'escape.jsonl.zstd');
    await writeFile(outsidePath, Buffer.from('{}\n'));
    const adapter = new DshStateAdapter({ stateRoot: root });

    await expect(
      adapter.readProviderState({
        provider: 'dsh',
        nativeId: 'escape',
        sourcePath: path.join(
          root,
          '..',
          path.basename(outsideRoot),
          'escape.jsonl.zstd'
        ),
      })
    ).rejects.toThrow(/state root/i);
  });

  it('rejects non-zstd and symlink source paths even when they appear inside the state root', async () => {
    const { root } = await writeDshFixture(standardFrames());
    const sessionId = SESSION_ID;
    const plainPath = path.join(
      root,
      dshProjectSlug('/tmp/repo'),
      sessionId,
      'plain.txt'
    );
    await writeFile(plainPath, 'not zstd\n');
    const outsideRoot = await mkdtemp(
      path.join(tmpdir(), 'relay-dsh-symlink-')
    );
    const outsidePath = path.join(outsideRoot, 'outside.jsonl.zstd');
    await writeFile(outsidePath, Buffer.alloc(8));
    const linkPath = path.join(
      root,
      dshProjectSlug('/tmp/repo'),
      sessionId,
      'linked-outside.jsonl.zstd'
    );
    await symlink(outsidePath, linkPath);
    const adapter = new DshStateAdapter({ stateRoot: root });

    await expect(
      adapter.readProviderState({
        provider: 'dsh',
        nativeId: 'not-json',
        sourcePath: plainPath,
      })
    ).rejects.toThrow(/zstd/i);
    await expect(
      adapter.readProviderState({
        provider: 'dsh',
        nativeId: 'outside',
        sourcePath: linkPath,
      })
    ).rejects.toThrow(/symlink/i);
  });

  it('imports a multi-frame fixture into an AgentSessionV2 read model with an audit marker', async () => {
    const { root, sessionPath } = await writeDshFixture(standardFrames());
    const adapter = new DshStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-24T00:10:00.000Z'),
    });

    const result = await adapter.importSession({
      provider: 'dsh',
      nativeId: SESSION_ID,
      sourcePath: sessionPath,
    });

    expect(result.provider).toBe('dsh');
    expect(result.nativeId).toBe(SESSION_ID);
    expect(result.session.provider).toBe('dsh');
    expect(result.session.providerSession).toMatchObject({
      nativeId: SESSION_ID,
      sourcePath: sessionPath,
      stateKind: 'dsh-jsonl-zstd',
    });
    expect(result.session.turns[0]?.items[0]).toMatchObject({
      type: 'providerExtension',
      namespace: 'provider-state-import',
      payload: {
        event: 'native-session-imported',
        sourceProvider: 'dsh',
        importSource: 'dsh-jsonl-zstd',
        readOnly: true,
      },
    });

    // Exactly one non-audit turn: the real user message. Plugin injections
    // contribute nothing; assistant consolidation + reasoning fold in.
    const nonAuditTurns = result.session.turns.filter(
      (t) => t.id !== 'native-import-audit'
    );
    expect(nonAuditTurns).toHaveLength(1);
    expect(nonAuditTurns[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'userMessage',
          text: expect.stringContaining('api_key=[redacted]'),
        }),
        expect.objectContaining({
          type: 'reasoning',
          summary: 'need to inspect files first',
        }),
        expect.objectContaining({
          type: 'assistantMessage',
          text: 'the dsh adapter can read framed zstd safely',
        }),
      ])
    );

    // Secrets never survive import; chunk deltas are attributed as folded gaps.
    expect(JSON.stringify(result.session)).not.toContain('secret123');
    expect(result.session.turns[0]?.items[0]).toMatchObject({
      payload: expect.objectContaining({
        unmappedEventTypes: expect.objectContaining({
          'user/message:plugin': 1,
          'assistant/chunk:folded-into-assistant-message': 1,
        }),
      }),
    });
    expect(result.patches).toHaveLength(1);
    expect(result.patches.every(isAgentPatchV2)).toBe(true);

    // Deterministic mapping: same input, same patches.
    const second = await adapter.importSession({
      provider: 'dsh',
      nativeId: SESSION_ID,
      sourcePath: sessionPath,
    });
    expect(second.session.id).toBe(result.session.id);
    expect(second.session.turns).toEqual(result.session.turns);
  });

  it('trims oversized imports FIFO while preserving the audit marker and reporting truncation', async () => {
    const bigUser = (index: number, time: number): DshRecord => ({
      type: 'user/message',
      seq: index,
      time,
      data: {
        content: [
          { type: 'text', text: `message-${index}:${'x'.repeat(20_000)}` },
        ],
        source: { kind: 'user' },
        role: 'user',
      },
    });
    const frames: DshRecord[][] = [
      [headerRecord()],
      Array.from({ length: 24 }, (_, index) =>
        bigUser(index, 1787593100000 + index)
      ),
    ];
    const { root, sessionPath } = await writeDshFixture(frames);
    const adapter = new DshStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-24T01:30:00.000Z'),
    });

    const result = await adapter.importSession({
      provider: 'dsh',
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
    expect(result.session.turns.length).toBeLessThan(frames.flat().length);
  });

  it('returns bounded provider snapshots and copyable resume argv without executing it', async () => {
    const { root, sessionPath } = await writeDshFixture(standardFrames());
    const adapter = new DshStateAdapter({
      stateRoot: root,
      now: () => new Date('2026-08-24T00:10:00.000Z'),
    });

    const snapshot = await adapter.readProviderState({
      provider: 'dsh',
      nativeId: SESSION_ID,
      sourcePath: sessionPath,
    });

    expect(snapshot.ref).toMatchObject({
      provider: 'dsh',
      nativeId: SESSION_ID,
    });
    expect(snapshot.redaction).toEqual({
      rawPayloadStored: false,
      strategy: 'preview',
      classes: ['credential', 'secret', 'payload', 'transcript'],
    });
    expect(snapshot.summary.eventTypes).toEqual([
      'assistant/chunk',
      'assistant/message',
      'permission/preset',
      'reasoning-chunks',
      'sandbox/mode',
      'session',
      'turn/end',
      'turn/start',
      'user/message',
    ]);
    expect(snapshot.summary.firstTimestamp).toBe(
      new Date(1787593028740).toISOString()
    );
    expect(snapshot.summary.lastTimestamp).toBe(
      new Date(1787593057345).toISOString()
    );
    expect(
      adapter.resumeCommand({ provider: 'dsh', nativeId: SESSION_ID })
    ).toEqual(['dsh', '--resume', SESSION_ID]);
  });

  it('reports honest capabilities including live streaming', () => {
    const adapter = new DshStateAdapter({ stateRoot: '/tmp/dsh' });
    expect(adapter.capabilities).toEqual({
      canImportTranscript: true,
      canReadProviderState: true,
      canResumeNative: true,
      canStreamLiveEvents: true,
      canRespondToApprovals: false,
      canExposeToolCalls: false,
      readOnly: true,
    });
  });
});

describe('normalizeDshLiveEvent via NativeSessionLiveTailManager', () => {
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

  function tailFrame(records: DshRecord[]): Buffer {
    return frameRecords(records);
  }

  it('streams appended complete frames in order onto the scoped topic with durable cursors across restart', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-dsh-tail-'));
    const bucket = path.join(root, dshProjectSlug('/tmp/repo'), SESSION_ID);
    await mkdir(bucket, { recursive: true });
    const file = path.join(bucket, 'session.jsonl.zstd');

    // Frame 1: header + first user turn. Written before watch starts.
    await writeFile(
      file,
      tailFrame([
        headerRecord(),
        {
          type: 'user/message',
          seq: 3,
          time: 1787593028822,
          data: {
            content: [{ type: 'text', text: 'check the token=abc123 setup' }],
            source: { kind: 'user' },
            role: 'user',
          },
        },
      ])
    );

    const bus = createCliGatewayEventBus();
    const collected = collect(bus);
    const manager = makeManager(root, bus);
    manager.watch({ provider: 'dsh', nativeId: SESSION_ID, sourcePath: file });
    manager.pollAll();

    // Frame 2: reasoning + consolidated assistant message, appended later.
    await appendFile(
      file,
      tailFrame([
        {
          type: 'reasoning-chunks',
          seq: 5,
          time: 1787593057000,
          data: { texts: ['thinking about files'] },
        },
        {
          type: 'assistant/message',
          seq: 7,
          time: 1787593057344,
          data: {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'all done looking' }],
            },
          },
        },
      ])
    );
    manager.pollAll();
    manager.stopAll();

    // A fresh manager sharing ONLY the durable cursor store must consume no
    // new bytes — no replay, no gap (#1428 restart semantics).
    const resumed = makeManager(root, bus);
    resumed.watch({ provider: 'dsh', nativeId: SESSION_ID, sourcePath: file });
    resumed.pollAll();
    resumed.stopAll();

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
        providerEvent: 'user/message:user',
      },
      {
        kind: 'reasoning',
        nativeId: SESSION_ID,
        text: 'thinking about files',
        providerEvent: 'reasoning-chunks',
      },
      {
        kind: 'assistant-message',
        nativeId: SESSION_ID,
        text: 'all done looking',
        providerEvent: 'assistant/message',
      },
    ]);
  });

  it('holds back a torn trailing frame until a later poll observes it complete', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-dsh-torn-tail-'));
    const bucket = path.join(root, dshProjectSlug('/tmp/repo'), SESSION_ID);
    await mkdir(bucket, { recursive: true });
    const file = path.join(bucket, 'session.jsonl.zstd');
    await writeFile(file, tailFrame([headerRecord()]));

    const pending = tailFrame([
      {
        type: 'user/message',
        seq: 3,
        time: 1787593028822,
        data: {
          content: [{ type: 'text', text: 'torn frame message' }],
          source: { kind: 'user' },
          role: 'user',
        },
      },
    ]);

    const bus = createCliGatewayEventBus();
    const collected = collect(bus);
    const manager = makeManager(root, bus);
    manager.watch({ provider: 'dsh', nativeId: SESSION_ID, sourcePath: file });
    // First poll consumes the complete header frame (cursor -> end of frame 1).
    manager.pollAll();
    expect(collected.events).toEqual([
      {
        kind: 'session-started',
        nativeId: SESSION_ID,
        text: '',
        providerEvent: 'session',
      },
    ]);

    // Torn write: half the NEXT frame lands; the poll must emit NOTHING from it.
    await appendFile(file, pending.subarray(0, Math.floor(pending.length / 2)));
    manager.pollAll();
    expect(collected.events).toEqual([
      {
        kind: 'session-started',
        nativeId: SESSION_ID,
        text: '',
        providerEvent: 'session',
      },
    ]);

    // The writer closes the frame; now the poll sees exactly the new event.
    await appendFile(file, pending.subarray(Math.floor(pending.length / 2)));
    manager.pollAll();
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
        text: 'torn frame message',
        providerEvent: 'user/message:user',
      },
    ]);
    manager.stopAll();
  });

  it('publishes explicit attributed gaps for metadata records — never silent drops', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-dsh-gap-'));
    const bucket = path.join(root, dshProjectSlug('/tmp/repo'), SESSION_ID);
    await mkdir(bucket, { recursive: true });
    const file = path.join(bucket, 'session.jsonl.zstd');
    await writeFile(
      file,
      tailFrame([
        {
          type: 'permission/preset',
          seq: 0,
          time: 1787593028740,
          data: { preset: 'workspace-write' },
        },
        {
          type: 'assistant/chunk',
          seq: 6,
          time: 1787593057343,
          data: {
            chunk: { type: 'text-delta', index: 0, text: 'partial' },
          },
        },
        {
          type: 'brand_new_unknown_event',
          seq: 99,
          time: 1787593099000,
          data: { odd: true },
        },
      ])
    );

    const bus = createCliGatewayEventBus();
    const collected = collect(bus);
    const manager = makeManager(root, bus);
    manager.watch({ provider: 'dsh', nativeId: SESSION_ID, sourcePath: file });
    manager.pollAll();
    manager.stopAll();

    expect(collected.events).toEqual([
      {
        kind: 'gap',
        nativeId: SESSION_ID,
        text: '',
        providerEvent: 'permission/preset',
      },
      {
        kind: 'gap',
        nativeId: SESSION_ID,
        text: '',
        providerEvent: 'assistant/chunk:folded-into-assistant-message',
      },
      {
        kind: 'gap',
        nativeId: SESSION_ID,
        text: '',
        providerEvent: 'brand_new_unknown_event',
      },
    ]);
  });
});
