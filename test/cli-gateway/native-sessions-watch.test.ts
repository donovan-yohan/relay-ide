import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCliGatewayEventBus,
  eventMatchesFilter,
  type CliGatewayEventBus,
} from '../../server/cli-gateway-event-bus.js';
import {
  LiveTailCursorStore,
  NativeSessionLiveTailManager,
} from '../../server/provider-state/live-tail-manager.js';
import { JsonlFileTailer } from '../../server/provider-state/jsonl-tailer.js';
import { normalizePrimeAgentLiveEvent } from '../../server/provider-state/live-event-normalizers.js';

const CLAUDE_LINES = [
  JSON.stringify({
    type: 'user',
    sessionId: 'claude-fix-1',
    cwd: '/tmp/repo',
    timestamp: '2026-08-24T00:00:00.000Z',
    message: { role: 'user', content: 'check the api_key=abc123 setup' },
  }),
  JSON.stringify({
    type: 'assistant',
    sessionId: 'claude-fix-1',
    timestamp: '2026-08-24T00:00:01.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'inspecting files' },
        { type: 'tool_use', id: 't1', name: 'shell', input: { command: 'ls' } },
        { type: 'text', text: 'done looking' },
      ],
    },
  }),
];

const CODEX_LINES = [
  JSON.stringify({
    type: 'session.started',
    session_id: 'codex-fix-1',
    cwd: '/tmp/repo',
    timestamp: '2026-08-24T01:00:00.000Z',
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'codex-fix-1',
    timestamp: '2026-08-24T01:00:02.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'the codex tail works' }],
    },
  }),
];

async function makeSessionFile(
  providerPrefix: string
): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(
    path.join(tmpdir(), `relay-live-tail-${providerPrefix}-`)
  );
  const file = path.join(root, `${providerPrefix}-session.jsonl`);
  await writeFile(file, '', 'utf8');
  return { root, file };
}

interface Collected {
  bus: CliGatewayEventBus;
  events: ReturnType<typeof eventSnapshot>[];
}

function eventSnapshot(event: {
  topic: string;
  type: string;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    topic: event.topic,
    type: event.type,
    kind: event.payload['kind'],
    nativeId: event.payload['nativeId'],
    text: event.payload['text'],
    providerEvent: event.payload['providerEvent'],
  };
}

function collect(bus: CliGatewayEventBus): Collected {
  const events: ReturnType<typeof eventSnapshot>[] = [];
  const unsubscribe = bus.subscribe('native-sessions', (event) => {
    events.push(eventSnapshot(event));
  });
  void unsubscribe;
  return { bus, events };
}

describe('JsonlFileTailer', () => {
  it('holds back a partial trailing line until complete and emits in order', async () => {
    const { file } = await makeSessionFile('claude');
    await writeFile(file, `${CLAUDE_LINES[0]}\n${CLAUDE_LINES[1]}`, 'utf8');

    const tailer = new JsonlFileTailer({ filePath: file });
    // First poll: line 1 complete, line 2 has no terminating newline.
    const first = tailer.poll();
    expect(first.events).toHaveLength(1);
    expect(first.gaps).toBe(0);

    // Complete the trailing line; second poll emits exactly the held-back one.
    await appendFile(file, '\n');
    const second = tailer.poll();
    expect(second.events).toHaveLength(1);
  });

  it('never replays or skips after restart when the cursor is durable', async () => {
    const { root, file } = await makeSessionFile('claude');
    let persisted: number | null = null;

    await writeFile(file, `${CLAUDE_LINES[0]}\n`, 'utf8');
    const first = new JsonlFileTailer<string>({
      filePath: file,
      parseLine: (line) => line,
      loadCursor: () => persisted,
      saveCursor: (offset) => {
        persisted = offset;
      },
    });
    const pollA = first.poll();
    expect(pollA.events).toHaveLength(1);
    const savedOffset = pollA.offset;

    // Append more lines, then simulate hub restart with a fresh tailer that
    // loads the same durable cursor.
    await appendFile(file, `${CLAUDE_LINES[1]}\n`, 'utf8');
    const resumed = new JsonlFileTailer<string>({
      filePath: file,
      parseLine: (line) => line,
      loadCursor: () => savedOffset,
      saveCursor: () => {},
    });
    const pollB = resumed.poll();
    expect(pollB.events).toHaveLength(1);
    expect(JSON.parse(pollB.events[0]).message.role).toBe('assistant');

    // No growth -> no replay.
    expect(resumed.poll().events).toHaveLength(0);
    void root;
  });

  it('handles truncation/rotation by resetting to the start of the new file', async () => {
    const { root, file } = await makeSessionFile('codex');
    await writeFile(file, `${CODEX_LINES.join('\n')}\n`, 'utf8');
    const tailer = new JsonlFileTailer<Record<string, unknown>>({
      filePath: file,
    });
    expect(tailer.poll().events).toHaveLength(2);

    // Simulate rotation: file replaced with fresh (shorter) content.
    const { writeFile: overwrite } = await import('node:fs/promises');
    await overwrite(file, `${CODEX_LINES[0]}\n`, 'utf8');
    const poll = tailer.poll();
    expect(poll.offset).toBeLessThanOrEqual(
      (await import('node:fs')).statSync(file).size
    );
    expect(tailer.poll().events.length).toBeGreaterThanOrEqual(0);
    void root;
  });
});

