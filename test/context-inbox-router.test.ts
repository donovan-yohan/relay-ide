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
import type {
  WorkContextStore,
  WorkContextLifecycleEventInput,
  WorkContextPatchInput,
} from '../server/work-contexts.js';
import {
  WORK_CONTEXT_SCHEMA_VERSION,
  createWorkContextPrivacyMetadata,
  type AuditEventRef,
  type WorkContext,
  type WorkContextId,
} from '../shared/work-context.js';

// ---------------------------------------------------------------------------
// In-memory store implementing the #765 seam (#758 builds the SQLite version).
// It enforces the SAME transition guard #758 will: idempotent re-ack, terminal
// reject, PULL delivery (list/get flip queued → delivered).
// ---------------------------------------------------------------------------

const TERMINAL = new Set<SessionInboxMessageState>(
  TERMINAL_INBOX_MESSAGE_STATES
);

// Allowed forward transitions. `delivered` is reached by PULL, not this map.
const ALLOWED_TRANSITIONS: Record<
  SessionInboxMessageState,
  Set<SessionInboxMessageState>
> = {
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
        ...(input.artifactRef !== undefined
          ? { artifactRef: input.artifactRef }
          : {}),
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
      if (filter?.nodeId)
        all = all.filter((p) => p.binding?.nodeId === filter.nodeId);
      if (filter?.workspaceId)
        all = all.filter((p) => p.binding?.workspaceId === filter.workspaceId);
      if (filter?.limit !== undefined) all = all.slice(0, filter.limit);
      return all;
    },
    createInboxMessage(input: CreateInboxMessageInput): SessionInboxMessage {
      const id = createInboxMessageId(`test${messageSeq++}`);
      const message: SessionInboxMessage = {
        id,
        ...(input.targetSessionId
          ? { targetSessionId: input.targetSessionId }
          : {}),
        ...(input.targetWorkContextId
          ? { targetWorkContextId: input.targetWorkContextId }
          : {}),
        contextPacketIds: input.contextPacketIds,
        ...(input.text !== undefined ? { text: input.text } : {}),
        state: 'queued',
        createdBy: input.createdBy,
        createdAt: new Date().toISOString(),
      };
      messages.set(id, message);
      return message;
    },
    listInboxMessages(
      filter: ListInboxMessagesFilter,
      options: { markDelivered?: boolean } = {}
    ): SessionInboxMessage[] {
      let all = [...messages.values()];
      if (filter.targetSessionId) {
        all = all.filter((m) => m.targetSessionId === filter.targetSessionId);
      }
      if (filter.targetWorkContextId) {
        all = all.filter(
          (m) => m.targetWorkContextId === filter.targetWorkContextId
        );
      }
      if (filter.state) all = all.filter((m) => m.state === filter.state);
      if (filter.limit !== undefined) all = all.slice(0, filter.limit);
      // PULL delivery side effect applies only to rows returned by the list.
      return options.markDelivered === false
        ? all
        : all.map((m) => deliverOnPull(m));
    },
    getInboxMessage(
      id: string,
      options: { markDelivered?: boolean } = {}
    ): SessionInboxMessage | null {
      const message = messages.get(id);
      if (!message) return null;
      if (options.markDelivered === false) return message;
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
        return {
          ok: false,
          reason: 'invalid_transition',
          currentState: message.state,
        };
      }
      const updated: SessionInboxMessage = {
        ...message,
        state: targetState,
        ...(targetState === 'acknowledged'
          ? { acknowledgedAt: new Date().toISOString() }
          : {}),
        ...(targetState === 'resolved'
          ? { resolvedAt: new Date().toISOString() }
          : {}),
        ...(targetState === 'ignored'
          ? { ignoredAt: new Date().toISOString() }
          : {}),
      };
      messages.set(id, updated);
      return { ok: true, message: updated };
    },
  };
  return store;
}

