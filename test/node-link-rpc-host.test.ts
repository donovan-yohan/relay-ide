import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createNodeLinkRpcHost } from '../server/node-link-rpc-host.js';
import type {
  RelayNodeEnvelope,
  RelayNodeError,
} from '../shared/relay-node-protocol.js';
import {
  RELAY_NODE_LINK_PROTOCOL,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
} from '../shared/relay-node-protocol.js';
import type { LocalRelayNode } from '../server/local-node.js';
import type { CreateParams } from '../server/sessions.js';
import type { CreateWebParams } from '../server/web-session-handler.js';
import type { SessionSummary } from '../server/types.js';

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    type: 'terminal',
    agent: 'claude',
    mode: 'pty',
    cwd: '/home/user',
    repoName: '',
    displayName: 'raw shell',
    createdAt: '2026-01-02T03:04:05.000Z',
    lastActivity: '2026-01-02T03:04:05.000Z',
    idle: false,
    customCommand: null,
    status: 'active',
    needsBranchRename: false,
    agentState: 'idle',
    ...overrides,
  };
}

function envelope(
  type: string,
  payload: unknown,
  overrides: Partial<RelayNodeEnvelope> = {}
): RelayNodeEnvelope {
  return {
    protocol: RELAY_NODE_LINK_PROTOCOL,
    protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
    nodeId: 'node-a',
    channel: 'rpc',
    type,
    timestamp: '2026-01-02T03:04:05.000Z',
    requestId: 'req-1',
    payload,
    ...overrides,
  };
}

function context() {
  const sent: RelayNodeEnvelope[] = [];
  return {
    sent,
    ctx: {
      send: (env: RelayNodeEnvelope) => sent.push(env),
      buildEnvelope: (
        channel: RelayNodeEnvelope['channel'],
        type: string,
        extras: Partial<RelayNodeEnvelope> = {}
      ): RelayNodeEnvelope => ({
        protocol: RELAY_NODE_LINK_PROTOCOL,
        protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
        nodeId: 'node-a',
        channel,
        type,
        timestamp: '2026-01-02T03:04:06.000Z',
        ...extras,
      }),
    },
  };
}

function fakeLocalNode(overrides: Partial<LocalRelayNode['sessions']> = {}) {
  const stub: LocalRelayNode = {
    nodeId: 'node-a',
    environmentId: 'env-a' as never,
    authority: () => ({ nodeId: 'node-a', environmentId: 'env-a' }) as never,
    sessionEventScope: () => ({}) as never,
    fileEventScope: () => ({}) as never,
    sessions: {
      list: () => [],
      get: () => undefined,
      create: vi.fn().mockReturnValue({ ...summary(), pid: 1234 }),
      createWeb: vi
        .fn()
        .mockResolvedValue({ session: summary({ mode: 'web' }) }),
      kill: () => {},
      updateDisplayName: (id, displayName) => ({ id, displayName }),
      write: () => {},
      ...overrides,
    } as LocalRelayNode['sessions'],
  };
  return stub;
}