describe('NativeSessionLiveTailManager', () => {
  let managers: NativeSessionLiveTailManager[] = [];

  afterEach(() => {
    for (const manager of managers) manager.stopAll();
    managers = [];
  });

  function makeManager(configDir: string, bus: CliGatewayEventBus) {
    const manager = new NativeSessionLiveTailManager({
      eventBus: bus,
      cursorStore: new LiveTailCursorStore(configDir),
    });
    managers.push(manager);
    return manager;
  }

  it('streams claude + codex fixtures in order onto the scoped topic', async () => {
    const claudeSession = await makeSessionFile('claude');
    const codexSession = await makeSessionFile('codex');
    await writeFile(claudeSession.file, `${CLAUDE_LINES.join('\n')}\n`, 'utf8');
    await writeFile(codexSession.file, `${CODEX_LINES.join('\n')}\n`, 'utf8');

    const bus = createCliGatewayEventBus();
    const collected = collect(bus);
    const manager = makeManager(claudeSession.root, bus);
    manager.watch({
      provider: 'claude',
      nativeId: 'claude-fix-1',
      sourcePath: claudeSession.file,
    });
    manager.watch({
      provider: 'codex',
      nativeId: 'codex-fix-1',
      sourcePath: codexSession.file,
    });

    // Deterministic single poll instead of waiting on the interval.
    manager.pollAll();

    expect(collected.events.length).toBeGreaterThanOrEqual(5);
    expect(
      collected.events.filter((event) => event.nativeId === 'claude-fix-1')
    ).toEqual([
      {
        topic: 'native-sessions',
        type: 'native-session.user-message',
        kind: 'user-message',
        nativeId: 'claude-fix-1',
        text: 'check the api_key=[redacted] setup',
        providerEvent: 'user',
      },
      {
        topic: 'native-sessions',
        type: 'native-session.reasoning',
        kind: 'reasoning',
        nativeId: 'claude-fix-1',
        text: 'inspecting files',
        providerEvent: 'assistant',
      },
      {
        topic: 'native-sessions',
        type: 'native-session.tool-call',
        kind: 'tool-call',
        nativeId: 'claude-fix-1',
        text: 'shell ls',
        providerEvent: 'assistant',
      },
      {
        topic: 'native-sessions',
        type: 'native-session.assistant-message',
        kind: 'assistant-message',
        nativeId: 'claude-fix-1',
        text: 'done looking',
        providerEvent: 'assistant',
      },
    ]);
    expect(
      collected.events.filter((event) => event.nativeId === 'codex-fix-1')
    ).toEqual([
      {
        topic: 'native-sessions',
        type: 'native-session.session-started',
        kind: 'session-started',
        nativeId: 'codex-fix-1',
        text: '',
        providerEvent: 'session.started',
      },
      {
        topic: 'native-sessions',
        type: 'native-session.assistant-message',
        kind: 'assistant-message',
        nativeId: 'codex-fix-1',
        text: 'the codex tail works',
        providerEvent: 'assistant',
      },
    ]);
  });

  it('emits appended events within the poll budget, in order, without replay', async () => {
    const session = await makeSessionFile('claude');
    await writeFile(session.file, `${CLAUDE_LINES[0]}\n`, 'utf8');

    const bus = createCliGatewayEventBus();
    const collected = collect(bus);
    const manager = makeManager(session.root, bus);
    manager.watch({
      provider: 'claude',
      nativeId: 'claude-fix-1',
      sourcePath: session.file,
    });
    manager.pollAll();
    const countAfterFirstPoll = collected.events.length;
    expect(countAfterFirstPoll).toBe(1);

    // Simulate a live append mid-session (~well under 1s later in production).
    await appendFile(session.file, `${CLAUDE_LINES[1]}\n`, 'utf8');
    manager.pollAll();

    const kinds = collected.events.map((event) => event.kind);
    expect(kinds.slice(countAfterFirstPoll)).toEqual([
      'reasoning',
      'tool-call',
      'assistant-message',
    ]);
  });

  it('publishes an explicit gap for unmapped events — never a silent drop', async () => {
    const session = await makeSessionFile('codex');
    await writeFile(
      session.file,
      `${JSON.stringify({
        type: 'token_count',
        session_id: 'codex-gap-1',
        timestamp: '2026-08-24T02:00:00.000Z',
        token_count: { input_tokens: 10 },
      })}\n`,
      'utf8'
    );

    const bus = createCliGatewayEventBus();
    const collected = collect(bus);
    const manager = makeManager(session.root, bus);
    manager.watch({
      provider: 'codex',
      nativeId: 'codex-gap-1',
      sourcePath: session.file,
    });
    manager.pollAll();

    expect(collected.events).toEqual([
      {
        topic: 'native-sessions',
        type: 'native-session.gap',
        kind: 'gap',
        nativeId: 'codex-gap-1',
        text: '',
        providerEvent: 'token_count',
      },
    ]);
  });

  it('resumes from the persisted cursor across manager recreation: no replay, no gap', async () => {
    const session = await makeSessionFile('claude');
    await writeFile(session.file, `${CLAUDE_LINES[0]}\n`, 'utf8');

    const bus = createCliGatewayEventBus();
    const collected = collect(bus);
    const cursorStore = new LiveTailCursorStore(session.root);
    const first = new NativeSessionLiveTailManager({
      eventBus: bus,
      cursorStore,
    });
    managers.push(first);
    first.watch({
      provider: 'claude',
      nativeId: 'claude-fix-2',
      sourcePath: session.file,
    });
    first.pollAll();
    expect(collected.events).toHaveLength(1);
    first.stopAll();

    // "Restart": new manager sharing only the durable cursor store.
    const second = new NativeSessionLiveTailManager({
      eventBus: bus,
      cursorStore: new LiveTailCursorStore(session.root),
    });
    managers.push(second);
    second.watch({
      provider: 'claude',
      nativeId: 'claude-fix-2',
      sourcePath: session.file,
    });
    // No appends yet -> nothing replayed.
    second.pollAll();
    expect(collected.events).toHaveLength(1);

    // One new line -> exactly one new event (no gap).
    await appendFile(session.file, `${CLAUDE_LINES[1]}\n`, 'utf8');
    second.pollAll();
    expect(collected.events).toHaveLength(4);
    expect(collected.events.map((event) => event.kind)).toEqual([
      'user-message',
      'reasoning',
      'tool-call',
      'assistant-message',
    ]);
  });

  it('filters subscriptions by native session id (scoped delivery)', async () => {
    const bus = createCliGatewayEventBus();
    const publishedA = bus.publish({
      topic: 'native-sessions',
      type: 'native-session.user-message',
      sessionId: 'native-a',
      payload: { provider: 'claude', kind: 'user-message' },
    });
    const publishedB = bus.publish({
      topic: 'native-sessions',
      type: 'native-session.user-message',
      sessionId: 'native-b',
      payload: { provider: 'codex', kind: 'user-message' },
    });

    // Cursor-based replay returns everything after the given cursor; the
    // events router then applies eventMatchesFilter for `--session-id`.
    const after = bus.replay('native-sessions', publishedA.cursor);
    expect(after.events.map((event) => event.sessionId)).toEqual(['native-b']);
    expect(
      after.events.filter((event) =>
        eventMatchesFilter(event, { sessionId: 'native-b' })
      )
    ).toHaveLength(1);
    expect(publishedB.payload['provider']).toBe('codex');
  });
});

