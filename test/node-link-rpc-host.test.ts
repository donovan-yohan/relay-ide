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
      envelope('sessions.create', { type: 'terminal', cwd: '/home/user' }),
      ctx
    );

    expect(localRelayNode.sessions.create).toHaveBeenCalledTimes(1);
    expect(
      (localRelayNode.sessions.create as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]
    ).toMatchObject({ type: 'terminal', cwd: '/home/user' });
    expect(sent).toHaveLength(1);
    const reply = sent[0]!;
    expect(reply.channel).toBe('rpc');
    expect(reply.type).toBe('sessions.create.result');
    expect(reply.requestId).toBe('req-1');
    const replyPayload = reply.payload as { session: SessionSummary };
    expect(replyPayload.session.id).toBe('sess-1');
    expect(replyPayload.session).not.toHaveProperty('pid');
  });

  it('routes mode:"web" sessions through createWeb', async () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(
      envelope('sessions.create', { type: 'agent', mode: 'web' }),
      ctx
    );

    // createWeb is async; flush microtasks.
    await new Promise((resolve) => setImmediate(resolve));

    expect(localRelayNode.sessions.createWeb).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('sessions.create.result');
    const payload = sent[0]!.payload as { session: SessionSummary };
    expect(payload.session.mode).toBe('web');
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

  it('ignores envelopes from non-rpc channels', () => {
    const localRelayNode = fakeLocalNode();
    const host = createNodeLinkRpcHost({ localRelayNode });
    const { sent, ctx } = context();

    host.handle(envelope('control.heartbeat', {}, { channel: 'control' }), ctx);

    expect(sent).toHaveLength(0);
    expect(localRelayNode.sessions.create).not.toHaveBeenCalled();
  });
});

// Surface unused CreateParams/CreateWebParams type imports so the
// editor doesn't strip them on auto-import cleanup; they document the
// payload shape the host coerces to.
void (null as unknown as CreateParams | undefined);
void (null as unknown as CreateWebParams | undefined);
