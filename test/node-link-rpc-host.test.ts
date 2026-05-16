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
    fs.writeFileSync(
      path.join(logDir, 'relay-ide.log'),
      'line one\nAuthorization: Bearer abc.def.secret\nline three\n',
      'utf8'
    );
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({
      localRelayNode,
      localLogConfigPath: path.join(tmp, 'config.json'),
      localLogDir: logDir,
    });
    const { sent, ctx } = context();

    host.handle(envelope('logs.tail', { lines: 2 }), ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('logs.tail.result');
    const payload = sent[0]!.payload as { output: string; status: string };
    expect(payload.status).toBe('ok');
    expect(payload.output).toContain('line three');
    expect(payload.output).not.toContain('abc.def.secret');
    expect(payload.output).toContain('[REDACTED]');
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
});

// Surface unused CreateParams/CreateWebParams type imports so the
// editor doesn't strip them on auto-import cleanup; they document the
// payload shape the host coerces to.
void (null as unknown as CreateParams | undefined);
void (null as unknown as CreateWebParams | undefined);
