import { describe, expect, it, vi } from 'vitest';
import {
  AcpClient,
  type AcpClientOptions,
} from '../../../server/acp-client.js';
import type { AdapterConfig } from '../../../server/protocol-adapter-v2.js';
import {
  AcpProtocolAdapter,
  ACP_PROTOCOL_VERSION,
  type AcpHarnessProfile,
} from '../../../server/protocol-adapters/acp-adapter.js';

type Patch = Record<string, unknown>;

const SESSION_ID = 'conf-acp-session';

const config: AdapterConfig = {
  cwd: '/repo',
  port: 1,
  sessionId: 'relay-session',
  hookToken: 'x',
  configDir: '/tmp',
};

function harness(options: {
  initResult: Record<string, unknown>;
  resumeStrategy?: AcpHarnessProfile['resumeStrategy'];
  onLoadReplay?: (client: AcpClient) => void;
  authMethodId?: string | null;
  permissionPolicy?: AcpHarnessProfile['permissionPolicy'];
  firstUpdateTimeoutMs?: number;
}) {
  const client = new AcpClient({ command: 'acp-test' });
  client.setMaxListeners(50);

  const start = vi
    .spyOn(client, 'start')
    .mockResolvedValue(options.initResult as any);

  const request = vi
    .spyOn(client, 'request')
    .mockImplementation(async (method: string) => {
      if (method === 'session/load') options.onLoadReplay?.(client);
      if (method === 'session/new' || method === 'session/load')
        return { sessionId: SESSION_ID };
      if (method === 'session/resume') return { sessionId: SESSION_ID };
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
  const profile: AcpHarnessProfile = {
    agentType: 'acp-test',
    displayName: 'ACP Test',
    capabilities: {
      text: true,
      reasoning: true,
      tools: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      questions: true,
      plans: true,
      slashCommands: false,
      queue: true,
      steer: false,
      cancelQueued: false,
      interrupt: true,
      resume: true,
      fork: false,
      rollback: false,
      compact: false,
      telemetry: true,
      rateLimits: false,
      streaming: true,
    },
    providerNamespace: 'acp-test',
    providerSessionKey: 'acpSessionId',
    command: 'acp-test',
    args: ['acp'],
    resumeStrategy: options.resumeStrategy ?? 'auto',
    ...(options.authMethodId !== undefined
      ? { authMethodId: options.authMethodId }
      : {}),
    ...(options.permissionPolicy
      ? { permissionPolicy: options.permissionPolicy }
      : {}),
    ...(options.firstUpdateTimeoutMs !== undefined
      ? { firstUpdateTimeoutMs: options.firstUpdateTimeoutMs }
      : {}),
  };

  const adapter = new AcpProtocolAdapter(profile, (factoryOptions) => {
    clientFactoryOptions.push(factoryOptions);
    return client;
  });

  const patches: Patch[] = [];
  adapter.onPatch((patch) => patches.push(patch as any));

  return {
    adapter,
    client,
    patches,
    start,
    request,
    prompt,
    notify,
    respond,
    respondError,
    stop,
    settlePrompt: (stopReason = 'end_turn') => {
      if (!settlePrompt) throw new Error('no prompt in flight to settle');
      const resolve = settlePrompt;
      settlePrompt = null;
      resolve({ stopReason });
    },
  };
}

function agentItemPatches(patches: Patch[]): Patch[] {
  return patches.filter(
    (p) => typeof p.type === 'string' && String(p.type).startsWith('agent-item')
  );
}

describe('AcpProtocolAdapter (base)', () => {
  it('fails the handshake on protocol version mismatch', async () => {
    const h = harness({
      initResult: {
        protocolVersion: 2,
        agentCapabilities: {},
        authMethods: [],
      },
    });
    await expect(h.adapter.connect(config)).rejects.toThrow(
      /protocol version/i
    );
    expect(h.adapter.status).toBe('disconnected');
    expect(h.stop).toHaveBeenCalled();
  });

  it('never calls session/load when loadSession is absent (even if requested)', async () => {
    const h = harness({
      initResult: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { sessionCapabilities: { list: {} } },
        authMethods: [],
      },
      resumeStrategy: 'load',
    });
    await h.adapter.connect({ ...config, resumeSessionId: 'prior' });
    expect(h.request).toHaveBeenCalledWith('session/new', {
      cwd: '/repo',
      mcpServers: [],
    });
    expect(h.request).not.toHaveBeenCalledWith(
      'session/load',
      expect.anything()
    );
    await h.adapter.disconnect();
  });

  it('never calls session/resume when resume capability is absent (even if requested)', async () => {
    const h = harness({
      initResult: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {} },
        },
        authMethods: [],
      },
      resumeStrategy: 'resume',
    });
    await h.adapter.connect({ ...config, resumeSessionId: 'prior' });
    expect(h.request).toHaveBeenCalledWith('session/new', {
      cwd: '/repo',
      mcpServers: [],
    });
    expect(h.request).not.toHaveBeenCalledWith(
      'session/resume',
      expect.anything()
    );
    await h.adapter.disconnect();
  });

  it('posts a transcript fallback error when resuming is requested without a capability', async () => {
    const h = harness({
      initResult: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { sessionCapabilities: { list: {} } },
        authMethods: [],
      },
      resumeStrategy: 'load',
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
          String(p.message).includes(
            'could not resume the previous session (session/load capability unavailable)'
          )
      )
    ).toBe(true);
    await h.adapter.disconnect();
  });

  it('posts a transcript fallback error when resume is explicitly disabled by strategy', async () => {
    const h = harness({
      initResult: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { sessionCapabilities: { list: {} } },
        authMethods: [],
      },
      resumeStrategy: 'none',
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
          String(p.message).includes(
            'could not resume the previous session (resume strategy is none)'
          )
      )
    ).toBe(true);
    await h.adapter.disconnect();
  });

  it('fails the handshake when session/new returns no sessionId', async () => {
    const h = harness({
      initResult: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { sessionCapabilities: { list: {} } },
        authMethods: [],
      },
    });
    h.request.mockImplementation(async (method: string) => {
      if (method === 'session/new') return {};
      return {};
    });
    await expect(h.adapter.connect(config)).rejects.toThrow(/no sessionid/i);
    expect(h.adapter.status).toBe('disconnected');
    expect(h.stop).toHaveBeenCalled();
  });

  it('fails the handshake when authenticate fails (auth gates connect)', async () => {
    const h = harness({
      initResult: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { sessionCapabilities: { list: {} } },
        authMethods: [{ id: 'login', name: 'Login' }],
      },
      authMethodId: 'login',
    });
    h.request.mockImplementation(async (method: string) => {
      if (method === 'authenticate') throw new Error('Not logged in');
      if (method === 'session/new') return { sessionId: SESSION_ID };
      return {};
    });
    await expect(h.adapter.connect(config)).rejects.toThrow(/not logged in/i);
    expect(h.request).toHaveBeenCalledWith('authenticate', {
      methodId: 'login',
    });
    expect(h.request).not.toHaveBeenCalledWith(
      'session/new',
      expect.anything()
    );
    expect(h.stop).toHaveBeenCalled();
  });

  it('yolo auto-approves permission requests at the base level when policy enables it', async () => {
    const h = harness({
      initResult: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { sessionCapabilities: { list: {}, resume: {} } },
        authMethods: [],
      },
      permissionPolicy: () => ({ yoloAutoApprove: true }),
    });
    await h.adapter.connect({ ...config, permissionMode: 'yolo' } as any);
    await h.adapter.sendMessage({ turnId: 't1', content: 'go' });

    h.client.emit('peerRequest', {
      id: 12,
      method: 'session/request_permission',
      params: {
        sessionId: SESSION_ID,
        toolCall: {
          toolCallId: 'tool-1',
          title: '`echo YOLO`',
          kind: 'execute',
        },
        options: [{ optionId: 'allow-once', kind: 'allow_once' }],
      },
    });

    expect(h.respond).toHaveBeenCalledWith(12, {
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(
      h.patches.some(
        (p) =>
          p.type === 'agent-item-started-v2' &&
          (p.item as any).type === 'approval'
      )
    ).toBe(false);

    h.settlePrompt('end_turn');
    await h.adapter.disconnect();
  });

  it('posts a transcript fallback error when the resume capability is wholly absent', async () => {
    const h = harness({
      initResult: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      },
      resumeStrategy: 'load',
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
          String(p.message).includes(
            'could not resume the previous session (session/load capability unavailable)'
          )
      )
    ).toBe(true);
    await h.adapter.disconnect();
  });

  it('fails a turn that produces no session/update within firstUpdateTimeoutMs', async () => {
    vi.useFakeTimers();
    const h = harness({
      initResult: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { sessionCapabilities: { list: {}, resume: {} } },
        authMethods: [],
      },
      firstUpdateTimeoutMs: 50,
    });
    await h.adapter.connect(config);
    await h.adapter.sendMessage({ turnId: 't1', content: 'go' });

    await vi.advanceTimersByTimeAsync(55);
    await vi.waitFor(() =>
      expect(
        h.patches.some(
          (p) => p.type === 'agent-turn-completed-v2' && p.turnId === 't1'
        )
      ).toBe(true)
    );
    expect(h.notify).toHaveBeenCalledWith('session/cancel', {
      sessionId: SESSION_ID,
    });
    expect(
      h.patches.some(
        (p) =>
          p.type === 'agent-error-v2' &&
          String(p.message).includes('no session/update')
      )
    ).toBe(true);

    // Let the in-flight prompt settle without affecting the already-failed turn.
    h.settlePrompt('end_turn');
    await h.adapter.disconnect();
    vi.useRealTimers();
  });

  it('drops session/load history replay because no turn is active', async () => {
    const h = harness({
      initResult: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {} },
        },
        authMethods: [],
      },
      resumeStrategy: 'load',
      onLoadReplay: (client) => {
        client.emit('notification', {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'replay-tool-1',
              title: '`echo replay`',
              kind: 'execute',
              rawInput: { command: 'echo replay' },
            },
          },
        });
        client.emit('notification', {
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'old-msg',
              content: { type: 'text', text: 'historical text' },
            },
          },
        });
        client.emit('peerRequest', {
          id: 99,
          method: 'session/request_permission',
          params: {
            sessionId: SESSION_ID,
            toolCall: { toolCallId: 'replay-tool-1' },
            options: [{ optionId: 'allow-once', kind: 'allow_once' }],
          },
        });
      },
    });

    await h.adapter.connect({ ...config, resumeSessionId: 'prior' });
    expect(agentItemPatches(h.patches)).toHaveLength(0);
    // Permission request replay must be released on the wire.
    expect(h.respond).toHaveBeenCalledWith(99, {
      outcome: { outcome: 'cancelled' },
    });
    await h.adapter.disconnect();
  });

  it('selects permission option by kind with arbitrary optionIds', async () => {
    const h = harness({
      initResult: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { sessionCapabilities: { list: {}, resume: {} } },
        authMethods: [],
      },
    });
    await h.adapter.connect(config);
    await h.adapter.sendMessage({ turnId: 't1', content: 'go' });

    // Tie the approval target to a tool.
    h.client.emit('notification', {
      method: 'session/update',
      params: {
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: '`rm -rf /`',
          kind: 'execute',
          rawInput: { command: 'rm -rf /' },
        },
      },
    });

    h.client.emit('peerRequest', {
      id: 12,
      method: 'session/request_permission',
      params: {
        sessionId: SESSION_ID,
        toolCall: { toolCallId: 'tool-1' },
        options: [
          { optionId: 'opt-abc', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'opt-def', kind: 'reject_once', name: 'Reject' },
        ],
      },
    });

    await h.adapter.respondToApproval({
      requestId: 'acp-test-approval-12',
      decision: { kind: 'accept', scope: 'once' },
    });

    expect(h.respond).toHaveBeenCalledWith(12, {
      outcome: { outcome: 'selected', optionId: 'opt-abc' },
    });

    h.settlePrompt('end_turn');
    await h.adapter.disconnect();
  });

  it('interrupt answers an outstanding permission request with cancelled', async () => {
    const h = harness({
      initResult: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { sessionCapabilities: { list: {}, resume: {} } },
        authMethods: [],
      },
    });
    await h.adapter.connect(config);
    await h.adapter.sendMessage({ turnId: 't1', content: 'go' });

    h.client.emit('peerRequest', {
      id: 33,
      method: 'session/request_permission',
      params: {
        sessionId: SESSION_ID,
        toolCall: { toolCallId: 'tool-1' },
        options: [{ optionId: 'allow-once', kind: 'allow_once' }],
      },
    });

    await h.adapter.interrupt({ turnId: 't1' });
    expect(h.respond).toHaveBeenCalledWith(33, {
      outcome: { outcome: 'cancelled' },
    });
    expect(h.notify).toHaveBeenCalledWith('session/cancel', {
      sessionId: SESSION_ID,
    });
    h.settlePrompt('cancelled');
    await h.adapter.disconnect();
  });

  it('answers unknown peer requests with -32601 and ignores unknown notifications', async () => {
    const h = harness({
      initResult: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { sessionCapabilities: { list: {} } },
        authMethods: [],
      },
    });
    await h.adapter.connect(config);
    await h.adapter.sendMessage({ turnId: 't1', content: 'go' });

    h.client.emit('peerRequest', {
      id: 21,
      method: 'fs/read_text_file',
      params: {},
    });
    expect(h.respondError).toHaveBeenCalledWith(
      21,
      -32601,
      'Relay does not implement fs/read_text_file'
    );

    const before = h.patches.length;
    expect(() =>
      h.client.emit('notification', { method: 'never/heard/of/it', params: {} })
    ).not.toThrow();
    expect(h.patches).toHaveLength(before);

    h.settlePrompt('end_turn');
    await h.adapter.disconnect();
  });
});