function createFakeWorkContext(id: WorkContextId): WorkContext {
  const now = new Date().toISOString();
  return {
    schemaVersion: WORK_CONTEXT_SCHEMA_VERSION,
    id,
    title: 'Pinned context test',
    createdAt: now,
    updatedAt: now,
    source: 'test',
    anchors: {},
    actors: [],
    tasks: [],
    artifacts: [],
    auditRefs: [],
    capabilityGrants: [],
    privacy: createWorkContextPrivacyMetadata(),
  };
}

function createFakeWorkContextStore(
  ...contexts: WorkContext[]
): WorkContextStore {
  const byId = new Map<WorkContextId, WorkContext>(
    contexts.map((ctx) => [ctx.id, ctx])
  );
  function replace(
    id: WorkContextId,
    patch: WorkContextPatchInput
  ): WorkContext {
    const existing = byId.get(id);
    if (!existing) throw new Error(`missing WorkContext ${id}`);
    const updated = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    byId.set(id, updated);
    return updated;
  }
  return {
    close: () => undefined,
    create: () => {
      throw new Error('not implemented');
    },
    get: (id: WorkContextId) => byId.get(id) ?? null,
    list: () => [...byId.values()],
    update: replace,
    linkContexts: () => {
      throw new Error('not implemented');
    },
    associateSession: () => {
      throw new Error('not implemented');
    },
    recordLifecycleEvent: (
      id: WorkContextId,
      input: WorkContextLifecycleEventInput
    ) => {
      const existing = byId.get(id);
      if (!existing) throw new Error(`missing WorkContext ${id}`);
      const event: AuditEventRef = {
        id: `audit:${input.type ?? 'event'}:${existing.auditRefs.length}`,
        eventId: input.eventId ?? `evt:${existing.auditRefs.length}`,
        ...(input.type ? { type: input.type } : {}),
        ...(input.actorId ? { actorId: input.actorId } : {}),
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        privacy: createWorkContextPrivacyMetadata(),
      };
      const updated = {
        ...existing,
        artifacts: input.artifacts
          ? [...existing.artifacts, ...input.artifacts]
          : existing.artifacts,
        auditRefs: [...existing.auditRefs, event],
        updatedAt: new Date().toISOString(),
      };
      byId.set(id, updated);
      return updated;
    },
    getResumeSnapshot: () => {
      throw new Error('not implemented');
    },
    listActiveWork: () => [],
    findSessionWorkContextIds: () => [],
  };
}

const ALL_CAPS = 'context:read,context:write,inbox:read,inbox:write';

let server: Server;
let baseUrl: string;

