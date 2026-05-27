import express from 'express';
import type { Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createContextInboxRouter,
  isTerminalInboxState,
  type ContextInboxStore,
  type CreateContextPacketInput,
  type CreateInboxMessageInput,
  type ListContextPacketsFilter,
  type ListInboxMessagesFilter,
  type UpdateInboxStateResult,
} from '../server/features/context-inbox-router.js';
import {
  TERMINAL_INBOX_MESSAGE_STATES,
  createContextPacketId,
  createInboxMessageId,
  type AnchorRef,
  type ContextPacket,
  type SessionInboxMessage,
  type SessionInboxMessageState,
} from '../shared/context-packet.js';
import { createFileResourceRef } from '../shared/file-resource-ref.js';
import type { AnchorStateResolver } from '../server/context-adapters/file-range.js';
import type { ResolveAnchorOutcome } from '../server/anchor-resolution.js';

// ---------------------------------------------------------------------------
// In-memory store implementing the #765 seam (#758 builds the SQLite version).
// It enforces the SAME transition guard #758 will: idempotent re-ack, terminal
// reject, PULL delivery (list/get flip queued → delivered).
// ---------------------------------------------------------------------------

const TERMINAL = new Set<SessionInboxMessageState>(TERMINAL_INBOX_MESSAGE_STATES);

// Allowed forward transitions. `delivered` is reached by PULL, not this map.
const ALLOWED_TRANSITIONS: Record<SessionInboxMessageState, Set<SessionInboxMessageState>> = {
  queued: new Set(['acknowledged']),
  delivered: new Set(['acknowledged']),
  acknowledged: new Set(['acknowledged', 'resolved', 'ignored']),
  resolved: new Set(),
  ignored: new Set(),
};

function createFakeStore(): ContextInboxStore & { _markDelivered: boolean } {
  const packets = new Map<string, ContextPacket>();
  const messages = new Map<string, SessionInboxMessage>();
  let packetSeq = 0;
  let messageSeq = 0;

  function deliverOnPull(message: SessionInboxMessage): SessionInboxMessage {
    if (message.state === 'queued') {
      const updated: SessionInboxMessage = {
        ...message,
        state: 'delivered',
        deliveredAt: new Date().toISOString(),
      };
      messages.set(message.id, updated);
      return updated;
    }
    return message;
  }

  const store: ContextInboxStore & { _markDelivered: boolean } = {
    _markDelivered: true,
    createPacket(input: CreateContextPacketInput): ContextPacket {
      const id = createContextPacketId(`test${packetSeq++}`);
      const packet: ContextPacket = {
        id,
        kind: input.kind,
        ...(input.anchor !== undefined ? { anchor: input.anchor } : {}),
        ...(input.fileRef !== undefined ? { fileRef: input.fileRef } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.binding !== undefined ? { binding: input.binding } : {}),
        createdBy: input.createdBy,
        createdAt: new Date().toISOString(),
      };
      packets.set(id, packet);
      return packet;
    },
    getPacket(id: string): ContextPacket | null {
      return packets.get(id) ?? null;
    },
    listPackets(filter?: ListContextPacketsFilter): ContextPacket[] {
      let all = [...packets.values()];
      if (filter?.nodeId) all = all.filter((p) => p.binding?.nodeId === filter.nodeId);
      if (filter?.workspaceId) all = all.filter((p) => p.binding?.workspaceId === filter.workspaceId);
      if (filter?.limit !== undefined) all = all.slice(0, filter.limit);
      return all;
    },
    createInboxMessage(input: CreateInboxMessageInput): SessionInboxMessage {
      const id = createInboxMessageId(`test${messageSeq++}`);
      const message: SessionInboxMessage = {
        id,
        ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
        ...(input.targetWorkContextId ? { targetWorkContextId: input.targetWorkContextId } : {}),
        contextPacketIds: input.contextPacketIds,
        ...(input.text !== undefined ? { text: input.text } : {}),
        state: 'queued',
        createdBy: input.createdBy,
        createdAt: new Date().toISOString(),
      };
      messages.set(id, message);
      return message;
    },
    listInboxMessages(filter: ListInboxMessagesFilter): SessionInboxMessage[] {
      let all = [...messages.values()];
      if (filter.targetSessionId) {
        all = all.filter((m) => m.targetSessionId === filter.targetSessionId);
      }
      if (filter.targetWorkContextId) {
        all = all.filter((m) => m.targetWorkContextId === filter.targetWorkContextId);
      }
      if (filter.state) all = all.filter((m) => m.state === filter.state);
      if (filter.limit !== undefined) all = all.slice(0, filter.limit);
      // PULL delivery side effect applies only to rows returned by the list.
      return all.map((m) => deliverOnPull(m));
    },
    getInboxMessage(id: string): SessionInboxMessage | null {
      const message = messages.get(id);
      if (!message) return null;
      return deliverOnPull(message);
    },
    updateInboxState(
      id: string,
      targetState: SessionInboxMessageState,
      _actorId?: string
    ): UpdateInboxStateResult {
      const message = messages.get(id);
      if (!message) return { ok: false, reason: 'not_found' };
      if (TERMINAL.has(message.state)) {
        return { ok: false, reason: 'terminal', currentState: message.state };
      }
      if (!ALLOWED_TRANSITIONS[message.state].has(targetState)) {
        return { ok: false, reason: 'invalid_transition', currentState: message.state };
      }
      const updated: SessionInboxMessage = {
        ...message,
        state: targetState,
        ...(targetState === 'acknowledged' ? { acknowledgedAt: new Date().toISOString() } : {}),
        ...(targetState === 'resolved' ? { resolvedAt: new Date().toISOString() } : {}),
        ...(targetState === 'ignored' ? { ignoredAt: new Date().toISOString() } : {}),
      };
      messages.set(id, updated);
      return { ok: true, message: updated };
    },
  };
  return store;
}