describe('node-link-rpc-host', () => {
  it('dispatches sessions.create to localRelayNode and strips pid from the response', () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(
      envelope('sessions.create', {
        type: 'terminal',
        cwd: '/home/user',
        sessionLane: 'remote-cwd',
      }),
      ctx
    );

    expect(localRelayNode.sessions.create).toHaveBeenCalledTimes(1);
    expect(
      (localRelayNode.sessions.create as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]
    ).toMatchObject({
      type: 'terminal',
      cwd: '/home/user',
      sessionLane: 'remote-cwd',
    });
    expect(sent).toHaveLength(1);
    const reply = sent[0]!;
    expect(reply.channel).toBe('rpc');
    expect(reply.type).toBe('sessions.create.result');
    expect(reply.requestId).toBe('req-1');
    const replyPayload = reply.payload as { session: SessionSummary };
    expect(replyPayload.session.id).toBe('sess-1');
    expect(replyPayload.session).not.toHaveProperty('pid');
  });

  it('passes routed terminalBackend and rejects legacy routed useTmux', () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const ok = context();

    host.handle(
      envelope('sessions.create', {
        type: 'terminal',
        cwd: '/home/user',
        terminalBackend: 'relay-pty',
      }),
      ok.ctx
    );

    expect(localRelayNode.sessions.create).toHaveBeenCalledTimes(1);
    expect(
      (localRelayNode.sessions.create as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]
    ).toMatchObject({ terminalBackend: 'relay-pty' });

    const legacy = context();
    host.handle(
      envelope('sessions.create', {
        type: 'terminal',
        cwd: '/home/user',
        useTmux: false,
      }),
      legacy.ctx
    );

    expect(localRelayNode.sessions.create).toHaveBeenCalledTimes(1);
    expect(legacy.sent[0]).toMatchObject({
      type: 'sessions.create.error',
      error: {
        code: 'INVALID_REQUEST',
        message:
          'sessions.create payload.useTmux is no longer supported; use terminalBackend',
      },
    });

    const invalid = context();
    host.handle(
      envelope('sessions.create', {
        type: 'terminal',
        cwd: '/home/user',
        terminalBackend: 'tmuxx',
      }),
      invalid.ctx
    );

    expect(localRelayNode.sessions.create).toHaveBeenCalledTimes(1);
    expect(invalid.sent[0]).toMatchObject({
      type: 'sessions.create.error',
      error: {
        code: 'INVALID_REQUEST',
        message:
          'sessions.create payload.terminalBackend must be "relay-pty" or "tmux-compat"',
      },
    });
  });

  it('defaults routed terminal creates to a shell command instead of the agent command', () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { ctx } = context();

    host.handle(
      envelope('sessions.create', {
        type: 'terminal',
        cwd: '/Users/ebi/project',
        workContextId: 'wc:issue-584',
      }),
      ctx
    );

    const createCall = (
      localRelayNode.sessions.create as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0] as CreateParams;
    expect(createCall).toMatchObject({
      type: 'terminal',
      cwd: '/Users/ebi/project',
      command:
        process.env.SHELL ??
        (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'),
      controlState: {
        controlMode: 'human-driven',
        controlFreshness: 'fresh',
        controlReason: 'routed-session-created',
      },
    });
  });

  it('routes native agent creates to the selected runtime instead of a shell fallback', () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { ctx } = context();

    host.handle(
      envelope('sessions.create', {
        type: 'agent',
        agent: 'codex',
        cwd: '/Users/ebi/project',
        command: process.env.SHELL ?? '/bin/sh',
        displayName: 'Remote Codex worker',
      }),
      ctx
    );

    const createCall = (
      localRelayNode.sessions.create as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0] as CreateParams;
    expect(createCall).toMatchObject({
      type: 'agent',
      agent: 'codex',
      cwd: '/Users/ebi/project',
      controlState: {
        controlMode: 'agent-driven',
        controlFreshness: 'fresh',
        controlReason: 'requested-initial-agent-driven',
      },
    });
    expect(createCall).not.toHaveProperty('command');
  });

  it('turns requested initial agent-driven control mode into fresh control state before dispatch', () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(
      envelope('sessions.create', {
        id: 'worker-session-1',
        type: 'agent',
        cwd: '/home/user/project',
        displayName: 'Remote Codex worker',
        controlMode: 'agent-driven',
      }),
      ctx
    );

    expect(localRelayNode.sessions.create).toHaveBeenCalledTimes(1);
    const createCall = (
      localRelayNode.sessions.create as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0] as CreateParams;
    expect(createCall).toMatchObject({
      id: 'worker-session-1',
      type: 'agent',
      cwd: '/home/user/project',
      controlState: {
        controlMode: 'agent-driven',
        activeActors: [
          {
            kind: 'agent',
            id: 'worker-session-1',
            displayName: 'Remote Codex worker',
          },
        ],
        activeWorker: {
          kind: 'agent',
          id: 'worker-session-1',
          displayName: 'Remote Codex worker',
        },
        controlFreshness: 'fresh',
        controlReason: 'requested-initial-agent-driven',
      },
    });
    expect(createCall).not.toHaveProperty('controlMode');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('sessions.create.result');
  });

  it('defaults routed agent creates without controlMode to agent-driven control state', () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(
      envelope('sessions.create', {
        id: 'worker-session-2',
        type: 'agent',
        cwd: '/home/user/project',
        displayName: 'Remote Codex worker',
      }),
      ctx
    );

    expect(localRelayNode.sessions.create).toHaveBeenCalledTimes(1);
    const createCall = (
      localRelayNode.sessions.create as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0] as CreateParams;
    expect(createCall).toMatchObject({
      id: 'worker-session-2',
      type: 'agent',
      cwd: '/home/user/project',
      controlState: {
        controlMode: 'agent-driven',
        activeActors: [
          {
            kind: 'agent',
            id: 'worker-session-2',
            displayName: 'Remote Codex worker',
          },
        ],
        activeWorker: {
          kind: 'agent',
          id: 'worker-session-2',
          displayName: 'Remote Codex worker',
        },
        controlFreshness: 'fresh',
        controlReason: 'requested-initial-agent-driven',
      },
    });
    expect(createCall).not.toHaveProperty('controlMode');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('sessions.create.result');
  });

  it('keeps explicit human-driven agent creates human-driven before dispatch', () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(
      envelope('sessions.create', {
        id: 'operator-session-1',
        type: 'agent',
        cwd: '/home/user/project',
        displayName: 'Remote terminal-like agent tab',
        controlMode: 'human-driven',
      }),
      ctx
    );

    expect(localRelayNode.sessions.create).toHaveBeenCalledTimes(1);
    const createCall = (
      localRelayNode.sessions.create as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0] as CreateParams;
    expect(createCall).toMatchObject({
      id: 'operator-session-1',
      type: 'agent',
      cwd: '/home/user/project',
      controlState: {
        controlMode: 'human-driven',
        activeActors: [
          {
            kind: 'human',
            id: 'browser-user',
            displayName: 'Remote terminal-like agent tab',
            sessionId: 'operator-session-1',
          },
        ],
        controlFreshness: 'fresh',
        controlReason: 'routed-session-created',
      },
    });
    expect(createCall).not.toHaveProperty('controlMode');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('sessions.create.result');
  });

  it('rejects requested agent-driven initial control for terminal sessions', () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(
      envelope('sessions.create', { type: 'terminal', controlMode: 'agent-driven' }),
      ctx
    );

    expect(localRelayNode.sessions.create).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('sessions.create.error');
    const err = sent[0]!.error as RelayNodeError;
    expect(err.code).toBe('INVALID_REQUEST');
    expect(err.message).toContain('agent sessions');
  });

  it('defaults missing cwd to os.homedir() so routed creates from the picker never spawn with undefined', () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(envelope('sessions.create', { type: 'terminal' }), ctx);

    expect(localRelayNode.sessions.create).toHaveBeenCalledTimes(1);
    const createCall = (
      localRelayNode.sessions.create as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0] as CreateParams;
    expect(createCall.cwd).toBe(os.homedir());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('sessions.create.result');
  });

  it('rejects incomplete mode:"web" remote session creates before dispatch', async () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(
      envelope('sessions.create', {
        type: 'agent',
        mode: 'web',
        agent: 'hermes',
        cwd: '/home/user',
      }),
      ctx
    );

    // Keep the async flush so this fails if a future implementation
    // reintroduces the createWeb dispatch path.
    await new Promise((resolve) => setImmediate(resolve));

    expect(localRelayNode.sessions.create).not.toHaveBeenCalled();
    expect(localRelayNode.sessions.createWeb).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('sessions.create.error');
    const err = sent[0]!.error as RelayNodeError;
    expect(err.code).toBe('INVALID_REQUEST');
    expect(err.message).toContain('remote node web sessions are not supported');
  });

  it('rejects invalid session lane markers before dispatch', () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(
      envelope('sessions.create', { type: 'terminal', sessionLane: 'banana' }),
      ctx
    );

    expect(localRelayNode.sessions.create).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('sessions.create.error');
    const err = sent[0]!.error as RelayNodeError;
    expect(err.code).toBe('INVALID_REQUEST');
    expect(err.message).toContain('payload.sessionLane');
  });

  it('dispatches sessions.kill to localRelayNode', () => {
    const localRelayNode = fakeLocalNode({ kill: vi.fn() });
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(envelope('sessions.kill', { id: 'sess-1' }), ctx);

    expect(localRelayNode.sessions.kill).toHaveBeenCalledWith('sess-1');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      channel: 'rpc',
      type: 'sessions.kill.result',
      requestId: 'req-1',
      payload: { ok: true },
    });
  });

  it('responds with INVALID_REQUEST when sessions.kill payload is missing id', () => {
    const localRelayNode = fakeLocalNode({ kill: vi.fn() });
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(envelope('sessions.kill', {}), ctx);

    expect(localRelayNode.sessions.kill).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('sessions.kill.error');
    const err = sent[0]!.error as RelayNodeError;
    expect(err.code).toBe('INVALID_REQUEST');
  });

  it('responds with NOT_FOUND when sessions.kill cannot find the session', () => {
    const localRelayNode = fakeLocalNode({
      kill: (() => {
        throw new Error('Session not found: sess-missing');
      }) as never,
    });
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(envelope('sessions.kill', { id: 'sess-missing' }), ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('sessions.kill.error');
    const err = sent[0]!.error as RelayNodeError;
    expect(err.code).toBe('NOT_FOUND');
    expect(err.retryable).toBe(false);
  });

  it('responds with INVALID_REQUEST when payload is missing type', () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(envelope('sessions.create', { cwd: '/home/user' }), ctx);

    expect(localRelayNode.sessions.create).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('sessions.create.error');
    const err = sent[0]!.error as RelayNodeError;
    expect(err.code).toBe('INVALID_REQUEST');
  });

  it('responds with INTERNAL error when sessions.create throws', () => {
    const localRelayNode = fakeLocalNode({
      create: (() => {
        throw new Error('boom');
      }) as never,
    });
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(envelope('sessions.create', { type: 'terminal' }), ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('sessions.create.error');
    const err = sent[0]!.error as RelayNodeError;
    expect(err.code).toBe('INTERNAL');
    expect(err.message).toContain('boom');
  });

  it('responds with INVALID_REQUEST for unimplemented rpc methods rather than silently hanging', () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(envelope('manifest.refresh', {}), ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('manifest.refresh.error');
    const err = sent[0]!.error as RelayNodeError;
    expect(err.code).toBe('INVALID_REQUEST');
    expect(err.message).toContain('not implemented');
  });

  it('handles credential.rotate by invoking the configured credential installer', async () => {
    const localRelayNode = fakeLocalNode();
    const rotateCredential = vi.fn().mockResolvedValue(undefined);
    const host = createNodeLinkRpcHost({ localRelayNode, rotateCredential });
    const { sent, ctx } = context();
    const credential = {
      protocol: RELAY_NODE_LINK_PROTOCOL,
      protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
      nodeId: 'node-a',
      credentialId: 'cred_next',
      token: 'node-a.secret',
      issuedAt: '2026-01-02T03:04:05.000Z',
    };

    host.handle(envelope('credential.rotate', { credential }), ctx);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(rotateCredential).toHaveBeenCalledWith(credential);
    expect(sent[0]!.type).toBe('credential.rotate.result');
    expect(sent[0]!.payload).toMatchObject({
      ok: true,
      nodeId: 'node-a',
      credentialId: 'cred_next',
    });
  });

  it('rejects malformed credential.rotate payloads without calling the installer', async () => {
    const localRelayNode = fakeLocalNode();
    const rotateCredential = vi.fn();
    const host = createNodeLinkRpcHost({ localRelayNode, rotateCredential });
    const { sent, ctx } = context();

    host.handle(envelope('credential.rotate', { credential: { nodeId: 'node-a' } }), ctx);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(rotateCredential).not.toHaveBeenCalled();
    expect(sent[0]!.type).toBe('credential.rotate.error');
    const err = sent[0]!.error as RelayNodeError;
    expect(err.code).toBe('INVALID_REQUEST');
  });

  it('ignores envelopes from non-rpc channels', () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(envelope('control.heartbeat', {}, { channel: 'control' }), ctx);

    expect(sent).toHaveLength(0);
    expect(localRelayNode.sessions.create).not.toHaveBeenCalled();
  });

  it('returns redacted bounded remote node log snapshots', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-log-rpc-'));
    const logDir = path.join(tmp, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const bearerFixture = 'Bearer relay_bearer_token_fixture_123';
    const githubTokenFixture = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz';
    const pinFixture = 'PIN=123456';
    fs.writeFileSync(
      path.join(logDir, 'relay-ide.log'),
      [
        'line one',
        `Authorization: ${bearerFixture}`,
        `githubToken=${githubTokenFixture}`,
        pinFixture,
        'line five',
      ].join('\n'),
      'utf8'
    );
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({
      localRelayNode,
      localLogConfigPath: path.join(tmp, 'config.json'),
      localLogDir: logDir,
    });
    const { sent, ctx } = context();

    host.handle(envelope('logs.tail', { lines: 5 }), ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('logs.tail.result');
    const payload = sent[0]!.payload as { output: string; status: string };
    expect(payload.status).toBe('ok');
    expect(payload.output).toContain('line five');
    expect(payload.output).not.toContain(bearerFixture);
    expect(payload.output).not.toContain(githubTokenFixture);
    expect(payload.output).not.toContain(pinFixture);
    expect(payload.output).toContain('[REDACTED]');
  });

  it('returns NOT_FOUND and empty snapshots for remote node log edge cases', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-log-edge-'));
    const logDir = path.join(tmp, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({
      localRelayNode,
      localLogConfigPath: path.join(tmp, 'config.json'),
      localLogDir: logDir,
    });
    const missing = context();

    host.handle(envelope('logs.tail', { lines: 2 }), missing.ctx);

    expect(missing.sent).toHaveLength(1);
    expect(missing.sent[0]!.type).toBe('logs.tail.error');
    expect((missing.sent[0]!.error as RelayNodeError).code).toBe('NOT_FOUND');

    fs.writeFileSync(path.join(logDir, 'relay-ide.log'), '', 'utf8');
    const empty = context();
    host.handle(envelope('logs.tail', { lines: 2 }), empty.ctx);

    expect(empty.sent).toHaveLength(1);
    expect(empty.sent[0]!.type).toBe('logs.tail.result');
    expect(empty.sent[0]!.payload).toMatchObject({ status: 'empty', output: '' });
  });

  it('rejects malformed logs.tail follow requests with one error envelope', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-log-follow-invalid-'));
    const logDir = path.join(tmp, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'relay-ide.log'), 'initial\n', 'utf8');
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({
      localRelayNode,
      localLogConfigPath: path.join(tmp, 'config.json'),
      localLogDir: logDir,
    });
    const { sent, ctx } = context();

    host.handle(envelope('logs.tail', { lines: 1, follow: true }), ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('logs.tail.error');
    expect(sent.some((entry) => entry.type === 'logs.tail.result')).toBe(false);
    const err = sent[0]!.error as RelayNodeError;
    expect(err.code).toBe('INVALID_REQUEST');
    expect(err.message).toContain('streamId');
  });

  it('starts and cancels remote node log followers by streamId', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-log-follow-'));
    const logDir = path.join(tmp, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'relay-ide.log'), 'initial\n', 'utf8');
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({
      localRelayNode,
      localLogConfigPath: path.join(tmp, 'config.json'),
      localLogDir: logDir,
    });
    const { sent, ctx } = context();

    host.handle(
      envelope('logs.tail', { lines: 1, follow: true }, { streamId: 'stream-1' }),
      ctx
    );
    expect(sent[0]!.type).toBe('logs.tail.result');

    fs.appendFileSync(path.join(logDir, 'relay-ide.log'), 'Authorization: Bearer abc.def.secret\n', 'utf8');
    await vi.waitFor(() => {
      expect(sent.some((entry) => entry.type === 'logs.tail.chunk')).toBe(true);
    });
    const chunk = sent.find((entry) => entry.type === 'logs.tail.chunk')!.payload as { chunk: string };
    expect(chunk.chunk).not.toContain('abc.def.secret');

    host.handle(envelope('logs.tail.cancel', {}, { streamId: 'stream-1' }), ctx);
    const chunkCount = sent.filter((entry) => entry.type === 'logs.tail.chunk').length;
    fs.appendFileSync(path.join(logDir, 'relay-ide.log'), 'after cancel\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(sent.filter((entry) => entry.type === 'logs.tail.chunk')).toHaveLength(chunkCount);
  });

  it('rejects malformed fs.tail follow requests with one error envelope', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-file-tail-invalid-'));
    fs.writeFileSync(path.join(tmp, 'app.log'), 'initial\n', 'utf8');
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(
      envelope('fs.tail', {
        sessionId: 'sess-1',
        root: tmp,
        cwd: tmp,
        path: path.join(tmp, 'app.log'),
        follow: true,
      }),
      ctx
    );

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.type).toBe('fs.tail.error');
    expect(sent.some((entry) => entry.type === 'fs.tail.result')).toBe(false);
    const err = sent[0]!.error as RelayNodeError;
    expect(err.code).toBe('INVALID_REQUEST');
    expect(err.message).toContain('streamId');
  });

  it('starts and cancels bounded fs.tail followers by streamId', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-file-tail-follow-'));
    const target = path.join(tmp, 'app.log');
    fs.writeFileSync(target, 'initial\n', 'utf8');
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(
      envelope(
        'fs.tail',
        {
          sessionId: 'sess-1',
          root: tmp,
          cwd: tmp,
          path: target,
          maxBytes: 64,
          maxLines: 1,
          follow: true,
          maxFollowChunkBytes: 8,
        },
        { streamId: 'file-stream-1' }
      ),
      ctx
    );

    await vi.waitFor(() => expect(sent.some((entry) => entry.type === 'fs.tail.result')).toBe(true));
    expect(sent[0]!.payload).toMatchObject({
      operation: 'tail',
      content: 'initial\n',
      follow: true,
    });

    fs.appendFileSync(target, '123456789abcdef\n', 'utf8');
    await vi.waitFor(() => {
      expect(sent.some((entry) => entry.type === 'fs.tail.chunk')).toBe(true);
    });
    const chunk = sent.find((entry) => entry.type === 'fs.tail.chunk')!.payload as {
      content: string;
      truncatedBytes: boolean;
      skippedBytes: number;
    };
    expect(chunk.content).toBe('9abcdef\n');
    expect(chunk.truncatedBytes).toBe(true);
    expect(chunk.skippedBytes).toBeGreaterThan(0);

    host.handle(envelope('fs.tail.cancel', {}, { streamId: 'file-stream-1' }), ctx);
    const chunkCount = sent.filter((entry) => entry.type === 'fs.tail.chunk').length;
    fs.appendFileSync(target, 'after cancel\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(sent.filter((entry) => entry.type === 'fs.tail.chunk')).toHaveLength(chunkCount);
  });

  it('closes fs.tail followers with a typed retryable error when node-link writes backpressure', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-file-tail-backpressure-'));
    const target = path.join(tmp, 'app.log');
    fs.writeFileSync(target, 'initial\n', 'utf8');
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();
    const backpressureError: RelayNodeError = {
      code: 'NODE_BUSY',
      message: 'node link websocket send buffer stayed saturated',
      retryable: true,
      details: { reasonCode: 'FILE_RPC_FOLLOW_BACKPRESSURE' },
    };
    const sendWithBackpressure = vi.fn().mockRejectedValue(backpressureError);
    const backpressureCtx = { ...ctx, sendWithBackpressure };

    host.handle(
      envelope(
        'fs.tail',
        {
          sessionId: 'sess-1',
          root: tmp,
          cwd: tmp,
          path: target,
          maxBytes: 64,
          follow: true,
          maxFollowChunkBytes: 64,
        },
        { streamId: 'file-stream-slow' }
      ),
      backpressureCtx
    );

    await vi.waitFor(() => expect(sent.some((entry) => entry.type === 'fs.tail.result')).toBe(true));
    fs.appendFileSync(target, 'blocked\n', 'utf8');

    await vi.waitFor(() => expect(sendWithBackpressure).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sent.some((entry) => entry.type === 'fs.tail.error')).toBe(true));
    const errorEnvelope = sent.find((entry) => entry.type === 'fs.tail.error')!;
    expect((errorEnvelope.payload as { error: RelayNodeError }).error).toMatchObject({
      code: 'NODE_BUSY',
      retryable: true,
      details: { reasonCode: 'FILE_RPC_FOLLOW_BACKPRESSURE' },
    });

    fs.appendFileSync(target, 'after close\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sendWithBackpressure).toHaveBeenCalledTimes(1);
  });
});

// Surface unused CreateParams/CreateWebParams type imports so the
// editor doesn't strip them on auto-import cleanup; they document the
// payload shape the host coerces to.
void (null as unknown as CreateParams | undefined);
void (null as unknown as CreateWebParams | undefined);
