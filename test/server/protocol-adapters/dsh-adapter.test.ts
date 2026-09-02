/**
 * Deep tests for the dsh channel adapter (DeepSeek Harness ACP stdio lane).
 *
 * Every native payload here is transcribed from the real `deepseek-harness-acp`
 * 0.0.1 captures committed under `test/fixtures/dsh/`; the `session/
 * request_permission` payload is transcribed from the harness's own
 * `packages/acp/acp/src/index.ts` `approval/request` bridge, which hard-codes
 * exactly those two options. The transport is a spied `DshAcpClient`, so
 * nothing spawns a child or reaches the network.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DshAcpClient,
  type DshAcpClientOptions,
} from '../../../server/dsh-acp-client.js';
import { DshProtocolAdapter } from '../../../server/protocol-adapters/dsh-adapter.js';
import { CHANNEL_ADAPTER_LAUNCH_CONTRACTS } from '../../../server/protocol-adapters/index.js';

type SendInput = Parameters<DshProtocolAdapter['sendMessage']>[0];
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

/** The real `initialize` result, transcribed from the capture. */
const INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
  agentCapabilities: {
    mcpCapabilities: { http: true },
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    sessionCapabilities: { close: {}, list: {}, resume: {} },
  },
  authMethods: [],
};

/**
 * Start a send the adapter will QUEUE behind the active turn. A queued entry
 * settles when its turn STARTS, so awaiting it here would block until the
 * active prompt settles.
 */
function queueSend(
  adapter: DshProtocolAdapter,
  input: SendInput
): Promise<void> {
  const pending = adapter.sendMessage(input);
  void pending.catch(() => {});
  return pending;
}