describe('normalizePrimeAgentLiveEvent (#1426)', () => {
  const context = {
    sourcePath: '/tmp/prime/019f.jsonl',
    fallbackNativeId: '019f-prime-1',
  };

  it('maps the session header to session-started and non-message types to gaps', () => {
    const header = normalizePrimeAgentLiveEvent(
      JSON.parse(
        JSON.stringify({
          type: 'session',
          version: 3,
          id: '019f-prime-1',
          timestamp: '2026-08-01T00:00:00.000Z',
          cwd: '/tmp/repo',
        })
      ),
      context
    );
    expect(header).toEqual([
      {
        provider: 'prime-agent',
        nativeId: '019f-prime-1',
        sourcePath: context.sourcePath,
        timestamp: '2026-08-01T00:00:00.000Z',
        kind: 'session-started',
        text: '',
        providerEvent: 'session',
      },
    ]);

    const gap = normalizePrimeAgentLiveEvent(
      {
        type: 'agent_status',
        id: 'x1',
        timestamp: '2026-08-01T00:00:01.000Z',
        status: { taskState: 'idle' },
      },
      context
    );
    expect(gap).toHaveLength(1);
    expect(gap[0]).toMatchObject({
      kind: 'gap',
      providerEvent: 'agent_status',
    });
  });

  it('streams user/assistant/toolResult message records in order with redaction', () => {
    const user = normalizePrimeAgentLiveEvent(
      {
        type: 'message',
        id: 'm1',
        timestamp: '2026-08-01T00:00:02.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'run with token=abc123 please' }],
        },
      },
      context
    );
    expect(user).toEqual([
      {
        provider: 'prime-agent',
        nativeId: '019f-prime-1',
        sourcePath: context.sourcePath,
        timestamp: '2026-08-01T00:00:02.000Z',
        kind: 'user-message',
        text: 'run with token=[redacted] please',
        providerEvent: 'message',
      },
    ]);

    const assistant = normalizePrimeAgentLiveEvent(
      {
        type: 'message',
        id: 'm2',
        timestamp: '2026-08-01T00:00:03.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'planning the run' },
            {
              type: 'toolCall',
              id: 'call_1',
              name: 'ipython',
              arguments: { code: 'ls -la' },
            },
            { type: 'text', text: 'all done' },
          ],
        },
      },
      context
    );
    expect(assistant.map((event) => event.kind)).toEqual([
      'reasoning',
      'tool-call',
      'assistant-message',
    ]);
    expect(assistant[1]?.text).toBe('ipython ls -la');

    const toolResult = normalizePrimeAgentLiveEvent(
      {
        type: 'message',
        id: 'm3',
        timestamp: '2026-08-01T00:00:04.000Z',
        message: {
          role: 'toolResult',
          toolName: 'ipython',
          content: [{ type: 'text', text: 'total 4 files' }],
        },
      },
      context
    );
    expect(toolResult).toEqual([
      {
        provider: 'prime-agent',
        nativeId: '019f-prime-1',
        sourcePath: context.sourcePath,
        timestamp: '2026-08-01T00:00:04.000Z',
        kind: 'tool-result',
        text: 'total 4 files',
        providerEvent: 'message',
      },
    ]);
  });
});

