import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  AcpClient,
  type AcpClientOptions,
} from '../../../server/acp-client.js';
import { CursorProtocolAdapter } from '../../../server/protocol-adapters/cursor-adapter.js';

/**
 * The yolo permission frame is not transcribed by hand: it is lifted straight
 * out of the `cursor-agent --yolo acp` capture, so this test fails if the
 * recorded wire shape and the adapter's expectations ever drift apart. Like
 * its sibling captures the file is strict NDJSON holding agent -> client
 * frames only: one JSON object per line, no direction prefixes.
 */
const YOLO_CAPTURE_PATH = fileURLToPath(
  new URL(
    '../../fixtures/cursor/acp-yolo-permission-capture.redacted.ndjson',
    import.meta.url
  )
);

function capturedYoloPermissionRequest(): {
  id: number;
  params: Record<string, unknown>;
} {
  const frame = readFileSync(YOLO_CAPTURE_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map(
      (l) => JSON.parse(l) as { id: number; method?: string; params?: unknown }
    )
    .find((f) => f.method === 'session/request_permission');
  if (!frame)
    throw new Error('yolo capture has no session/request_permission frame');
  return frame as { id: number; params: Record<string, unknown> };
}

type SendInput = Parameters<CursorProtocolAdapter['sendMessage']>[0];
type Patch = Record<string, unknown>;

const SESSION_ID = '91d58156-4230-4c0a-a171-bcc28c95873c';
const EXEC_CALL_ID =
  'call-43505e8d-57f2-465c-8b98-90ccb69d7a29-0\nfc_72f1634d-bd62-9da8-8795-1bacc0114f7d_0';
const EDIT_CALL_ID = 'replay-0-2';

const config = {
  cwd: '/repo',
  port: 1,
  sessionId: 'relay-session',
  hookToken: 'x',
  configDir: '/tmp',
};

const INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true, sse: true },
    promptCapabilities: { audio: false, embeddedContext: false, image: true },
    sessionCapabilities: { list: {} },
  },
  authMethods: [
    {
      id: 'cursor_login',
      name: 'Cursor Login',
      description:
        "Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in.",
    },
  ],
};

function queueSend(
  adapter: CursorProtocolAdapter,
  input: SendInput
): Promise<void> {
  const pending = adapter.sendMessage(input);
  void pending.catch(() => {});
  return pending;
}

function harness() {
  const client = new AcpClient({ command: 'cursor-agent' });
  client.setMaxListeners(50);
  const start = vi.spyOn(client, 'start').mockResolvedValue(INITIALIZE_RESULT);
  const request = vi
    .spyOn(client, 'request')
    .mockImplementation(async (method: string) => {
      if (method === 'authenticate') return { authenticated: true };
      if (method === 'session/new' || method === 'session/load')
        return { sessionId: SESSION_ID };
      return {};
    });

  let settlePrompt: ((value: unknown) => void) | null = null;
  const prompt = vi.spyOn(client, 'prompt').mockImplementation(
    () =>
      new Promise((resolve) => {
        settlePrompt = resolve;
      })
  );
  const notify = vi.spyOn(client, 'notify').mockImplementation(() => undefined);
  const respond = vi
    .spyOn(client, 'respond')
    .mockImplementation(() => undefined);
  const respondError = vi
    .spyOn(client, 'respondError')
    .mockImplementation(() => undefined);
  const stop = vi.spyOn(client, 'stop').mockResolvedValue();
  const clientFactoryOptions: AcpClientOptions[] = [];
  const adapter = new CursorProtocolAdapter((factoryOptions) => {
    clientFactoryOptions.push(factoryOptions);
    return client;
  });
  const patches: Patch[] = [];
  adapter.onPatch((patch) => patches.push(patch as unknown as Patch));

  const update = (
    body: Record<string, unknown>,
    sessionId = SESSION_ID
  ): void => {
    client.emit('notification', {
      method: 'session/update',
      params: { sessionId, update: body },
    });
  };

  const peerRequest = (
    id: string | number,
    method: string,
    params: Record<string, unknown>
  ): void => {
    client.emit('peerRequest', { id, method, params });
  };

  return {
    adapter,
    client,
    clientFactoryOptions,
    patches,
    start,
    request,
    prompt,
    notify,
    respond,
    respondError,
    stop,
    update,
    peerRequest,
    settlePrompt: (stopReason = 'end_turn') => {
      if (!settlePrompt) throw new Error('no prompt in flight to settle');
      const resolve = settlePrompt;
      settlePrompt = null;
      resolve({ stopReason });
    },
  };
}