function harness() {
  const client = new DshAcpClient();
  client.setMaxListeners(50);
  const start = vi.spyOn(client, 'start').mockResolvedValue(INITIALIZE_RESULT);
  const request = vi
    .spyOn(client, 'request')
    .mockImplementation(async (method: string) =>
      method === 'session/new' || method === 'session/resume'
        ? { sessionId: SESSION_ID, configOptions: [] }
        : {}
    );
  /** Resolve the pending `session/prompt` with one stop reason. */
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
  const clientFactoryOptions: DshAcpClientOptions[] = [];
  const adapter = new DshProtocolAdapter((factoryOptions) => {
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
    id: number,
    method: string,
    params: Record<string, unknown>
  ): void => {
    client.emit('peerRequest', { id, method, params });
  };
  /** Settle the in-flight `session/prompt`, as the ACP server does. */
  const settle = async (stopReason: string): Promise<void> => {
    settlePrompt?.({ stopReason });
    settlePrompt = null;
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    adapter,
    client,
    start,
    request,
    prompt,
    notify,
    respond,
    respondError,
    stop,
    patches,
    clientFactoryOptions,
    update,
    peerRequest,
    settle,
  };
}

function itemsOf(patches: Patch[], type: string): Patch[] {
  return patches
    .filter((patch) => patch.type === type)
    .map((patch) => patch.item as Patch)
    .filter(Boolean);
}

function lastLive(patches: Patch[]): Patch {
  const live = patches.filter((p) => p.type === 'agent-live-state-updated-v2');
  return (live.at(-1)?.live ?? {}) as Patch;
}

describe('DshProtocolAdapter', () => {
  it('publishes honest capabilities, the descriptor spawn command, and a sanitized env', async () => {
    const { adapter, patches, clientFactoryOptions, start } = harness();
    await adapter.connect({
      ...config,
      processEnv: {
        RELAY_PROFILE_SAFE: 'kept',
        DEEPSEEK_API_KEY: 'profile-key',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
      },
    });

    const launch = CHANNEL_ADAPTER_LAUNCH_CONTRACTS.dsh;
    expect(launch.requirement).toEqual({ kind: 'command', command: 'dsh' });
    expect(clientFactoryOptions[0]?.command).toBe(launch.requirement.command);
    expect(clientFactoryOptions[0]?.args).toEqual(['--profile', 'acp']);
    expect(clientFactoryOptions[0]?.cwd).toBe('/repo');
    const env = clientFactoryOptions[0]?.env ?? {};
    for (const key of launch.processEnvDenylist)
      expect(env[key]).toBeUndefined();
    expect(env.RELAY_PROFILE_SAFE).toBe('kept');
    // Credentials MUST survive: env is the only way this lane is credentialed.
    expect(env.DEEPSEEK_API_KEY).toBe('profile-key');
    expect(env.DSH_PERMISSION_MODE).toBe('workspace-write');

    // Relay owns its own filesystem and terminal surfaces.
    expect(start).toHaveBeenCalledWith({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    expect(adapter.capabilities).toMatchObject({
      approvals: true,
      resume: true,
      interrupt: true,
      questions: false,
      steer: false,
      streaming: true,
    });
    const snapshot = patches.find(
      (patch) => patch.type === 'agent-session-snapshot-v2'
    );
    expect(
      (snapshot?.session as { providerSession?: Patch }).providerSession
    ).toEqual({ dshSessionId: SESSION_ID });
    await adapter.disconnect();
  });

  it('translates a yolo permission mode and lets a profile override it', async () => {
    const yolo = harness();
    await yolo.adapter.connect({
      ...config,
      permissionMode: 'danger-full-access',
    });
    expect(yolo.clientFactoryOptions[0]?.env?.DSH_PERMISSION_MODE).toBe(
      'danger-full-access'
    );
    await yolo.adapter.disconnect();

    const profile = harness();
    await profile.adapter.connect({
      ...config,
      permissionMode: 'danger-full-access',
      processEnv: { DSH_PERMISSION_MODE: 'read-only' },
    });
    expect(profile.clientFactoryOptions[0]?.env?.DSH_PERMISSION_MODE).toBe(
      'read-only'
    );
    await profile.adapter.disconnect();
  });

  it('opens a fresh session with session/new and resumes with session/resume', async () => {
    const fresh = harness();
    await fresh.adapter.connect(config);
    expect(fresh.request).toHaveBeenCalledWith('session/new', {
      cwd: '/repo',
      mcpServers: [],
    });
    await fresh.adapter.disconnect();

    const resumed = harness();
    await resumed.adapter.connect({ ...config, resumeSessionId: 'prior-1' });
    expect(resumed.request).toHaveBeenCalledWith('session/resume', {
      sessionId: 'prior-1',
      cwd: '/repo',
      mcpServers: [],
    });
    expect(resumed.request).not.toHaveBeenCalledWith(
      'session/new',
      expect.anything()
    );
    await resumed.adapter.disconnect();
  });

  it('falls back to a fresh session when a resume is refused, and says so', async () => {
    const { adapter, request, patches } = harness();
    request.mockImplementation(async (method: string) => {
      if (method === 'session/resume')
        throw new Error('Invalid params ({"detail":"unknown session"})');
      return { sessionId: SESSION_ID, configOptions: [] };
    });
    await adapter.connect({ ...config, resumeSessionId: 'gone-1' });
    expect(adapter.status).toBe('connected');
    expect(request).toHaveBeenCalledWith('session/new', {
      cwd: '/repo',
      mcpServers: [],
    });
    expect(patches.find((p) => p.type === 'agent-error-v2')).toMatchObject({
      message: expect.stringContaining('could not resume the previous session'),
    });
    await adapter.disconnect();
  });

  it('sends one session/prompt per turn and completes it on the prompt response', async () => {
    const { adapter, prompt, patches, settle } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'hello dsh' });
    expect(prompt).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      prompt: [{ type: 'text', text: 'hello dsh' }],
    });
    // The turn is still open while the prompt is unanswered: `session/prompt`
    // settles only when the whole turn does.
    expect(patches.some((p) => p.type === 'agent-turn-completed-v2')).toBe(
      false
    );
    await settle('end_turn');
    expect(
      patches.find((p) => p.type === 'agent-turn-completed-v2')
    ).toMatchObject({ turnId: 't1', status: 'completed' });
    await adapter.disconnect();
  });

  it('maps message and thought chunks to items keyed by the native messageId', async () => {
    const { adapter, patches, update, settle } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });

    update({
      sessionUpdate: 'agent_thought_chunk',
      messageId: 'm-1',
      content: { type: 'text', text: 'Run the command' },
    });
    update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm-2',
      content: { type: 'text', text: 'DSH_LIVE_OK' },
    });
    // A second chunk of the SAME message appends to the same card.
    update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm-2',
      content: { type: 'text', text: ' again' },
    });

    const ids = itemsOf(patches, 'agent-item-started-v2').map((i) => i.id);
    expect(ids).toContain('t1-reasoning-m-1');
    expect(ids).toContain('t1-assistant-m-2');
    const deltas = patches.filter((p) => p.type === 'agent-item-delta-v2');
    expect(deltas.map((d) => d.itemId)).toEqual([
      't1-reasoning-m-1',
      't1-assistant-m-2',
      't1-assistant-m-2',
    ]);
    await settle('end_turn');
    await adapter.disconnect();
  });

  it('maps a bash tool_call and its update to a commandExecution keyed by toolCallId', async () => {
    const { adapter, patches, update, settle } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });

    update({
      sessionUpdate: 'tool_call',
      toolCallId: BASH_CALL_ID,
      title: 'bash',
      kind: 'other',
      status: 'in_progress',
      rawInput: { command: 'echo relay-acp', description: 'Echo the string' },
    });
    expect(itemsOf(patches, 'agent-item-started-v2').at(-1)).toMatchObject({
      type: 'commandExecution',
      id: BASH_CALL_ID,
      command: 'echo relay-acp',
      status: 'running',
    });

    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: BASH_CALL_ID,
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'relay-acp\n' } },
      ],
    });
    expect(itemsOf(patches, 'agent-item-updated-v2').at(-1)).toMatchObject({
      type: 'commandExecution',
      output: 'relay-acp\n',
      exitCode: 0,
      status: 'completed',
    });
    await settle('end_turn');
    await adapter.disconnect();
  });

  it('maps write to a fileChange and marks a failed tool_call_update failed', async () => {
    const { adapter, patches, update, settle } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });

    update({
      sessionUpdate: 'tool_call',
      toolCallId: WRITE_CALL_ID,
      title: 'write',
      kind: 'other',
      status: 'in_progress',
      rawInput: { file_path: '/workspace/acp-note.txt', content: 'done' },
    });
    expect(itemsOf(patches, 'agent-item-started-v2').at(-1)).toMatchObject({
      type: 'fileChange',
      paths: [{ path: '/workspace/acp-note.txt', status: 'added' }],
      applyStatus: 'pending',
    });

    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: WRITE_CALL_ID,
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'denied' } }],
    });
    expect(itemsOf(patches, 'agent-item-updated-v2').at(-1)).toMatchObject({
      type: 'fileChange',
      applyStatus: 'failed',
      status: 'failed',
    });
    await settle('end_turn');
    await adapter.disconnect();
  });

  it('maps an unclassified tool to a dynamicToolCall in the dsh namespace', async () => {
    const { adapter, patches, update, settle } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_todo',
      title: 'todo_write',
      kind: 'other',
      status: 'in_progress',
      rawInput: { todos: [] },
    });
    expect(itemsOf(patches, 'agent-item-started-v2').at(-1)).toMatchObject({
      type: 'dynamicToolCall',
      namespace: 'dsh',
      tool: 'todo_write',
      arguments: { todos: [] },
    });
    await settle('end_turn');
    await adapter.disconnect();
  });

  it('reports usage_update as context occupancy, keeping the last reading', async () => {
    const { adapter, patches, update, settle } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    update({ sessionUpdate: 'usage_update', used: 9432, size: 1000000 });
    update({ sessionUpdate: 'usage_update', used: 9238, size: 1000000 });
    await settle('end_turn');
    expect(
      patches.find((p) => p.type === 'agent-turn-completed-v2')?.usage
    ).toEqual({
      totalTokens: 9238,
      contextWindowSize: 1000000,
      contextPercent: 0.9238,
    });
    await adapter.disconnect();
  });

  it('interrupt cancels on the wire and completes the turn interrupted, keeping the session', async () => {
    const { adapter, patches, notify, stop, settle } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    await adapter.interrupt({ turnId: 't1' });

    // A real cancel: nothing is killed and the ACP session survives.
    expect(notify).toHaveBeenCalledWith('session/cancel', {
      sessionId: SESSION_ID,
    });
    expect(stop).not.toHaveBeenCalled();

    await settle('cancelled');
    expect(
      patches.find((p) => p.type === 'agent-turn-completed-v2')
    ).toMatchObject({ turnId: 't1', status: 'interrupted' });
    expect(adapter.status).toBe('connected');
    await adapter.disconnect();
  });

  it('interrupt is a no-op without a matching active turn', async () => {
    const { adapter, notify, settle } = harness();
    await adapter.connect(config);
    await adapter.interrupt({ turnId: 't1' });
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    await adapter.interrupt({ turnId: 'other' });
    expect(notify).not.toHaveBeenCalled();
    await settle('end_turn');
    await adapter.disconnect();
  });

  it('fails the turn with a readable message for a non end_turn stop reason', async () => {
    const { adapter, patches, settle } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    await settle('max_tokens');
    expect(patches.find((p) => p.type === 'agent-error-v2')).toMatchObject({
      message: 'dsh hit its output-token limit',
    });
    expect(
      patches.find((p) => p.type === 'agent-turn-completed-v2')
    ).toMatchObject({
      status: 'failed',
      error: 'dsh hit its output-token limit',
    });
    await adapter.disconnect();
  });

  it('raises a permission request as an approval card and answers the peer request', async () => {
    const { adapter, patches, update, peerRequest, respond, settle } =
      harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    update({
      sessionUpdate: 'tool_call',
      toolCallId: BASH_CALL_ID,
      title: 'bash',
      kind: 'other',
      status: 'in_progress',
      rawInput: { command: 'rm -rf /outside' },
    });
    peerRequest(12, 'session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: BASH_CALL_ID },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });

    const card = itemsOf(patches, 'agent-item-started-v2').at(-1);
    expect(card).toMatchObject({
      type: 'approval',
      requestId: 'dsh-approval-12',
      kind: 'permission',
      // The card names the command, not the opaque call id.
      target: 'rm -rf /outside',
      status: 'pending',
      // The harness offers one-shot choices only and infers no durable grant.
      supported: { scopes: ['once'], amendmentTypes: [], canCancel: true },
    });
    expect(lastLive(patches)).toMatchObject({
      status: 'waiting',
      waitingOn: 'approval',
      activeRequestIds: ['dsh-approval-12'],
    });

    await adapter.respondToApproval({
      requestId: 'dsh-approval-12',
      decision: { kind: 'accept' },
    });
    expect(respond).toHaveBeenCalledWith(12, {
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(itemsOf(patches, 'agent-item-updated-v2').at(-1)).toMatchObject({
      type: 'approval',
      status: 'completed',
      respondedBy: 'user',
    });
    expect(lastLive(patches).waitingOn).toBe(null);

    await settle('end_turn');
    await adapter.disconnect();
  });

  it('sends the reject option for a declined approval', async () => {
    const { adapter, peerRequest, respond, settle } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    peerRequest(13, 'session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: BASH_CALL_ID },
      options: [],
    });
    await adapter.respondToApproval({
      requestId: 'dsh-approval-13',
      decision: { kind: 'decline' },
    });
    expect(respond).toHaveBeenCalledWith(13, {
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    });
    await settle('end_turn');
    await adapter.disconnect();
  });

  it('cancels an approval left outstanding when the turn ends', async () => {
    const { adapter, patches, peerRequest, respond, settle } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    peerRequest(14, 'session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: BASH_CALL_ID },
      options: [],
    });
    await settle('end_turn');
    // The provider is released on its own wire before the card is terminalized.
    expect(respond).toHaveBeenCalledWith(14, {
      outcome: { outcome: 'cancelled' },
    });
    const resolved = itemsOf(patches, 'agent-item-updated-v2').find(
      (item) => item.type === 'approval'
    );
    expect(resolved).toMatchObject({
      status: 'cancelled',
      respondedBy: 'timeout',
    });
    await adapter.disconnect();
  });

  it('answers a permission request that arrives with no Relay turn to own it', async () => {
    const { adapter, patches, peerRequest, respond } = harness();
    await adapter.connect(config);
    const before = patches.length;
    peerRequest(15, 'session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: BASH_CALL_ID },
      options: [],
    });
    expect(respond).toHaveBeenCalledWith(15, {
      outcome: { outcome: 'cancelled' },
    });
    expect(patches).toHaveLength(before);
    await adapter.disconnect();
  });

  it('answers an unknown peer request with method-not-found instead of hanging it', async () => {
    const { adapter, respondError, settle } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    adapter['client']?.emit('peerRequest', {
      id: 21,
      method: 'fs/read_text_file',
      params: {},
    });
    expect(respondError).toHaveBeenCalledWith(
      21,
      -32601,
      'Relay does not implement fs/read_text_file'
    );
    await settle('end_turn');
    await adapter.disconnect();
  });

  it('queues a second message and sends it after the first prompt settles, in order', async () => {
    const { adapter, prompt, settle } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'first' });
    const queued = queueSend(adapter, { turnId: 't2', content: 'second' });
    expect(prompt).toHaveBeenCalledTimes(1);

    await settle('end_turn');
    await queued;

    expect(prompt.mock.calls.map((call) => call[0])).toEqual([
      { sessionId: SESSION_ID, prompt: [{ type: 'text', text: 'first' }] },
      { sessionId: SESSION_ID, prompt: [{ type: 'text', text: 'second' }] },
    ]);
    await adapter.disconnect();
  });

  it('transport close fails the active turn, rejects the queue, and disconnects', async () => {
    const { adapter, client, patches } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    const queued = queueSend(adapter, { turnId: 't2', content: 'never sent' });

    client.emit('close', 1);

    expect(adapter.status).toBe('disconnected');
    expect(
      patches.find((p) => p.type === 'agent-turn-completed-v2')
    ).toMatchObject({ turnId: 't1', status: 'failed' });
    await expect(queued).rejects.toThrow(
      'dsh session ended before this queued message was sent.'
    );
    expect(lastLive(patches).status).toBe('disconnected');
  });

  it('a protocol error tears the transport down the same way', async () => {
    const { adapter, client, patches } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    client.emit('protocolError', new Error('Invalid dsh ACP JSON: bad'));
    expect(adapter.status).toBe('disconnected');
    expect(patches.find((p) => p.type === 'agent-error-v2')).toMatchObject({
      message: 'Invalid dsh ACP JSON: bad',
    });
  });

  it('fails the turn and stops the runtime when session/prompt is rejected', async () => {
    const { adapter, prompt, patches } = harness();
    await adapter.connect(config);
    prompt.mockRejectedValueOnce(new Error('dsh ACP server exited (code=1)'));
    // The prompt is issued in the background, so the rejection lands on the
    // TURN rather than on the caller's send.
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    await vi.waitFor(() => expect(adapter.status).toBe('disconnected'));
    expect(
      patches.find((p) => p.type === 'agent-turn-completed-v2')
    ).toMatchObject({ turnId: 't1', status: 'failed' });
  });

  it('rejects attachments before any turn patch, whether idle or behind a turn', async () => {
    const { adapter, patches, prompt, settle } = harness();
    await adapter.connect(config);
    await expect(
      adapter.sendMessage({
        turnId: 't1',
        content: 'look',
        attachments: [
          { type: 'image', path: '/tmp/a.png', mimeType: 'image/png' },
        ],
      })
    ).rejects.toThrow('does not accept attachments');
    expect(patches.some((p) => p.type === 'agent-turn-started-v2')).toBe(false);

    await adapter.sendMessage({ turnId: 't2', content: 'ok' });
    await expect(
      adapter.sendMessage({
        turnId: 't3',
        content: 'look again',
        attachments: [
          { type: 'image', path: '/tmp/b.png', mimeType: 'image/png' },
        ],
      })
    ).rejects.toThrow('does not accept attachments');
    const queuedAfter = queueSend(adapter, { turnId: 't4', content: 'later' });

    await settle('end_turn');
    await queuedAfter;

    expect(adapter.status).toBe('connected');
    const turnIds = patches
      .filter((p) => p.type === 'agent-turn-started-v2')
      .map((p) => (p.turn as Patch).id);
    expect(turnIds).toEqual(['t2', 't4']);
    expect(prompt).toHaveBeenLastCalledWith({
      sessionId: SESSION_ID,
      prompt: [{ type: 'text', text: 'later' }],
    });
    await adapter.disconnect();
  });

  it('resumeSession reopens the named session, and respondToInput rejects', async () => {
    const { adapter, request } = harness();
    await adapter.connect(config);
    await adapter.resumeSession('prior-9');
    expect(request).toHaveBeenCalledWith('session/resume', {
      sessionId: 'prior-9',
      cwd: '/repo',
      mcpServers: [],
    });
    await expect(
      adapter.respondToInput({ requestId: 'r', answers: {} })
    ).rejects.toThrow('dsh ACP questions are not mapped');
    await adapter.disconnect();
  });

  it('reconnect resumes the same conversation rather than starting over', async () => {
    const { adapter, request, settle } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    await settle('end_turn');
    request.mockClear();
    await adapter.reconnect();
    expect(request).toHaveBeenCalledWith('session/resume', {
      sessionId: SESSION_ID,
      cwd: '/repo',
      mcpServers: [],
    });
    await adapter.disconnect();
  });

  it('ignores updates for another session and logs, never throws, on unknown kinds', async () => {
    const { adapter, patches, update, client, settle } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    const before = patches.length;

    update(
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'other',
        content: { type: 'text', text: 'not ours' },
      },
      'some-other-session'
    );
    expect(patches).toHaveLength(before);

    expect(() => update({ sessionUpdate: 'plan', entries: [] })).not.toThrow();
    expect(() =>
      client.emit('notification', { method: 'never/heard/of/it', params: {} })
    ).not.toThrow();
    expect(patches).toHaveLength(before);
    await settle('end_turn');
    await adapter.disconnect();
  });

  it('surfaces a config_option_update as a debug provider extension', async () => {
    const { adapter, patches, update, settle } = harness();
    await adapter.connect(config);
    await adapter.sendMessage({ turnId: 't1', content: 'go' });
    update({
      sessionUpdate: 'config_option_update',
      configOptions: [{ id: 'model', currentValue: 'deepseek-v4-pro' }],
    });
    expect(itemsOf(patches, 'agent-item-started-v2').at(-1)).toMatchObject({
      type: 'providerExtension',
      namespace: 'dsh',
      payload: { kind: 'configOptions' },
      metadata: { eventVisibility: 'debug' },
    });
    await settle('end_turn');
    await adapter.disconnect();
  });
});
