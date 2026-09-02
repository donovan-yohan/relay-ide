import { describe, expect, it, vi } from 'vitest';
import {
  AcpClient,
  type AcpClientOptions,
} from '../../../server/acp-client.js';
import { CursorProtocolAdapter } from '../../../server/protocol-adapters/cursor-adapter.js';

type SendInput = Parameters<CursorProtocolAdapter['sendMessage']>[0];
type Patch = Record<string, unknown>;

const SESSION_ID = '4fbf9dfa-08d2-412b-8381-b47623132936';
const BASH_CALL_ID = 'call_c480662a7758c60e63ff787b01b3ac60';
const WRITE_CALL_ID = 'call_fe4cde6217019bba8c1a45d8034732e4';

const config = {
  cwd: '/repo',
  port: 1,
  sessionId: 'relay-session',
  hookToken: 'x',
  configDir: '/tmp',
};

const INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentInfo: { name: 'cursor-agent', version: '2026.08.31' },
  agentCapabilities: {
    mcpCapabilities: { http: true },
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    sessionCapabilities: { close: {}, list: {}, load: {} },
  },
  authMethods: [{ methodId: 'cursor_login' }],
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
  const client = new AcpClient();
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

  it('suppresses patch emissions during session/load history replay', async () => {
    const h = harness();
    h.request.mockImplementation(async (method) => {
      if (method === 'session/load') {
        // Server emits historical replay before answering load request
        h.update({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'old-msg',
          content: { type: 'text', text: 'historical text' },
        });
        return { sessionId: 'existing-session' };
      }
      return {};
    });

    await h.adapter.connect({ ...config, resumeSessionId: 'existing-session' });
    // Verify no agent-item-started or delta was emitted for historical message
    expect(h.patches.some((p) => p.type === 'agent-item-delta-v2')).toBe(false);
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
      messageId: 'th-1',
      content: { type: 'text', text: 'Planning the command...' },
    });

    // Tool call (bash)
    h.update({
      sessionUpdate: 'tool_call',
      toolCallId: BASH_CALL_ID,
      title: 'bash',
      rawInput: { command: 'echo hello' },
    });

    // Tool completion
    h.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: BASH_CALL_ID,
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'hello\n' } },
      ],
    });

    // Message chunk
    h.update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg-1',
      content: { type: 'text', text: 'OK' },
    });

    // Usage update
    h.update({
      sessionUpdate: 'usage_update',
      used: 1200,
      size: 100000,
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
      usage: { totalTokens: 1200, contextWindowSize: 100000 },
    });
  });

  it('handles permission requests with allow-once, allow-always, and reject-once', async () => {
    const h = harness();
    await h.adapter.connect(config);
    await h.adapter.sendMessage({
      turnId: 'turn-perm',
      content: 'Do file write',
    });

    h.update({
      sessionUpdate: 'tool_call',
      toolCallId: WRITE_CALL_ID,
      title: 'write',
      rawInput: { file_path: '/repo/test.txt', content: 'abc' },
    });

    h.peerRequest(42, 'session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: WRITE_CALL_ID },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
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