describe('CursorProtocolAdapter', () => {
  it('connect spawns cursor-agent acp, performs initialize + authenticate and session/new', async () => {
    const h = harness();
    await h.adapter.connect(config);
    expect(h.clientFactoryOptions[0]).toMatchObject({
      command: 'cursor-agent',
      args: ['acp'],
      cwd: '/repo',
    });
    expect(h.start).toHaveBeenCalledWith({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'relay-ide', version: '0.1.0' },
    });
    expect(h.request).toHaveBeenCalledWith('authenticate', {
      methodId: 'cursor_login',
    });
    expect(h.request).toHaveBeenCalledWith('session/new', {
      cwd: '/repo',
      mcpServers: [],
    });
    expect(h.adapter.status).toBe('connected');
    expect(h.patches[0]).toMatchObject({
      type: 'agent-session-snapshot-v2',
      session: {
        provider: 'cursor',
        providerSession: { cursorSessionId: SESSION_ID },
      },
    });
  });

  it('passes --model and --yolo when configured', async () => {
    const h = harness();
    await h.adapter.connect({
      ...config,
      model: 'claude-3-5-sonnet',
      permissionMode: 'yolo',
    });
    expect(h.clientFactoryOptions[0]?.args).toEqual([
      '--model',
      'claude-3-5-sonnet',
      '--yolo',
      'acp',
    ]);
  });

  it('connect calls session/load when resumeSessionId is supplied', async () => {
    const h = harness();
    await h.adapter.connect({ ...config, resumeSessionId: 'existing-session' });
    expect(h.request).toHaveBeenCalledWith('session/load', {
      sessionId: 'existing-session',
      cwd: '/repo',
      mcpServers: [],
    });
  });

  // Regression pin for the no-active-turn guard, NOT for a replay flag. The
  // adapter has no `isReplaying` field: `session/load` only ever runs from
  // `connect()`, and `reconnect`/`resumeSession` complete the in-flight turn
  // before reconnecting, so `activeTurnId` is always null while history
  // streams in. The invariant is enforced redundantly (`appendMessageChunk`,
  // `startTool`, `finishTool`, `ensureItem`, `emitDelta`), so removing any one
  // guard still leaves another; this test goes red once the last layer between
  // a replayed frame and `emitPatch` is gone. Verified by mutation.
  it('drops session/load history replay because no turn is active', async () => {
    const h = harness();
    h.request.mockImplementation(async (method) => {
      if (method === 'session/load') {
        // Server emits historical replay before answering load request
        h.update({
          sessionUpdate: 'tool_call',
          toolCallId: EXEC_CALL_ID,
          title: '`echo CURSOR_LIVE_OK`',
          kind: 'execute',
          rawInput: { command: 'echo CURSOR_LIVE_OK' },
        });
        h.update({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'old-msg',
          content: { type: 'text', text: 'historical text' },
        });
        h.update({
          sessionUpdate: 'tool_call_update',
          toolCallId: EXEC_CALL_ID,
          status: 'completed',
          rawOutput: { exitCode: 0, stdout: 'CURSOR_LIVE_OK\n' },
        });
        // usage_update has its own guard, but `startTurn` also clears
        // `turnUsage`, so replayed usage is unobservable either way and this
        // test deliberately makes no claim about it.
        h.update({ sessionUpdate: 'usage_update', used: 4242, size: 200000 });
        h.client.emit('notification', {
          method: 'cursor/update_todos',
          params: { todos: [{ id: 'historical', content: 'stale todo' }] },
        });
        return { sessionId: 'existing-session' };
      }
      return {};
    });

    await h.adapter.connect({ ...config, resumeSessionId: 'existing-session' });
    // Verify no agent-item patches were emitted for historical replay
    expect(
      h.patches.filter(
        (p) => typeof p.type === 'string' && p.type.startsWith('agent-item')
      )
    ).toHaveLength(0);
  });

  it('classifies kind: read with locations as dynamicToolCall, not fileChange', async () => {
    const h = harness();
    await h.adapter.connect(config);
    await h.adapter.sendMessage({
      turnId: 'turn-read',
      content: 'Read file',
    });

    h.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-read-1',
      title: 'readToolCall',
      kind: 'read',
      rawInput: { path: '/workspace/src/index.ts' },
      locations: [{ path: '/workspace/src/index.ts' }],
    });

    const itemPatch = h.patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        (p.item as any).id === 'call-read-1'
    );
    expect(itemPatch).toBeDefined();
    expect((itemPatch?.item as any).type).toBe('dynamicToolCall');
    expect((itemPatch?.item as any).tool).toBe('readToolCall');
  });

  it('keeps status: completed for non-zero exit codes unless ACP reported failed', async () => {
    const h = harness();
    await h.adapter.connect(config);
    await h.adapter.sendMessage({
      turnId: 'turn-exit',
      content: 'Run test -f',
    });

    h.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-exec-exit',
      title: '`test -f non_existent_file`',
      kind: 'execute',
      rawInput: { command: 'test -f non_existent_file' },
    });

    h.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-exec-exit',
      status: 'completed',
      rawOutput: {
        exitCode: 1,
        stdout: '',
        stderr: '',
      },
    });

    const finishPatch = h.patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        (p.item as any).id === 'call-exec-exit'
    );
    expect(finishPatch).toBeDefined();
    expect((finishPatch?.item as any).exitCode).toBe(1);
    expect((finishPatch?.item as any).status).toBe('completed');
  });

  it('formats unified diff with --- a / +++ b headers and hunk markers', async () => {
    const h = harness();
    await h.adapter.connect(config);
    await h.adapter.sendMessage({
      turnId: 'turn-diff',
      content: 'Edit file',
    });

    h.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-edit-diff',
      title: 'Edit `/workspace/foo.txt`',
      kind: 'edit',
      rawInput: { path: '/workspace/foo.txt' },
    });

    h.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-edit-diff',
      status: 'completed',
      content: [
        {
          type: 'diff',
          path: '/workspace/foo.txt',
          oldText: 'old line 1\nold line 2',
          newText: 'old line 1\nnew line 2',
        },
      ],
    });

    const filePatch = h.patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        (p.item as any).id === 'call-edit-diff'
    );
    expect(filePatch).toBeDefined();
    expect((filePatch?.item as any).patch).toContain('--- a/workspace/foo.txt');
    expect((filePatch?.item as any).patch).toContain('+++ b/workspace/foo.txt');
    expect((filePatch?.item as any).patch).toContain('@@ -1,2 +1,2 @@');
    expect((filePatch?.item as any).patch).toContain('-old line 2');
    expect((filePatch?.item as any).patch).toContain('+new line 2');
  });

  it('stringifies object rawOutput for dynamicToolCall result', async () => {
    const h = harness();
    await h.adapter.connect(config);
    await h.adapter.sendMessage({
      turnId: 'turn-dyn',
      content: 'Call dynamic tool',
    });

    h.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-search-1',
      title: 'searchToolCall',
      kind: 'search',
      rawInput: { query: 'test' },
    });

    h.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-search-1',
      status: 'completed',
      rawOutput: { count: 3, matches: ['a', 'b', 'c'] },
    });

    const dynPatch = h.patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        (p.item as any).id === 'call-search-1'
    );
    expect(dynPatch).toBeDefined();
    expect(typeof (dynPatch?.item as any).result).toBe('string');
    expect((dynPatch?.item as any).result).toContain('"count": 3');
  });

  it('cancels unanswered questions upon turn end and keys by pending.card.id', async () => {
    const h = harness();
    await h.adapter.connect(config);
    await h.adapter.sendMessage({
      turnId: 'turn-q-abandon',
      content: 'Ask something',
    });

    h.peerRequest(77, 'cursor/ask_question', {
      title: 'Clarification',
      questions: [{ id: 'q1', prompt: 'Choose' }],
    });

    expect(
      h.patches.some(
        (p) =>
          p.type === 'agent-item-started-v2' &&
          (p.item as any).id === 'question-cursor-question-77'
      )
    ).toBe(true);

    // Turn ends without answering
    h.settlePrompt('end_turn');

    await vi.waitFor(() => {
      const cancelledQuestion = h.patches.find(
        (p) =>
          p.type === 'agent-item-updated-v2' &&
          (p.item as any).id === 'question-cursor-question-77'
      );
      expect(cancelledQuestion).toBeDefined();
      expect((cancelledQuestion?.item as any).status).toBe('cancelled');
    });
    expect(h.respond).toHaveBeenCalledWith(77, {
      outcome: { outcome: 'cancelled' },
    });
  });

  it('fails closed when permission request options lack the requested kind', async () => {
    const h = harness();
    await h.adapter.connect(config);
    await h.adapter.sendMessage({
      turnId: 'turn-perm-fail',
      content: 'Run command',
    });

    h.update({
      sessionUpdate: 'tool_call',
      toolCallId: EXEC_CALL_ID,
      title: '`echo test`',
      kind: 'execute',
      rawInput: { command: 'echo test' },
    });

    // Only allow_once is provided, but user requests session scope (allow_always)
    h.peerRequest(55, 'session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: EXEC_CALL_ID },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      ],
    });

    await h.adapter.respondToApproval({
      requestId: 'cursor-approval-55',
      decision: { kind: 'accept', scope: 'session' },
    });

    // Should fail closed with cancelled outcome
    expect(h.respond).toHaveBeenCalledWith(55, {
      outcome: { outcome: 'cancelled' },
    });
    const cancelledApproval = h.patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        (p.item as any).id === 'approval-cursor-approval-55'
    );
    expect(cancelledApproval).toBeDefined();
    expect((cancelledApproval?.item as any).status).toBe('cancelled');
    expect(
      h.patches.some(
        (p) =>
          p.type === 'agent-error-v2' &&
          String(p.message).includes('did not provide a matching option')
      )
    ).toBe(true);
  });

  it('fails closed when a scope: once accept is offered only allow_always', async () => {
    const h = harness();
    await h.adapter.connect(config);
    await h.adapter.sendMessage({
      turnId: 'turn-once-only-always',
      content: 'Run command',
    });

    // A "once" decision must never be widened into a permanent grant.
    h.peerRequest(56, 'session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: EXEC_CALL_ID },
      options: [
        {
          optionId: 'allow-always',
          name: 'Allow always',
          kind: 'allow_always',
        },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });

    await h.adapter.respondToApproval({
      requestId: 'cursor-approval-56',
      decision: { kind: 'accept', scope: 'once' },
    });

    expect(h.respond).toHaveBeenCalledWith(56, {
      outcome: { outcome: 'cancelled' },
    });
    expect(h.respond).not.toHaveBeenCalledWith(56, {
      outcome: { outcome: 'selected', optionId: 'allow-always' },
    });
    const resolved = h.patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        (p.item as any).id === 'approval-cursor-approval-56'
    );
    expect((resolved?.item as any).status).toBe('cancelled');
    expect(
      h.patches.some(
        (p) =>
          p.type === 'agent-error-v2' &&
          String(p.message).includes('did not provide a matching option')
      )
    ).toBe(true);
  });

  it('yolo auto-approves the captured permission frame with allow_once and records the grant', async () => {
    const captured = capturedYoloPermissionRequest();
    const params = captured.params as {
      sessionId: string;
      toolCall: { toolCallId: string; title: string; kind: string };
      options: Array<{ optionId: string; kind: string }>;
    };
    // Guard the capture itself: this is the frame `--yolo` still produces.
    expect(params.toolCall.toolCallId).toMatch(/^toolu_/);
    expect(params.options.map((o) => o.kind)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
    ]);

    const h = harness();
    await h.adapter.connect({ ...config, permissionMode: 'yolo' });
    await h.adapter.sendMessage({
      turnId: 'turn-yolo',
      content: 'Run echo YOLO_PROBE',
    });

    h.peerRequest(captured.id, 'session/request_permission', params);

    // Answered on the wire with the single-use grant, never allow-always and
    // never "whatever option came first".
    expect(h.respond).toHaveBeenCalledWith(captured.id, {
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });

    // The auto-grant is recorded in the agent session mechanics (a debug-
    // visibility providerExtension) and the hub log. It is deliberately NOT in
    // the channel transcript: providerExtension has no detail card, so the
    // channel bridge does not mirror it to a durable row.
    const extension = h.patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        (p.item as any).type === 'providerExtension' &&
        (p.item as any).payload?.kind === 'permission_auto_approved'
    );
    expect(extension).toBeDefined();
    expect((extension?.item as any).namespace).toBe('cursor');
    // 'debug' visibility, matching the sibling cursor provider extensions.
    expect((extension?.item as any).metadata?.eventVisibility).toBe('debug');
    expect((extension?.item as any).payload.grant).toEqual({
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title,
      kind: params.toolCall.kind,
      optionId: 'allow-once',
    });

    // No approval card: the turn was never blocked on a human.
    expect(
      h.patches.some(
        (p) =>
          p.type === 'agent-item-started-v2' &&
          (p.item as any).type === 'approval'
      )
    ).toBe(false);
  });

  it('yolo does not auto-approve when no allow_once option is offered', async () => {
    const h = harness();
    await h.adapter.connect({ ...config, permissionMode: 'yolo' });
    await h.adapter.sendMessage({
      turnId: 'turn-yolo-reject-only',
      content: 'Run something unapprovable',
    });

    h.peerRequest(57, 'session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: {
        toolCallId: EXEC_CALL_ID,
        title: '`rm -rf /`',
        kind: 'execute',
        status: 'pending',
      },
      options: [
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });

    // Nothing was auto-selected on the wire...
    expect(h.respond).not.toHaveBeenCalled();
    // ...and no grant was recorded.
    expect(
      h.patches.some(
        (p) =>
          p.type === 'agent-item-started-v2' &&
          (p.item as any).type === 'providerExtension' &&
          (p.item as any).payload?.kind === 'permission_auto_approved'
      )
    ).toBe(false);

    // The request fell through to the normal approval card path.
    const card = h.patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        (p.item as any).id === 'approval-cursor-approval-57'
    );
    expect(card).toBeDefined();
    expect((card?.item as any).status).toBe('pending');

    // And accepting it still fails closed, because there is no allow option.
    await h.adapter.respondToApproval({
      requestId: 'cursor-approval-57',
      decision: { kind: 'accept', scope: 'once' },
    });
    expect(h.respond).toHaveBeenCalledWith(57, {
      outcome: { outcome: 'cancelled' },
    });
  });

  it('fails closed when a decline decision is offered only reject_always', async () => {
    const h = harness();
    await h.adapter.connect(config);
    await h.adapter.sendMessage({
      turnId: 'turn-reject-only-always',
      content: 'Run command',
    });

    // Symmetric with the accept path: a one-time reject never widens either.
    h.peerRequest(58, 'session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: EXEC_CALL_ID },
      options: [
        {
          optionId: 'reject-always',
          name: 'Reject always',
          kind: 'reject_always',
        },
      ],
    });

    await h.adapter.respondToApproval({
      requestId: 'cursor-approval-58',
      decision: { kind: 'decline' },
    });

    expect(h.respond).toHaveBeenCalledWith(58, {
      outcome: { outcome: 'cancelled' },
    });
    expect(h.respond).not.toHaveBeenCalledWith(58, {
      outcome: { outcome: 'selected', optionId: 'reject-always' },
    });
  });

  it('cancels a permission request that arrives during session/load replay', async () => {
    const h = harness();
    h.request.mockImplementation(async (method) => {
      if (method === 'session/load') {
        // Cursor can re-raise a stored permission request while history
        // streams in. There is no turn to attach it to, so it must be
        // released rather than parked as an un-answerable card.
        h.peerRequest(99, 'session/request_permission', {
          sessionId: 'existing-session',
          toolCall: { toolCallId: EXEC_CALL_ID, title: '`echo old`' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          ],
        });
        return { sessionId: 'existing-session' };
      }
      return {};
    });

    await h.adapter.connect({ ...config, resumeSessionId: 'existing-session' });

    expect(h.respond).toHaveBeenCalledWith(99, {
      outcome: { outcome: 'cancelled' },
    });
    expect(
      h.patches.some(
        (p) =>
          p.type === 'agent-item-started-v2' &&
          (p.item as any).type === 'approval'
      )
    ).toBe(false);
  });

  it('fails the handshake when session/new returns no sessionId', async () => {
    const h = harness();
    h.request.mockImplementation(async (method) => {
      if (method === 'authenticate') return { authenticated: true };
      // A sessionId-less result would leave every session/prompt failing on
      // the wire while the adapter reported connected.
      if (method === 'session/new') return {};
      return {};
    });

    await expect(h.adapter.connect(config)).rejects.toThrow(/no sessionId/);
    expect(h.adapter.status).toBe('disconnected');
    expect(h.stop).toHaveBeenCalled();
  });

  it('accepts a session/load handshake that echoes only the resumed id', async () => {
    const h = harness();
    h.request.mockImplementation(async (method) => {
      if (method === 'authenticate') return { authenticated: true };
      if (method === 'session/load') return {};
      return {};
    });

    // resumeSessionId still satisfies the handshake: the id is known.
    await h.adapter.connect({ ...config, resumeSessionId: 'existing-session' });
    expect(h.adapter.status).toBe('connected');
  });

  it('falls back to session/new when session/load fails', async () => {
    const h = harness();
    h.request.mockImplementation(async (method) => {
      if (method === 'session/load') throw new Error('Session not found');
      if (method === 'session/new') return { sessionId: 'new-session' };
      return {};
    });

    await h.adapter.connect({ ...config, resumeSessionId: 'stale-session' });
    expect(h.request).toHaveBeenCalledWith('session/new', {
      cwd: '/repo',
      mcpServers: [],
    });
    expect(
      h.patches.some(
        (p) =>
          p.type === 'agent-error-v2' &&
          String(p.message).includes('could not resume the previous session')
      )
    ).toBe(true);
  });

  it('streams assistant text, thoughts, tool calls, and settles on end_turn', async () => {
    const h = harness();
    await h.adapter.connect(config);
    h.patches.length = 0;

    await h.adapter.sendMessage({
      turnId: 'turn-1',
      content: 'Run echo and reply with OK',
    });

    expect(h.prompt).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      prompt: [{ type: 'text', text: 'Run echo and reply with OK' }],
    });

    // Thought chunk
    h.update({
      sessionUpdate: 'agent_thought_chunk',
      content: {
        type: 'text',
        text: 'Running `echo CURSOR_LIVE_OK` and replying with exactly that text.',
      },
    });

    // Tool call (execute)
    h.update({
      sessionUpdate: 'tool_call',
      toolCallId: EXEC_CALL_ID,
      title: '`echo CURSOR_LIVE_OK`',
      kind: 'execute',
      rawInput: { command: 'echo CURSOR_LIVE_OK' },
    });

    // Tool completion
    h.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: EXEC_CALL_ID,
      status: 'completed',
      rawOutput: {
        exitCode: 0,
        stdout: 'CURSOR_LIVE_OK\n',
        stderr: '',
      },
    });

    // Tool call (file edit with diff)
    h.update({
      sessionUpdate: 'tool_call',
      toolCallId: EDIT_CALL_ID,
      title: 'Edit `/workspace/cursor-note.txt`',
      kind: 'edit',
      rawInput: { path: '/workspace/cursor-note.txt' },
      locations: [{ path: '/workspace/cursor-note.txt' }],
    });

    // File edit completion
    h.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: EDIT_CALL_ID,
      status: 'completed',
      content: [
        {
          type: 'diff',
          path: '/workspace/cursor-note.txt',
          oldText: '-- /dev/null',
          newText: '++ b//workspace/cursor-note.txt\nrelay-cursor-proof',
        },
      ],
    });

    // Message chunk
    h.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'CURSOR_LIVE_OK' },
    });

    h.settlePrompt('end_turn');
    await vi.waitFor(() =>
      expect(h.patches.some((p) => p.type === 'agent-turn-completed-v2')).toBe(
        true
      )
    );

    const completedPatch = h.patches.find(
      (p) => p.type === 'agent-turn-completed-v2'
    );
    expect(completedPatch).toMatchObject({
      status: 'completed',
      turnId: 'turn-1',
    });

    const commandPatch = h.patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        (p.item as any).type === 'commandExecution'
    );
    expect(commandPatch).toBeDefined();
    expect((commandPatch?.item as any).output).toBe('CURSOR_LIVE_OK\n');
    expect((commandPatch?.item as any).exitCode).toBe(0);

    const filePatch = h.patches.find(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        (p.item as any).type === 'fileChange'
    );
    expect(filePatch).toBeDefined();
    expect((filePatch?.item as any).patch).toContain('relay-cursor-proof');
  });

  it('handles permission requests with allow-once, allow-always, and reject-once', async () => {
    const h = harness();
    await h.adapter.connect(config);
    await h.adapter.sendMessage({
      turnId: 'turn-perm',
      content: 'Do command execution',
    });

    h.update({
      sessionUpdate: 'tool_call',
      toolCallId: EXEC_CALL_ID,
      title: '`echo CURSOR_LIVE_OK`',
      kind: 'execute',
      rawInput: { command: 'echo CURSOR_LIVE_OK' },
    });

    h.peerRequest(42, 'session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: {
        toolCallId: EXEC_CALL_ID,
        title: '`echo CURSOR_LIVE_OK`',
        kind: 'execute',
        status: 'pending',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'Not in allowlist: echo' },
          },
        ],
      },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        {
          optionId: 'allow-always',
          name: 'Allow always',
          kind: 'allow_always',
        },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });

    const approvalCard = h.patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        (p.item as any).type === 'approval'
    );
    expect(approvalCard).toBeDefined();

    await h.adapter.respondToApproval({
      requestId: 'cursor-approval-42',
      decision: { kind: 'accept', scope: 'once' },
    });

    expect(h.respond).toHaveBeenCalledWith(42, {
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
  });

  it('handles cursor/ask_question peer request and answers with structured output', async () => {
    const h = harness();
    await h.adapter.connect(config);
    await h.adapter.sendMessage({
      turnId: 'turn-q',
      content: 'Pick an option',
    });

    h.peerRequest(88, 'cursor/ask_question', {
      toolCallId: 'call_q',
      title: 'Configuration',
      questions: [
        {
          id: 'framework',
          prompt: 'Which framework to use?',
          options: [
            { id: 'react', label: 'React' },
            { id: 'vue', label: 'Vue' },
          ],
          allowMultiple: false,
        },
      ],
    });

    const questionItem = h.patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' &&
        (p.item as any).type === 'question'
    );
    expect(questionItem).toBeDefined();

    await h.adapter.respondToInput({
      requestId: 'cursor-question-88',
      answers: { framework: ['react'] },
    });

    expect(h.respond).toHaveBeenCalledWith(88, {
      outcome: {
        outcome: 'answered',
        answers: [{ questionId: 'framework', selectedOptionIds: ['react'] }],
      },
    });
  });

  it('auto-accepts cursor/create_plan peer request and emits plan item', async () => {
    const h = harness();
    await h.adapter.connect(config);
    await h.adapter.sendMessage({ turnId: 'turn-plan', content: 'Plan work' });

    h.peerRequest(99, 'cursor/create_plan', {
      toolCallId: 'call_plan_1',
      name: 'Migration Plan',
      overview: 'Migrate to v2',
      plan: 'Step 1: update files\nStep 2: verify',
      todos: [
        { id: '1', content: 'update files', status: 'completed' },
        { id: '2', content: 'verify', status: 'in_progress' },
      ],
    });

    expect(h.respond).toHaveBeenCalledWith(99, {
      outcome: { outcome: 'accepted' },
    });

    const planPatch = h.patches.find(
      (p) =>
        p.type === 'agent-item-started-v2' && (p.item as any).type === 'plan'
    );
    expect(planPatch).toBeDefined();
    expect((planPatch?.item as any).steps).toHaveLength(2);
  });

  it('answers unknown peer requests with -32601 Method not found', async () => {
    const h = harness();
    await h.adapter.connect(config);

    h.peerRequest(123, 'cursor/unknown_extension', {});
    expect(h.respondError).toHaveBeenCalledWith(
      123,
      -32601,
      'Relay does not implement cursor/unknown_extension'
    );
  });

  it('interrupt sends session/cancel notification and settles turn as interrupted', async () => {
    const h = harness();
    await h.adapter.connect(config);
    await h.adapter.sendMessage({ turnId: 'turn-int', content: 'Long task' });

    await h.adapter.interrupt({ turnId: 'turn-int' });
    expect(h.notify).toHaveBeenCalledWith('session/cancel', {
      sessionId: SESSION_ID,
    });

    h.settlePrompt('cancelled');
    await vi.waitFor(() =>
      expect(
        h.patches.some(
          (p) =>
            p.type === 'agent-turn-completed-v2' && p.status === 'interrupted'
        )
      ).toBe(true)
    );
  });

  it('enqueues messages when a turn is already active', async () => {
    const h = harness();
    await h.adapter.connect(config);

    await h.adapter.sendMessage({ turnId: 'turn-1', content: 'first' });
    void queueSend(h.adapter, { turnId: 'turn-2', content: 'second' });

    expect(h.prompt).toHaveBeenCalledTimes(1);
    h.settlePrompt('end_turn');

    await vi.waitFor(() => expect(h.prompt).toHaveBeenCalledTimes(2));
    expect(h.prompt).toHaveBeenLastCalledWith({
      sessionId: SESSION_ID,
      prompt: [{ type: 'text', text: 'second' }],
    });
  });

  it('rejects attachments before starting a turn', async () => {
    const h = harness();
    await h.adapter.connect(config);
    await expect(
      h.adapter.sendMessage({
        turnId: 'turn-attach',
        content: 'with file',
        attachments: [
          {
            type: 'image',
            name: 'pic.png',
            mimeType: 'image/png',
            data: 'base64',
          } as any,
        ],
      })
    ).rejects.toThrow(/does not accept attachments/);
  });

  it('disconnects and cleans up client on transport close', async () => {
    const h = harness();
    await h.adapter.connect(config);
    h.client.emit('close', 1);

    expect(h.adapter.status).toBe('disconnected');
    expect(
      h.patches.some(
        (p) =>
          p.type === 'agent-error-v2' &&
          String(p.message).includes('transport closed')
      )
    ).toBe(true);
  });
});