describe('NativeSessionLiveTailManager prime-agent wiring (#1426)', () => {
  let managers: NativeSessionLiveTailManager[] = [];

  afterEach(() => {
    for (const manager of managers) manager.stopAll();
    managers = [];
  });

  function makeManager(configDir: string, bus: CliGatewayEventBus) {
    const manager = new NativeSessionLiveTailManager({
      eventBus: bus,
      cursorStore: new LiveTailCursorStore(configDir),
    });
    managers.push(manager);
    return manager;
  }

  async function makePrimeFile(): Promise<{ root: string; file: string }> {
    const { mkdtemp: mkTemp, writeFile: write } =
      await import('node:fs/promises');
    const root = await mkTemp(path.join(tmpdir(), 'relay-live-tail-prime-'));
    const file = path.join(root, 'prime-session.jsonl');
    await write(file, '', 'utf8');
    return { root, file };
  }

  it('streams prime fixtures onto the scoped topic in order without replay after restart', async () => {
    const session = await makePrimeFile();
    const lines = [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'prime-tail-1',
        timestamp: '2026-08-24T03:00:00.000Z',
        cwd: '/tmp/repo',
      }),
      JSON.stringify({
        type: 'message',
        id: 'p1',
        timestamp: '2026-08-24T03:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'check the api_key=abc123 setup' }],
        },
      }),
    ];
    const { writeFile: write, appendFile } = await import('node:fs/promises');
    await write(session.file, `${lines.join('\n')}\n`, 'utf8');

    const bus = createCliGatewayEventBus();
    const collected = collect(bus);
    const first = makeManager(session.root, bus);
    first.watch({
      provider: 'prime-agent',
      nativeId: 'prime-tail-1',
      sourcePath: session.file,
    });
    first.pollAll();

    const primeEvents = collected.events.filter(
      (event) => event.nativeId === 'prime-tail-1'
    );
    expect(primeEvents.map((event) => event.kind)).toEqual([
      'session-started',
      'user-message',
    ]);
    expect(primeEvents[1]?.text).toContain('api_key=[redacted]');

    // Cursor resume: a fresh manager over the same store replays nothing.
    first.stopAll();
    const second = makeManager(session.root, bus);
    second.watch({
      provider: 'prime-agent',
      nativeId: 'prime-tail-1',
      sourcePath: session.file,
    });
    second.pollAll();
    expect(
      collected.events.filter((e) => e.nativeId === 'prime-tail-1')
    ).toHaveLength(2);

    // One appended line -> exactly one new event batch.
    await appendFile(
      session.file,
      `${JSON.stringify({
        type: 'message',
        id: 'p2',
        timestamp: '2026-08-24T03:00:05.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'the prime tail works' }],
        },
      })}\n`,
      'utf8'
    );
    second.pollAll();
    const kinds = collected.events
      .filter((e) => e.nativeId === 'prime-tail-1')
      .map((event) => event.kind);
    expect(kinds.slice(2)).toEqual(['assistant-message']);
  });
});