const ALL_CAPS = 'context:read,context:write,inbox:read,inbox:write';

let server: Server;
let baseUrl: string;

function mount(
  store: ContextInboxStore | null,
  resolveAnchorState?: AnchorStateResolver
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(
    createContextInboxRouter({
      requireAuth: (_req, _res, next) => next(),
      store,
      // Default to a resolver that never resolves (null) so existing tests stay
      // undecorated; the #760 decoration tests inject a real resolver.
      resolveAnchorState: resolveAnchorState ?? (async () => null),
    })
  );
  return new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function fileAnchorRef(): AnchorRef {
  return {
    ref: createFileResourceRef({
      nodeId: 'node1',
      path: '/repo/src/index.ts',
      intent: 'read',
      sha256: 'a'.repeat(64),
      mtimeMs: 1_000,
    }),
    lineRange: { startLine: 10, endLine: 20 },
    quote: 'const answer = 42;',
  };
}

async function req(
  method: string,
  path: string,
  opts: { caps?: string; body?: unknown } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.caps !== undefined) headers['x-relay-capabilities'] = opts.caps;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe('context/inbox gateway router', () => {
  beforeEach(async () => {
    await mount(createFakeStore());
  });

  it('round-trips context.create → context.get → context.list', async () => {
    const created = await req('POST', '/context', {
      caps: 'context:write',
      body: { kind: 'note', note: 'remember this', createdBy: 'agent_1' },
    });
    expect(created.status).toBe(201);
    expect(created.body.contextPacket.kind).toBe('note');
    expect(created.body.contextPacket.id).toMatch(/^cp:/);

    const id = created.body.contextPacket.id as string;
    const got = await req('GET', `/context/${encodeURIComponent(id)}`, { caps: 'context:read' });
    expect(got.status).toBe(200);
    expect(got.body.contextPacket.id).toBe(id);

    const listed = await req('GET', '/context', { caps: 'context:read' });
    expect(listed.status).toBe(200);
    expect(listed.body.contextPackets).toHaveLength(1);
  });

  it('inbox.send queues; inbox.list PULL-delivers (queued → delivered)', async () => {
    const sent = await req('POST', '/inbox', {
      caps: 'inbox:write',
      body: { targetSessionId: 'node1:s1', contextPacketIds: [], text: 'hi', createdBy: 'agent_1' },
    });
    expect(sent.status).toBe(201);
    expect(sent.body.message.state).toBe('queued');

    const listed = await req('GET', '/inbox?targetSessionId=node1:s1', { caps: 'inbox:read' });
    expect(listed.status).toBe(200);
    expect(listed.body.messages).toHaveLength(1);
    // PULL semantics: fetching flips queued → delivered.
    expect(listed.body.messages[0].state).toBe('delivered');
  });

  it('inbox.ack is idempotent and ack → resolve is terminal-guarded', async () => {
    const sent = await req('POST', '/inbox', {
      caps: 'inbox:write',
      body: { targetSessionId: 'node1:s2', contextPacketIds: [], createdBy: 'agent_1' },
    });
    const id = sent.body.message.id as string;

    const ack1 = await req('POST', `/inbox/${encodeURIComponent(id)}/ack`, { caps: 'inbox:write' });
    expect(ack1.status).toBe(200);
    expect(ack1.body.message.state).toBe('acknowledged');

    // Idempotent re-ack succeeds.
    const ack2 = await req('POST', `/inbox/${encodeURIComponent(id)}/ack`, { caps: 'inbox:write' });
    expect(ack2.status).toBe(200);
    expect(ack2.body.message.state).toBe('acknowledged');

    // Resolve from acknowledged is allowed → terminal.
    const resolved = await req('POST', `/inbox/${encodeURIComponent(id)}/resolve`, {
      caps: 'inbox:write',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.message.state).toBe('resolved');
    expect(isTerminalInboxState(resolved.body.message.state)).toBe(true);

    // Any transition out of a terminal state is rejected (SESSION_CONFLICT).
    const reAck = await req('POST', `/inbox/${encodeURIComponent(id)}/ack`, { caps: 'inbox:write' });
    expect(reAck.status).toBe(409);
    expect(reAck.body.error.code).toBe('SESSION_CONFLICT');
    expect(reAck.body.error.details.currentState).toBe('resolved');

    const reIgnore = await req('POST', `/inbox/${encodeURIComponent(id)}/ignore`, {
      caps: 'inbox:write',
    });
    expect(reIgnore.status).toBe(409);
    expect(reIgnore.body.error.code).toBe('SESSION_CONFLICT');
  });

  it('denies write verbs lacking the capability bit with 403 FORBIDDEN', async () => {
    // context:write missing.
    const create = await req('POST', '/context', {
      caps: 'context:read',
      body: { kind: 'note', note: 'x', createdBy: 'agent_1' },
    });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('FORBIDDEN');
    expect(create.body.error.details.capability).toBe('context:write');

    // inbox:write missing on ack.
    const ack = await req('POST', '/inbox/im:nope/ack', { caps: 'inbox:read' });
    expect(ack.status).toBe(403);
    expect(ack.body.error.code).toBe('FORBIDDEN');
    expect(ack.body.error.details.capability).toBe('inbox:write');
  });

  it('denies read verbs lacking the capability bit with 403 FORBIDDEN', async () => {
    const list = await req('GET', '/context', { caps: '' });
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('FORBIDDEN');
    expect(list.body.error.details.capability).toBe('context:read');

    const inbox = await req('GET', '/inbox?targetSessionId=node1:s1', { caps: ALL_CAPS.replace('inbox:read', '') });
    expect(inbox.status).toBe(403);
    expect(inbox.body.error.details.capability).toBe('inbox:read');
  });

  it('validates required addressing / fields', async () => {
    const noKind = await req('POST', '/context', {
      caps: 'context:write',
      body: { note: 'no kind' },
    });
    expect(noKind.status).toBe(400);
    expect(noKind.body.error.code).toBe('INVALID_ARGUMENT');

    const noTarget = await req('POST', '/inbox', {
      caps: 'inbox:write',
      body: { contextPacketIds: [], createdBy: 'agent_1' },
    });
    expect(noTarget.status).toBe(400);
    expect(noTarget.body.error.code).toBe('INVALID_ARGUMENT');

    const missing = await req('GET', '/context/cp:does-not-exist', { caps: 'context:read' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });
});

describe('context/inbox gateway router without a store', () => {
  it('returns 503 SERVER_UNAVAILABLE when the store seam is unwired', async () => {
    await mount(null);
    const res = await req('GET', '/context', { caps: 'context:read' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVER_UNAVAILABLE');
  });
});

// #760: derived `AnchorState` decoration wired into the read paths.
describe('context/inbox gateway router — #760 derived AnchorState decoration', () => {
  function resolverReturning(state: 'unchanged' | 'stale' | 'missing'): AnchorStateResolver {
    return async (): Promise<ResolveAnchorOutcome> => ({ state, current: null });
  }

  async function createFileAnchor(): Promise<string> {
    const created = await req('POST', '/context', {
      caps: 'context:write',
      body: { kind: 'file-anchor', anchor: fileAnchorRef(), createdBy: 'agent_1' },
    });
    expect(created.status).toBe(201);
    return created.body.contextPacket.id as string;
  }

  it('context.get decorates a file-anchor packet with derived anchorState', async () => {
    await mount(createFakeStore(), resolverReturning('stale'));
    const id = await createFileAnchor();
    const got = await req('GET', `/context/${encodeURIComponent(id)}`, { caps: 'context:read' });
    expect(got.status).toBe(200);
    expect(got.body.contextPacket.kind).toBe('file-anchor');
    // DERIVED at read time, surfaced — never stored.
    expect(got.body.contextPacket.anchorState).toBe('stale');
  });

  it('context.get leaves a note packet undecorated', async () => {
    await mount(createFakeStore(), resolverReturning('unchanged'));
    const created = await req('POST', '/context', {
      caps: 'context:write',
      body: { kind: 'note', note: 'no anchor here', createdBy: 'agent_1' },
    });
    const id = created.body.contextPacket.id as string;
    const got = await req('GET', `/context/${encodeURIComponent(id)}`, { caps: 'context:read' });
    expect(got.body.contextPacket.anchorState).toBeUndefined();
  });

  it('inbox.get attaches decorated referenced file-anchor packets', async () => {
    await mount(createFakeStore(), resolverReturning('unchanged'));
    const packetId = await createFileAnchor();
    const sent = await req('POST', '/inbox', {
      caps: 'inbox:write',
      body: { targetSessionId: 'node1:s9', contextPacketIds: [packetId], createdBy: 'agent_1' },
    });
    const msgId = sent.body.message.id as string;
    const got = await req('GET', `/inbox/${encodeURIComponent(msgId)}`, { caps: 'inbox:read' });
    expect(got.status).toBe(200);
    expect(got.body.message.contextPackets).toHaveLength(1);
    expect(got.body.message.contextPackets[0].anchorState).toBe('unchanged');
  });

  it('inbox.list decorates referenced packets and still PULL-delivers', async () => {
    await mount(createFakeStore(), resolverReturning('missing'));
    const packetId = await createFileAnchor();
    await req('POST', '/inbox', {
      caps: 'inbox:write',
      body: { targetSessionId: 'node1:s10', contextPacketIds: [packetId], createdBy: 'agent_1' },
    });
    const listed = await req('GET', '/inbox?targetSessionId=node1:s10', { caps: 'inbox:read' });
    expect(listed.status).toBe(200);
    expect(listed.body.messages).toHaveLength(1);
    // PULL delivery still happens alongside decoration.
    expect(listed.body.messages[0].state).toBe('delivered');
    expect(listed.body.messages[0].contextPackets[0].anchorState).toBe('missing');
  });
});
