import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createContextPacketStore,
  ContextPacketStoreError,
  type ContextPacketStore,
} from '../server/context-packets.js';
import {
  createContextPacketId,
  createInboxMessageId,
  parseContextPacketId,
  parseInboxMessageId,
  parseContextPacket,
  parseInboxMessage,
  parseArtifactPacketRef,
  validateInboxTransition,
  contextPacketToPromptAttachment,
  utf8ByteLength,
  truncateUtf8,
  MAX_ANCHOR_QUOTE_BYTES,
  MAX_ARTIFACT_TITLE_BYTES,
  type ContextPacket,
} from '../shared/context-packet.js';
import { createFileResourceRef } from '../shared/file-resource-ref.js';

vi.mock('../server/logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const tmpDirs: string[] = [];
const openStores: ContextPacketStore[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cp-store-test-'));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(): { store: ContextPacketStore; dbPath: string } {
  const dbPath = path.join(makeDir(), 'context-packets.db');
  const store = createContextPacketStore(dbPath);
  openStores.push(store);
  return { store, dbPath };
}

afterEach(() => {
  while (openStores.length) {
    try {
      openStores.pop()!.close();
    } catch {
      /* already closed */
    }
  }
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function anchorRefFixture(overridePath = '/work/widget/src/index.ts') {
  return {
    ref: createFileResourceRef({
      nodeId: 'local',
      path: overridePath,
      intent: 'read' as const,
    }),
    lineRange: { startLine: 10, endLine: 20 },
    quote: 'const x = 1;',
  };
}

// ── Id round-trip ────────────────────────────────────────────────────────────

describe('context-packet: id helpers', () => {
  it('round-trips a context packet id through create/parse', () => {
    const id = createContextPacketId('abc123');
    expect(id).toBe('cp:abc123');
    expect(parseContextPacketId(id)).toEqual({ suffix: 'abc123' });
  });

  it('round-trips an inbox message id through create/parse', () => {
    const id = createInboxMessageId('deadbeef');
    expect(id).toBe('im:deadbeef');
    expect(parseInboxMessageId(id)).toEqual({ suffix: 'deadbeef' });
  });

  it('round-trips suffixes needing url-encoding', () => {
    const id = createContextPacketId('a:b/c');
    expect(parseContextPacketId(id)).toEqual({ suffix: 'a:b/c' });
  });

  it('rejects ids with the wrong prefix or empty suffix', () => {
    expect(parseContextPacketId('im:abc')).toBeNull();
    expect(parseContextPacketId('cp:')).toBeNull();
    expect(parseInboxMessageId('cp:abc')).toBeNull();
    expect(() => createContextPacketId('   ')).toThrow();
  });
});

// ── UTF-8 quote truncation (nit) ─────────────────────────────────────────────

describe('context-packet: utf-8 quote bounding', () => {
  it('measures by utf-8 bytes, not utf-16 length', () => {
    // "😀" is .length 2 but 4 utf-8 bytes.
    expect('😀'.length).toBe(2);
    expect(utf8ByteLength('😀')).toBe(4);
  });

  it('truncates by byte length and drops a split multi-byte codepoint', () => {
    const emojis = '😀😀😀'; // 12 utf-8 bytes, .length 6
    const truncated = truncateUtf8(emojis, 5); // 1 full emoji (4B) + partial
    expect(utf8ByteLength(truncated)).toBeLessThanOrEqual(5);
    // No replacement char left from the split.
    expect(truncated).not.toContain('�');
    expect(truncated).toBe('😀');
  });

  it('parseAnchorRef bounds quote to MAX_ANCHOR_QUOTE_BYTES', () => {
    const longQuote = 'a'.repeat(MAX_ANCHOR_QUOTE_BYTES + 500);
    const packet = parseContextPacket({
      id: createContextPacketId('q'),
      kind: 'file-anchor',
      anchor: { ...anchorRefFixture(), quote: longQuote },
      createdBy: 'tester',
      createdAt: '2026-05-27T00:00:00.000Z',
    });
    expect(packet).not.toBeNull();
    expect(utf8ByteLength(packet!.anchor!.quote!)).toBeLessThanOrEqual(
      MAX_ANCHOR_QUOTE_BYTES
    );
  });
});

// ── Context packet round-trip ────────────────────────────────────────────────

describe('context-packet store: packet round-trip', () => {
  it('creates -> gets -> lists a file-anchor packet', () => {
    const { store } = makeStore();
    const created = store.createContextPacket({
      kind: 'file-anchor',
      anchor: anchorRefFixture(),
      createdBy: 'agent:1',
      binding: { workspaceId: 'ws:team', nodeId: 'local' },
    });
    expect(created.id.startsWith('cp:')).toBe(true);
    expect(created.kind).toBe('file-anchor');
    expect(created.anchor?.lineRange).toEqual({ startLine: 10, endLine: 20 });

    const read = store.getContextPacket(created.id);
    expect(read).not.toBeNull();
    expect(read!.anchor?.ref.path).toBe('/work/widget/src/index.ts');

    expect(store.listContextPackets().map((p) => p.id)).toContain(created.id);
  });

  it('creates a note packet (no anchor/fileRef)', () => {
    const { store } = makeStore();
    const created = store.createContextPacket({
      kind: 'note',
      note: 'remember to handle the empty case',
      createdBy: 'human:donovan',
    });
    expect(created.kind).toBe('note');
    expect(store.getContextPacket(created.id)!.note).toBe(
      'remember to handle the empty case'
    );
  });

  it('rejects a file-anchor packet with no anchor', () => {
    const { store } = makeStore();
    expect(() =>
      store.createContextPacket({ kind: 'file-anchor', createdBy: 'a' })
    ).toThrow(ContextPacketStoreError);
  });

  it('rejects a note packet with no body', () => {
    const { store } = makeStore();
    expect(() =>
      store.createContextPacket({ kind: 'note', createdBy: 'a' })
    ).toThrow(/invalid_context_packet/);
  });

  it('requires createdBy', () => {
    const { store } = makeStore();
    expect(() =>
      store.createContextPacket({ kind: 'note', note: 'x' })
    ).toThrow(/created_by_required/);
  });
});

// ── Inbox message round-trip ─────────────────────────────────────────────────

describe('context-packet store: inbox message round-trip', () => {
  it('creates -> gets -> lists an inbox message (queued)', () => {
    const { store } = makeStore();
    const packet = store.createContextPacket({
      kind: 'note',
      note: 'see this',
      createdBy: 'agent:1',
    });
    const msg = store.createInboxMessage({
      targetSessionId: 'local:sess-1',
      contextPacketIds: [packet.id],
      text: 'context for you',
      createdBy: 'agent:1',
    });
    expect(msg.id.startsWith('im:')).toBe(true);
    expect(msg.state).toBe('queued');
    expect(msg.contextPacketIds).toEqual([packet.id]);

    const read = store.getInboxMessage(msg.id);
    expect(read!.text).toBe('context for you');
  });

  it('filters by target session and state', () => {
    const { store } = makeStore();
    const p = store.createContextPacket({
      kind: 'note',
      note: 'n',
      createdBy: 'a',
    });
    const a = store.createInboxMessage({
      targetSessionId: 'local:s1',
      contextPacketIds: [p.id],
      createdBy: 'a',
    });
    store.createInboxMessage({
      targetSessionId: 'local:s2',
      contextPacketIds: [p.id],
      createdBy: 'a',
    });
    expect(
      store.listInboxMessages({ targetSessionId: 'local:s1' }).map((m) => m.id)
    ).toEqual([a.id]);
    expect(
      store.listInboxMessages({ targetSessionId: 'local:s1', state: 'delivered' })
    ).toEqual([]);
  });

  it('filters by target work context', () => {
    const { store } = makeStore();
    const p = store.createContextPacket({
      kind: 'note',
      note: 'n',
      createdBy: 'a',
    });
    const m = store.createInboxMessage({
      targetWorkContextId: 'wc:abc',
      contextPacketIds: [p.id],
      createdBy: 'a',
    });
    expect(
      store.listInboxMessages({ targetWorkContextId: 'wc:abc' }).map((x) => x.id)
    ).toEqual([m.id]);
  });

  it('requires at least one target', () => {
    const { store } = makeStore();
    const p = store.createContextPacket({
      kind: 'note',
      note: 'n',
      createdBy: 'a',
    });
    expect(() =>
      store.createInboxMessage({ contextPacketIds: [p.id], createdBy: 'a' })
    ).toThrow(/target_required/);
  });

  it('rejects a message referencing a missing packet', () => {
    const { store } = makeStore();
    expect(() =>
      store.createInboxMessage({
        targetSessionId: 'local:s1',
        contextPacketIds: [createContextPacketId('ghost')],
        createdBy: 'a',
      })
    ).toThrow(/context_packet_not_found/);
  });
});

// ── M2M join semantics ───────────────────────────────────────────────────────

describe('context-packet store: M2M join + delete semantics', () => {
  it('one packet referenced by two messages; deleting a message keeps the packet', () => {
    const { store } = makeStore();
    const packet = store.createContextPacket({
      kind: 'note',
      note: 'shared',
      createdBy: 'a',
    });
    const m1 = store.createInboxMessage({
      targetSessionId: 'local:s1',
      contextPacketIds: [packet.id],
      createdBy: 'a',
    });
    const m2 = store.createInboxMessage({
      targetSessionId: 'local:s2',
      contextPacketIds: [packet.id],
      createdBy: 'a',
    });
    expect(m1.contextPacketIds).toEqual([packet.id]);
    expect(m2.contextPacketIds).toEqual([packet.id]);

    // Delete m1: m2 + packet survive.
    expect(store.deleteInboxMessage(m1.id)).toBe(true);
    expect(store.getInboxMessage(m1.id)).toBeNull();
    expect(store.getInboxMessage(m2.id)).not.toBeNull();
    expect(store.getContextPacket(packet.id)).not.toBeNull();
  });

  it('deleting a packet still referenced by a live message is RESTRICTed', () => {
    const { store } = makeStore();
    const packet = store.createContextPacket({
      kind: 'note',
      note: 'pinned',
      createdBy: 'a',
    });
    store.createInboxMessage({
      targetSessionId: 'local:s1',
      contextPacketIds: [packet.id],
      createdBy: 'a',
    });
    expect(() => store.deleteContextPacket(packet.id)).toThrow(
      /context_packet_referenced/
    );
    // Still present.
    expect(store.getContextPacket(packet.id)).not.toBeNull();
  });

  it('deleting an unreferenced packet succeeds', () => {
    const { store } = makeStore();
    const packet = store.createContextPacket({
      kind: 'note',
      note: 'lonely',
      createdBy: 'a',
    });
    expect(store.deleteContextPacket(packet.id)).toBe(true);
    expect(store.getContextPacket(packet.id)).toBeNull();
    expect(store.deleteContextPacket(packet.id)).toBe(false);
  });

  it('preserves contextPacketIds order via the ordinal column', () => {
    const { store } = makeStore();
    const p1 = store.createContextPacket({
      kind: 'note',
      note: '1',
      createdBy: 'a',
    });
    const p2 = store.createContextPacket({
      kind: 'note',
      note: '2',
      createdBy: 'a',
    });
    const p3 = store.createContextPacket({
      kind: 'note',
      note: '3',
      createdBy: 'a',
    });
    const m = store.createInboxMessage({
      targetSessionId: 'local:s1',
      contextPacketIds: [p3.id, p1.id, p2.id],
      createdBy: 'a',
    });
    expect(store.getInboxMessage(m.id)!.contextPacketIds).toEqual([
      p3.id,
      p1.id,
      p2.id,
    ]);
  });
});

// ── State transitions (C2) ───────────────────────────────────────────────────

describe('context-packet store: inbox transitions (ADR-019 C2)', () => {
  function seedMessage(store: ContextPacketStore) {
    const p = store.createContextPacket({
      kind: 'note',
      note: 'n',
      createdBy: 'a',
    });
    return store.createInboxMessage({
      targetSessionId: 'local:s1',
      contextPacketIds: [p.id],
      createdBy: 'a',
    });
  }

  it('queued -> delivered -> acknowledged -> resolved sets timestamps', () => {
    const { store } = makeStore();
    const m = seedMessage(store);

    const delivered = store.transitionInboxMessage(m.id, 'delivered');
    expect(delivered.state).toBe('delivered');
    expect(delivered.deliveredAt).toBeTruthy();

    const acked = store.transitionInboxMessage(m.id, 'acknowledged');
    expect(acked.state).toBe('acknowledged');
    expect(acked.acknowledgedAt).toBeTruthy();
    // deliveredAt preserved across the ack transition.
    expect(acked.deliveredAt).toBe(delivered.deliveredAt);

    const resolved = store.transitionInboxMessage(m.id, 'resolved');
    expect(resolved.state).toBe('resolved');
    expect(resolved.resolvedAt).toBeTruthy();
  });

  it('delivered is idempotent: re-touch does not error or move the timestamp', () => {
    const { store } = makeStore();
    const m = seedMessage(store);
    const first = store.transitionInboxMessage(m.id, 'delivered');
    // PULL inbox.list re-touches the row — must be a no-op success.
    const second = store.transitionInboxMessage(m.id, 'delivered');
    expect(second.state).toBe('delivered');
    expect(second.deliveredAt).toBe(first.deliveredAt);
  });

  it('acknowledged is idempotent (agent double-fetch / double-ack)', () => {
    const { store } = makeStore();
    const m = seedMessage(store);
    store.transitionInboxMessage(m.id, 'delivered');
    const first = store.transitionInboxMessage(m.id, 'acknowledged');
    const second = store.transitionInboxMessage(m.id, 'acknowledged');
    expect(second.state).toBe('acknowledged');
    expect(second.acknowledgedAt).toBe(first.acknowledgedAt);
  });

  it('rejects a transition out of a terminal state (resolved)', () => {
    const { store } = makeStore();
    const m = seedMessage(store);
    store.transitionInboxMessage(m.id, 'resolved');
    expect(() => store.transitionInboxMessage(m.id, 'delivered')).toThrow(
      /inbox_transition_terminal_state/
    );
    expect(() => store.transitionInboxMessage(m.id, 'acknowledged')).toThrow(
      /terminal_state/
    );
  });

  it('rejects a transition out of a terminal state (ignored)', () => {
    const { store } = makeStore();
    const m = seedMessage(store);
    store.transitionInboxMessage(m.id, 'ignored');
    expect(() => store.transitionInboxMessage(m.id, 'resolved')).toThrow(
      /terminal_state/
    );
  });

  it('re-asserting the same terminal state is an idempotent no-op (not rejected)', () => {
    const { store } = makeStore();
    const m = seedMessage(store);
    const resolved = store.transitionInboxMessage(m.id, 'resolved');
    const again = store.transitionInboxMessage(m.id, 'resolved');
    expect(again.state).toBe('resolved');
    expect(again.resolvedAt).toBe(resolved.resolvedAt);
  });

  it('rejects a backward transition (acknowledged -> delivered)', () => {
    const { store } = makeStore();
    const m = seedMessage(store);
    store.transitionInboxMessage(m.id, 'delivered');
    store.transitionInboxMessage(m.id, 'acknowledged');
    expect(() => store.transitionInboxMessage(m.id, 'delivered')).toThrow(
      /illegal_transition/
    );
  });

  it('shared validator agrees with the store guard', () => {
    expect(validateInboxTransition('queued', 'delivered')).toEqual({
      ok: true,
      idempotent: false,
    });
    expect(validateInboxTransition('delivered', 'delivered')).toEqual({
      ok: true,
      idempotent: true,
    });
    expect(validateInboxTransition('resolved', 'delivered')).toMatchObject({
      ok: false,
      reason: 'terminal_state',
    });
    expect(validateInboxTransition('acknowledged', 'queued')).toMatchObject({
      ok: false,
    });
  });
});

// ── PromptAttachment bridge (C4) ─────────────────────────────────────────────

describe('context-packet: contextPacketToPromptAttachment (C4)', () => {
  it('file-anchor packet -> file-anchor attachment', () => {
    const packet: ContextPacket = {
      id: createContextPacketId('a'),
      kind: 'file-anchor',
      anchor: anchorRefFixture(),
      createdBy: 'a',
      createdAt: '2026-05-27T00:00:00.000Z',
    };
    const att = contextPacketToPromptAttachment(packet);
    expect(att?.kind).toBe('file-anchor');
  });

  it('file-ref packet -> file-ref attachment', () => {
    const packet: ContextPacket = {
      id: createContextPacketId('b'),
      kind: 'file-ref',
      fileRef: createFileResourceRef({
        nodeId: 'local',
        path: '/work/widget/README.md',
        intent: 'read',
      }),
      createdBy: 'a',
      createdAt: '2026-05-27T00:00:00.000Z',
    };
    const att = contextPacketToPromptAttachment(packet);
    expect(att?.kind).toBe('file-ref');
  });

  it('note packet -> null (rides message text, not the attachment list)', () => {
    const packet: ContextPacket = {
      id: createContextPacketId('c'),
      kind: 'note',
      note: 'just a note',
      createdBy: 'a',
      createdAt: '2026-05-27T00:00:00.000Z',
    };
    expect(contextPacketToPromptAttachment(packet)).toBeNull();
  });
});

// ── parse round-trips ────────────────────────────────────────────────────────

describe('context-packet: parsers', () => {
  it('parseContextPacket round-trips a stored packet', () => {
    const { store } = makeStore();
    const created = store.createContextPacket({
      kind: 'file-anchor',
      anchor: anchorRefFixture(),
      createdBy: 'agent:1',
    });
    const reparsed = parseContextPacket(JSON.parse(JSON.stringify(created)));
    expect(reparsed).toEqual(created);
  });

  it('parseInboxMessage round-trips a stored message', () => {
    const { store } = makeStore();
    const p = store.createContextPacket({
      kind: 'note',
      note: 'n',
      createdBy: 'a',
    });
    const m = store.createInboxMessage({
      targetSessionId: 'local:s1',
      contextPacketIds: [p.id],
      text: 'hi',
      createdBy: 'a',
    });
    const reparsed = parseInboxMessage(JSON.parse(JSON.stringify(m)));
    expect(reparsed).toEqual(m);
  });

  it('parseContextPacket rejects bad payloads', () => {
    expect(parseContextPacket(null)).toBeNull();
    expect(parseContextPacket({ id: 'cp:x', kind: 'bogus', createdBy: 'a', createdAt: '2026-05-27T00:00:00.000Z' })).toBeNull();
    expect(parseInboxMessage({ id: 'im:x', state: 'queued', createdBy: 'a', createdAt: '2026-05-27T00:00:00.000Z', contextPacketIds: [] })).toBeNull();
  });
});

// ── artifact-ref packets (#898) ──────────────────────────────────────────────

describe('context-packet: artifact-ref (#898)', () => {
  function artifactPacket(
    artifactRef: Record<string, unknown>
  ): Record<string, unknown> {
    return {
      id: createContextPacketId('art'),
      kind: 'artifact-ref',
      artifactRef,
      createdBy: 'agent:1',
      createdAt: '2026-05-27T00:00:00.000Z',
    };
  }

  it('round-trips an artifact-ref packet preserving every ref field', () => {
    const ref = {
      artifactId: 'artifact:abc123',
      workContextId: 'wc:xyz',
      payloadSha256: 'deadbeef',
      kind: 'report' as const,
      title: 'Stage report',
      uri: 'donovan-yohan/relay-ide#898',
    };
    const parsed = parseContextPacket(artifactPacket(ref));
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('artifact-ref');
    expect(parsed!.artifactRef).toEqual(ref);
  });

  it('parses a minimal artifact-ref (artifactId only)', () => {
    const parsed = parseContextPacket(
      artifactPacket({ artifactId: 'artifact:min' })
    );
    expect(parsed!.artifactRef).toEqual({ artifactId: 'artifact:min' });
  });

  it('rejects an artifact-ref packet with a missing/empty artifactId', () => {
    expect(parseContextPacket(artifactPacket({}))).toBeNull();
    expect(parseContextPacket(artifactPacket({ artifactId: '' }))).toBeNull();
    expect(parseContextPacket(artifactPacket({ artifactId: '   ' }))).toBeNull();
    expect(
      parseContextPacket(artifactPacket({ artifactId: 42 }))
    ).toBeNull();
  });

  it('rejects an artifact-ref packet with no artifactRef at all', () => {
    const packet = artifactPacket({});
    delete packet.artifactRef;
    expect(parseContextPacket(packet)).toBeNull();
  });

  it('rejects an unknown kind (old-client compat: union stays closed)', () => {
    expect(
      parseContextPacket({
        id: createContextPacketId('u'),
        kind: 'artifact', // not the additive 'artifact-ref'
        artifactRef: { artifactId: 'artifact:abc' },
        createdBy: 'a',
        createdAt: '2026-05-27T00:00:00.000Z',
      })
    ).toBeNull();
  });

  it('rejects an artifactId that looks like an absolute local path', () => {
    for (const bad of [
      '/home/donovan/secret.txt',
      '/Users/donovan/secret.txt',
      '/tmp/scratch',
      '/var/log/app.log',
      '/opt/relay/config',
      '/etc/passwd',
      '/srv/data',
      '/mnt/backup',
      '/root/.ssh/id_rsa',
      '/just-a-leading-slash',
      'C:\\Users\\donovan\\secret',
      'C:/windows/system32',
      '\\\\server\\share\\file',
      'file:///etc/passwd',
      'FILE:///home/donovan/secret',
    ]) {
      expect(parseArtifactPacketRef({ artifactId: bad })).toBeNull();
      expect(parseContextPacket(artifactPacket({ artifactId: bad }))).toBeNull();
    }
  });

  it('rejects a uri that looks like an absolute local path or file: URI', () => {
    for (const bad of [
      '/home/donovan/out.json',
      '/tmp/x',
      '/var/run/relay.sock',
      'd:/data/file',
      '\\\\host\\share',
      'file:///etc/passwd',
      'FILE:///home/donovan/secret',
      'C:/x',
    ]) {
      expect(
        parseArtifactPacketRef({ artifactId: 'artifact:ok', uri: bad })
      ).toBeNull();
    }
  });

  it('drops stray unknown fields, copying only declared ref fields', () => {
    const ref = parseArtifactPacketRef({
      artifactId: 'artifact:abc',
      title: 'keep me',
      bogus: 'drop me',
      anchor: { ref: {} },
      payloadBytes: 1234,
    });
    expect(ref).toEqual({ artifactId: 'artifact:abc', title: 'keep me' });
  });

  it('bounds title to MAX_ARTIFACT_TITLE_BYTES utf-8 bytes', () => {
    const longTitle = 'z'.repeat(MAX_ARTIFACT_TITLE_BYTES + 100);
    const ref = parseArtifactPacketRef({
      artifactId: 'artifact:abc',
      title: longTitle,
    });
    expect(ref).not.toBeNull();
    expect(utf8ByteLength(ref!.title!)).toBeLessThanOrEqual(
      MAX_ARTIFACT_TITLE_BYTES
    );
  });

  it('artifact-ref packet -> null prompt attachment (deferred surface)', () => {
    const packet: ContextPacket = {
      id: createContextPacketId('art'),
      kind: 'artifact-ref',
      artifactRef: { artifactId: 'artifact:abc' },
      createdBy: 'a',
      createdAt: '2026-05-27T00:00:00.000Z',
    };
    expect(contextPacketToPromptAttachment(packet)).toBeNull();
  });

  // Store-level round trip (#898): the envelope persists through SQLite and the
  // typed ref is recovered intact — kind is free TEXT, the ref rides packet_json.
  it('creates -> gets an artifact-ref packet preserving every ref field', () => {
    const { store } = makeStore();
    const created = store.createContextPacket({
      kind: 'artifact-ref',
      artifactRef: {
        artifactId: 'artifact:handoff-1',
        workContextId: 'wc:xyz',
        payloadSha256: 'deadbeef',
        kind: 'report',
        title: 'Stage report',
        uri: 'donovan-yohan/relay-ide#898',
      },
      createdBy: 'agent:1',
      binding: { workspaceId: 'ws:team', nodeId: 'local' },
    });
    expect(created.id.startsWith('cp:')).toBe(true);
    expect(created.kind).toBe('artifact-ref');

    const read = store.getContextPacket(created.id);
    expect(read).not.toBeNull();
    expect(read!.artifactRef).toEqual({
      artifactId: 'artifact:handoff-1',
      workContextId: 'wc:xyz',
      payloadSha256: 'deadbeef',
      kind: 'report',
      title: 'Stage report',
      uri: 'donovan-yohan/relay-ide#898',
    });
    expect(store.listContextPackets().map((p) => p.id)).toContain(created.id);
  });

  it('rejects an artifact-ref packet with no artifactId (store level)', () => {
    const { store } = makeStore();
    expect(() =>
      store.createContextPacket({
        kind: 'artifact-ref',
        artifactRef: { artifactId: '' } as never,
        createdBy: 'a',
      })
    ).toThrow(/invalid_context_packet/);
    expect(() =>
      store.createContextPacket({ kind: 'artifact-ref', createdBy: 'a' })
    ).toThrow(ContextPacketStoreError);
  });
});

// ── Durability + migration + fail-soft ───────────────────────────────────────

describe('context-packet store: durability + migration', () => {
  it('persists across re-open of the same DB file', () => {
    const dbPath = path.join(makeDir(), 'context-packets.db');
    const s1 = createContextPacketStore(dbPath);
    const packet = s1.createContextPacket({
      kind: 'note',
      note: 'durable',
      createdBy: 'a',
    });
    const msg = s1.createInboxMessage({
      targetSessionId: 'local:s1',
      contextPacketIds: [packet.id],
      createdBy: 'a',
    });
    s1.close();

    const s2 = createContextPacketStore(dbPath);
    openStores.push(s2);
    expect(s2.getContextPacket(packet.id)!.note).toBe('durable');
    expect(s2.getInboxMessage(msg.id)!.contextPacketIds).toEqual([packet.id]);
  });

  it('migration is idempotent: re-running createContextPacketStore is a no-op', () => {
    const dbPath = path.join(makeDir(), 'context-packets.db');
    const a = createContextPacketStore(dbPath);
    a.createContextPacket({ kind: 'note', note: 'keep', createdBy: 'a' });
    a.close();

    const b = createContextPacketStore(dbPath);
    b.close();
    const c = createContextPacketStore(dbPath);
    openStores.push(c);
    expect(c.listContextPackets()).toHaveLength(1);

    const db = new Database(dbPath);
    try {
      const row = db.prepare('SELECT version FROM schema_version').get() as {
        version: number;
      };
      expect(row.version).toBe(1);
    } finally {
      db.close();
    }
  });

  it('creates the expected tables on a fresh DB', () => {
    const { store, dbPath } = makeStore();
    store.close();
    openStores.pop();

    const db = new Database(dbPath);
    try {
      const tables = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).toContain('context_packets');
      expect(tables).toContain('inbox_messages');
      expect(tables).toContain('inbox_message_packets');
      expect(tables).toContain('schema_version');
    } finally {
      db.close();
    }
  });

  it('fails soft on corrupt JSON columns instead of throwing', () => {
    const dbPath = path.join(makeDir(), 'context-packets.db');
    const s1 = createContextPacketStore(dbPath);
    const packet = s1.createContextPacket({
      kind: 'note',
      note: 'n',
      createdBy: 'a',
    });
    const msg = s1.createInboxMessage({
      targetSessionId: 'local:s1',
      contextPacketIds: [packet.id],
      createdBy: 'a',
    });
    s1.close();

    const raw = new Database(dbPath);
    raw
      .prepare('UPDATE context_packets SET packet_json = ? WHERE id = ?')
      .run('{not json', packet.id);
    raw
      .prepare('UPDATE inbox_messages SET message_json = ? WHERE id = ?')
      .run('{not json', msg.id);
    raw.close();

    const s2 = createContextPacketStore(dbPath);
    openStores.push(s2);
    // Getters degrade to null; list paths drop the bad rows without throwing.
    expect(s2.getContextPacket(packet.id)).toBeNull();
    expect(s2.getInboxMessage(msg.id)).toBeNull();
    expect(() => s2.listContextPackets()).not.toThrow();
    expect(() => s2.listInboxMessages()).not.toThrow();
    expect(s2.listContextPackets()).toEqual([]);
    expect(s2.listInboxMessages()).toEqual([]);
  });

  it('empty-DB safety: list returns [] before any insert', () => {
    const { store } = makeStore();
    expect(store.listContextPackets()).toEqual([]);
    expect(store.listInboxMessages()).toEqual([]);
    expect(store.getContextPacket(createContextPacketId('none'))).toBeNull();
    expect(store.getInboxMessage(createInboxMessageId('none'))).toBeNull();
  });

  it('transition on a missing message 404s', () => {
    const { store } = makeStore();
    expect(() =>
      store.transitionInboxMessage(createInboxMessageId('ghost'), 'delivered')
    ).toThrow(/inbox_message_not_found/);
  });
});