function mount(
  store: ContextInboxStore | null,
  resolveAnchorState?: AnchorStateResolver,
  workContextStore?: WorkContextStore
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(
    createContextInboxRouter({
      requireAuth: (_req, _res, next) => next(),
      store,
      workContextStore,
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
    await mount(
      createFakeStore(),
      undefined,
      createFakeWorkContextStore(createFakeWorkContext('wc:test'))
    );
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
    const got = await req('GET', `/context/${encodeURIComponent(id)}`, {
      caps: 'context:read',
    });
    expect(got.status).toBe(200);
    expect(got.body.contextPacket.id).toBe(id);

    const listed = await req('GET', '/context', { caps: 'context:read' });
    expect(listed.status).toBe(200);
    expect(listed.body.contextPackets).toHaveLength(1);
  });

  it('pins packets into a WorkContext, lists pinned packets by scope, and unpins without deleting the packet', async () => {
    const created = await req('POST', '/context', {
      caps: 'context:write',
      body: {
        kind: 'note',
        note: 'review this during handoff',
        createdBy: 'agent_1',
        binding: { nodeId: 'node1', workspaceId: 'workspace-a' },
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.contextPacket.id as string;

    const pinned = await req('POST', `/context/${encodeURIComponent(id)}/pin`, {
      caps: 'context:write',
      body: { workContextId: 'wc:test', actorId: 'agent_1' },
    });
    expect(pinned.status).toBe(201);
    expect(pinned.body.contextPacket.id).toBe(id);
    expect(pinned.body.alreadyPinned).toBe(false);
    expect(pinned.body.pinnedContextPackets).toHaveLength(1);
    expect(pinned.body.pinnedArtifacts[0].uri).toBe(
      `relay://context-packets/${encodeURIComponent(id)}`
    );
    expect(pinned.body.workContext.auditRefs[0].type).toBe('artifact.recorded');

    const idempotent = await req(
      'POST',
      `/context/${encodeURIComponent(id)}/pin`,
      {
        caps: 'context:write',
        body: { workContextId: 'wc:test', actorId: 'agent_1' },
      }
    );
    expect(idempotent.status).toBe(200);
    expect(idempotent.body.alreadyPinned).toBe(true);
    expect(idempotent.body.pinnedContextPackets).toHaveLength(1);

    const listed = await req(
      'GET',
      '/context?workContextId=wc%3Atest&nodeId=node1',
      { caps: 'context:read' }
    );
    expect(listed.status).toBe(200);
    expect(listed.body.contextPackets).toHaveLength(1);
    expect(listed.body.contextPackets[0].id).toBe(id);
    expect(listed.body.pinnedArtifacts).toHaveLength(1);

    const unpinned = await req(
      'POST',
      `/context/${encodeURIComponent(id)}/unpin`,
      {
        caps: 'context:write',
        body: { workContextId: 'wc:test', actorId: 'agent_1' },
      }
    );
    expect(unpinned.status).toBe(200);
    expect(unpinned.body.removed).toBe(true);
    expect(unpinned.body.lifecycle.packetDeleted).toBe(false);
    expect(unpinned.body.workContext.auditRefs.at(-1).type).toBe(
      'artifact.unpinned'
    );

    const listedAfter = await req('GET', '/context?workContextId=wc%3Atest', {
      caps: 'context:read',
    });
    expect(listedAfter.status).toBe(200);
    expect(listedAfter.body.contextPackets).toHaveLength(0);
    const retained = await req('GET', `/context/${encodeURIComponent(id)}`, {
      caps: 'context:read',
    });
    expect(retained.status).toBe(200);
    expect(retained.body.contextPacket.id).toBe(id);
  });

  it('inbox.send queues; inbox.list PULL-delivers (queued → delivered)', async () => {
    const sent = await req('POST', '/inbox', {
      caps: 'inbox:write',
      body: {
        targetSessionId: 'node1:s1',
        contextPacketIds: [],
        text: 'hi',
        createdBy: 'agent_1',
      },
    });
    expect(sent.status).toBe(201);
    expect(sent.body.message.state).toBe('queued');

    const listed = await req('GET', '/inbox?targetSessionId=node1:s1', {
      caps: 'inbox:read',
    });
    expect(listed.status).toBe(200);
    expect(listed.body.messages).toHaveLength(1);
    // PULL semantics: fetching flips queued → delivered.
    expect(listed.body.messages[0].state).toBe('delivered');
  });

  it('inbox.preview lists without PULL-delivering queued messages', async () => {
    const sent = await req('POST', '/inbox', {
      caps: 'inbox:write',
      body: {
        targetSessionId: 'node1:s1',
        contextPacketIds: [],
        text: 'hi',
        createdBy: 'agent_1',
      },
    });
    expect(sent.body.message.state).toBe('queued');

    const previewed = await req(
      'GET',
      '/inbox/preview?targetSessionId=node1:s1',
      { caps: 'inbox:read' }
    );
    expect(previewed.status).toBe(200);
    expect(previewed.body.messages).toHaveLength(1);
    expect(previewed.body.messages[0].state).toBe('queued');

    const listed = await req('GET', '/inbox?targetSessionId=node1:s1', {
      caps: 'inbox:read',
    });
    expect(listed.body.messages[0].state).toBe('delivered');
  });

  it('inbox.ack is idempotent and ack → resolve is terminal-guarded', async () => {
    const sent = await req('POST', '/inbox', {
      caps: 'inbox:write',
      body: {
        targetSessionId: 'node1:s2',
        contextPacketIds: [],
        createdBy: 'agent_1',
      },
    });
    const id = sent.body.message.id as string;

    const ack1 = await req('POST', `/inbox/${encodeURIComponent(id)}/ack`, {
      caps: 'inbox:write',
    });
    expect(ack1.status).toBe(200);
    expect(ack1.body.message.state).toBe('acknowledged');

    // Idempotent re-ack succeeds.
    const ack2 = await req('POST', `/inbox/${encodeURIComponent(id)}/ack`, {
      caps: 'inbox:write',
    });
    expect(ack2.status).toBe(200);
    expect(ack2.body.message.state).toBe('acknowledged');

    // Resolve from acknowledged is allowed → terminal.
    const resolved = await req(
      'POST',
      `/inbox/${encodeURIComponent(id)}/resolve`,
      {
        caps: 'inbox:write',
      }
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.message.state).toBe('resolved');
    expect(isTerminalInboxState(resolved.body.message.state)).toBe(true);

    // Any transition out of a terminal state is rejected (SESSION_CONFLICT).
    const reAck = await req('POST', `/inbox/${encodeURIComponent(id)}/ack`, {
      caps: 'inbox:write',
    });
    expect(reAck.status).toBe(409);
    expect(reAck.body.error.code).toBe('SESSION_CONFLICT');
    expect(reAck.body.error.details.currentState).toBe('resolved');

    const reIgnore = await req(
      'POST',
      `/inbox/${encodeURIComponent(id)}/ignore`,
      {
        caps: 'inbox:write',
      }
    );
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

    const inbox = await req('GET', '/inbox?targetSessionId=node1:s1', {
      caps: ALL_CAPS.replace('inbox:read', ''),
    });
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

    const invalidAnchor = await req('POST', '/context', {
      caps: 'context:write',
      body: {
        kind: 'file-anchor',
        anchor: {
          ref: { path: 'relative.ts', intent: 'bogus' },
          lineRange: { startLine: 3, endLine: 2 },
        },
        createdBy: 'agent_1',
      },
    });
    expect(invalidAnchor.status).toBe(400);
    expect(invalidAnchor.body.error.code).toBe('INVALID_ARGUMENT');
    expect(invalidAnchor.body.error.message).toContain('anchor.ref.nodeId');
    expect(invalidAnchor.body.error.details.reasonCode).toBe(
      'INVALID_CONTEXT_PACKET'
    );
    expect(invalidAnchor.body.error.details.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'anchor.ref.nodeId' }),
        expect.objectContaining({ field: 'anchor.ref.path' }),
        expect.objectContaining({ field: 'anchor.ref.intent' }),
        expect.objectContaining({ field: 'anchor.lineRange.endLine' }),
      ])
    );

    const invalidBinding = await req('POST', '/context', {
      caps: 'context:write',
      body: {
        kind: 'note',
        note: 'valid note should not accept invalid binding',
        binding: {
          workspaceId: 123,
          nodeId: '',
          repoInstanceId: null,
          worktreeInstanceId: false,
        },
        createdBy: 'agent_1',
      },
    });
    expect(invalidBinding.status).toBe(400);
    expect(invalidBinding.body.error.code).toBe('INVALID_ARGUMENT');
    expect(invalidBinding.body.error.message).toContain('binding.workspaceId');
    expect(invalidBinding.body.error.details.reasonCode).toBe(
      'INVALID_CONTEXT_PACKET'
    );
    expect(invalidBinding.body.error.details.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'binding.workspaceId' }),
        expect.objectContaining({ field: 'binding.nodeId' }),
        expect.objectContaining({ field: 'binding.repoInstanceId' }),
        expect.objectContaining({ field: 'binding.worktreeInstanceId' }),
      ])
    );

    const nonObjectBinding = await req('POST', '/context', {
      caps: 'context:write',
      body: {
        kind: 'note',
        note: 'valid note should not accept array binding',
        binding: ['workspace-1'],
        createdBy: 'agent_1',
      },
    });
    expect(nonObjectBinding.status).toBe(400);
    expect(nonObjectBinding.body.error.code).toBe('INVALID_ARGUMENT');
    expect(nonObjectBinding.body.error.details.reasonCode).toBe(
      'INVALID_CONTEXT_PACKET'
    );
    expect(nonObjectBinding.body.error.details.fieldErrors).toEqual([
      expect.objectContaining({ field: 'binding' }),
    ]);

    const noTarget = await req('POST', '/inbox', {
      caps: 'inbox:write',
      body: { contextPacketIds: [], createdBy: 'agent_1' },
    });
    expect(noTarget.status).toBe(400);
    expect(noTarget.body.error.code).toBe('INVALID_ARGUMENT');

    const missing = await req('GET', '/context/cp:does-not-exist', {
      caps: 'context:read',
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  // #898: artifact-ref packets ride the SAME context.create → inbox path as
  // every other kind, so a later agent retrieves the typed evidence target
  // through `inbox.list` — the path used outside the browser.
  it('context.create kind=artifact-ref echoes the typed ref (201)', async () => {
    const created = await req('POST', '/context', {
      caps: 'context:write',
      body: {
        kind: 'artifact-ref',
        artifactRef: {
          artifactId: 'artifact:stage-report-1',
          workContextId: 'wc:xyz',
          kind: 'report',
          title: 'Stage report',
          uri: 'donovan-yohan/relay-ide#898',
        },
        createdBy: 'agent_1',
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.contextPacket.kind).toBe('artifact-ref');
    expect(created.body.contextPacket.artifactRef).toEqual({
      artifactId: 'artifact:stage-report-1',
      workContextId: 'wc:xyz',
      kind: 'report',
      title: 'Stage report',
      uri: 'donovan-yohan/relay-ide#898',
    });
  });

  it('context.create kind=artifact-ref without artifactId → 400 INVALID_CONTEXT_PACKET', async () => {
    const bad = await req('POST', '/context', {
      caps: 'context:write',
      body: {
        kind: 'artifact-ref',
        artifactRef: { title: 'no id here' },
        createdBy: 'agent_1',
      },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_ARGUMENT');
    expect(bad.body.error.message).toContain('artifactRef.artifactId');
    expect(bad.body.error.details.reasonCode).toBe('INVALID_CONTEXT_PACKET');
    expect(bad.body.error.details.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'artifactRef.artifactId' }),
      ])
    );
  });

  it('context.create kind=artifact-ref with an absolute local path artifactId → 400', async () => {
    const leak = await req('POST', '/context', {
      caps: 'context:write',
      body: {
        kind: 'artifact-ref',
        artifactRef: { artifactId: '/home/donovan/secret.json' },
        createdBy: 'agent_1',
      },
    });
    expect(leak.status).toBe(400);
    expect(leak.body.error.code).toBe('INVALID_ARGUMENT');
    expect(leak.body.error.details.reasonCode).toBe('INVALID_CONTEXT_PACKET');
    expect(leak.body.error.details.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'artifactRef.artifactId' }),
      ])
    );
  });

  it('context.create kind=artifact-ref with a /var/ path artifactId → 400', async () => {
    const leak = await req('POST', '/context', {
      caps: 'context:write',
      body: {
        kind: 'artifact-ref',
        artifactRef: { artifactId: '/var/log/relay/audit.log' },
        createdBy: 'agent_1',
      },
    });
    expect(leak.status).toBe(400);
    expect(leak.body.error.code).toBe('INVALID_ARGUMENT');
    expect(leak.body.error.details.reasonCode).toBe('INVALID_CONTEXT_PACKET');
    expect(leak.body.error.details.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'artifactRef.artifactId' }),
      ])
    );
  });

  it('inbox flow: a message referencing an artifact-ref packet lists the typed target', async () => {
    const created = await req('POST', '/context', {
      caps: 'context:write',
      body: {
        kind: 'artifact-ref',
        artifactRef: {
          artifactId: 'artifact:evidence-7',
          kind: 'report',
          title: 'Evidence bundle',
        },
        createdBy: 'agent_1',
      },
    });
    expect(created.status).toBe(201);
    const packetId = created.body.contextPacket.id as string;

    const sent = await req('POST', '/inbox', {
      caps: 'inbox:write',
      body: {
        targetSessionId: 'node1:s898',
        contextPacketIds: [packetId],
        text: 'review this evidence artifact',
        createdBy: 'agent_1',
      },
    });
    expect(sent.status).toBe(201);

    const listed = await req('GET', '/inbox?targetSessionId=node1:s898', {
      caps: 'inbox:read',
    });
    expect(listed.status).toBe(200);
    expect(listed.body.messages).toHaveLength(1);
    expect(listed.body.messages[0].contextPackets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: packetId,
          kind: 'artifact-ref',
          artifactRef: expect.objectContaining({
            artifactId: 'artifact:evidence-7',
            kind: 'report',
            title: 'Evidence bundle',
          }),
        }),
      ])
    );
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
  function resolverReturning(
    state: 'unchanged' | 'stale' | 'missing'
  ): AnchorStateResolver {
    return async (): Promise<ResolveAnchorOutcome> => ({
      state,
      current: null,
    });
  }

  async function createFileAnchor(): Promise<string> {
    const created = await req('POST', '/context', {
      caps: 'context:write',
      body: {
        kind: 'file-anchor',
        anchor: fileAnchorRef(),
        createdBy: 'agent_1',
      },
    });
    expect(created.status).toBe(201);
    return created.body.contextPacket.id as string;
  }

  it.each(['unchanged', 'stale'] as const)(
    'context.get decorates a file-anchor packet with derived %s anchorState',
    async (state) => {
      await mount(createFakeStore(), resolverReturning(state));
      const id = await createFileAnchor();
      const got = await req('GET', `/context/${encodeURIComponent(id)}`, {
        caps: 'context:read',
      });
      expect(got.status).toBe(200);
      expect(got.body.contextPacket.kind).toBe('file-anchor');
      // DERIVED at read time, surfaced — never stored.
      expect(got.body.contextPacket.anchorState).toBe(state);
    }
  );

  it('context.get leaves a note packet undecorated', async () => {
    await mount(createFakeStore(), resolverReturning('unchanged'));
    const created = await req('POST', '/context', {
      caps: 'context:write',
      body: { kind: 'note', note: 'no anchor here', createdBy: 'agent_1' },
    });
    const id = created.body.contextPacket.id as string;
    const got = await req('GET', `/context/${encodeURIComponent(id)}`, {
      caps: 'context:read',
    });
    expect(got.body.contextPacket.anchorState).toBeUndefined();
  });

  it('inbox.get attaches decorated referenced file-anchor packets', async () => {
    await mount(createFakeStore(), resolverReturning('unchanged'));
    const packetId = await createFileAnchor();
    const sent = await req('POST', '/inbox', {
      caps: 'inbox:write',
      body: {
        targetSessionId: 'node1:s9',
        contextPacketIds: [packetId],
        createdBy: 'agent_1',
      },
    });
    const msgId = sent.body.message.id as string;
    const got = await req('GET', `/inbox/${encodeURIComponent(msgId)}`, {
      caps: 'inbox:read',
    });
    expect(got.status).toBe(200);
    expect(got.body.message.contextPackets).toHaveLength(1);
    expect(got.body.message.contextPackets[0].anchorState).toBe('unchanged');
  });

  it('inbox.list decorates referenced packets and still PULL-delivers', async () => {
    await mount(createFakeStore(), resolverReturning('missing'));
    const packetId = await createFileAnchor();
    await req('POST', '/inbox', {
      caps: 'inbox:write',
      body: {
        targetSessionId: 'node1:s10',
        contextPacketIds: [packetId],
        createdBy: 'agent_1',
      },
    });
    const listed = await req('GET', '/inbox?targetSessionId=node1:s10', {
      caps: 'inbox:read',
    });
    expect(listed.status).toBe(200);
    expect(listed.body.messages).toHaveLength(1);
    // PULL delivery still happens alongside decoration.
    expect(listed.body.messages[0].state).toBe('delivered');
    expect(listed.body.messages[0].contextPackets[0].anchorState).toBe(
      'missing'
    );
  });

  it('inbox.preview decorates referenced packets without PULL-delivering', async () => {
    await mount(createFakeStore(), resolverReturning('unchanged'));
    const packetId = await createFileAnchor();
    await req('POST', '/inbox', {
      caps: 'inbox:write',
      body: {
        targetSessionId: 'node1:s11',
        contextPacketIds: [packetId],
        createdBy: 'agent_1',
      },
    });
    const previewed = await req(
      'GET',
      '/inbox/preview?targetSessionId=node1:s11',
      { caps: 'inbox:read' }
    );
    expect(previewed.status).toBe(200);
    expect(previewed.body.messages[0].state).toBe('queued');
    expect(previewed.body.messages[0].contextPackets[0].anchorState).toBe(
      'unchanged'
    );
  });

  it('inbox.preview attaches referenced file-ref and log-ref packets for artifact rendering', async () => {
    await mount(createFakeStore(), resolverReturning('unchanged'));
    const filePacket = await req('POST', '/context', {
      caps: 'context:write',
      body: {
        kind: 'file-ref',
        fileRef: createFileResourceRef({
          nodeId: 'node1',
          path: '/repo/dist/report.html',
          intent: 'read',
          sha256: 'b'.repeat(64),
          mtimeMs: 2_000,
        }),
        note: 'browser artifact',
        createdBy: 'agent_1',
      },
    });
    expect(filePacket.status).toBe(201);
    const logPacket = await req('POST', '/context', {
      caps: 'context:write',
      body: {
        kind: 'log-ref',
        fileRef: createFileResourceRef({
          nodeId: 'node1',
          path: '/tmp/relay/session.log',
          intent: 'read',
          sha256: 'c'.repeat(64),
          mtimeMs: 3_000,
        }),
        note: 'session log',
        createdBy: 'agent_1',
      },
    });
    expect(logPacket.status).toBe(201);
    await req('POST', '/inbox', {
      caps: 'inbox:write',
      body: {
        targetSessionId: 'node1:s12',
        contextPacketIds: [
          filePacket.body.contextPacket.id,
          logPacket.body.contextPacket.id,
        ],
        text: 'published artifacts',
        createdBy: 'agent_1',
      },
    });

    const previewed = await req(
      'GET',
      '/inbox/preview?targetSessionId=node1:s12',
      { caps: 'inbox:read' }
    );

    expect(previewed.status).toBe(200);
    expect(previewed.body.messages[0].state).toBe('queued');
    expect(previewed.body.messages[0].contextPackets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'file-ref',
          note: 'browser artifact',
          fileRef: expect.objectContaining({ path: '/repo/dist/report.html' }),
        }),
        expect.objectContaining({
          kind: 'log-ref',
          note: 'session log',
          fileRef: expect.objectContaining({ path: '/tmp/relay/session.log' }),
        }),
      ])
    );
  });
});
