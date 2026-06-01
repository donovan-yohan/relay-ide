// #761 / ADR-019: `relayctl agent preturn` — the headless inbox read.
//
// preturn is the proof that the CLI-first context loop is agent-consumable: an
// agent inside a Relay PTY runs `relayctl agent preturn`, the hub PULL-delivers
// its pending inbox (queued → delivered as a read side effect), and the command
// renders it (markdown default + json). Rendering is NOT acknowledgement.
//
// We exercise the SHIPPED `dist/bin/relayctl.js` as a subprocess (mirroring
// test/browser-cli.test.ts) against a real express server mounting the #765
// context/inbox router over the same in-memory store seam #765's own route test
// uses. This keeps the assertion end-to-end: the env contract, the gateway
// headers relayctl sends, the PULL flip, and both renderers are all real.

import express from 'express';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkContextStore } from '../server/work-contexts.js';
import {
  WORK_CONTEXT_SCHEMA_VERSION,
  createWorkContextPrivacyMetadata,
  type ArtifactRef,
  type WorkContext,
} from '../shared/work-context.js';
import {
  createContextInboxRouter,
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
  type ContextPacket,
  type SessionInboxMessage,
  type SessionInboxMessageState,
} from '../shared/context-packet.js';

const RELAYCTL_BIN = fileURLToPath(
  new URL('../dist/bin/relayctl.js', import.meta.url)
);

const TERMINAL = new Set<SessionInboxMessageState>(
  TERMINAL_INBOX_MESSAGE_STATES
);

const WORK_CONTEXT_ID = 'wc:preturn:test';

function testPrivacy() {
  return createWorkContextPrivacyMetadata({
    classification: 'internal',
    retention: 'project',
    rawPayloadStored: false,
  });
}

function createFakeWorkContext(
  id: string,
  artifacts: ArtifactRef[] = []
): WorkContext {
  const now = new Date().toISOString();
  return {
    schemaVersion: WORK_CONTEXT_SCHEMA_VERSION,
    id,
    title: id,
    source: 'test',
    createdAt: now,
    updatedAt: now,
    anchors: {},
    actors: [],
    tasks: [],
    artifacts,
    auditRefs: [],
    capabilityGrants: [],
    privacy: testPrivacy(),
  };
}

function createPinnedPacketArtifact(packetId: string): ArtifactRef {
  return {
    id: `artifact:context-packet:${packetId}`,
    kind: 'external',
    title: `Pinned context packet ${packetId}`,
    uri: `relay://context-packets/${encodeURIComponent(packetId)}`,
    privacy: testPrivacy(),
  };
}

function createFakeWorkContextStore(initial: WorkContext[]): WorkContextStore {
  const contexts = new Map(initial.map((context) => [context.id, context]));
  const required = () => {
    throw new Error('not implemented for relayctl preturn test');
  };
  return {
    close: () => {},
    create: (input = {}) => {
      const context =
        input.context ??
        createFakeWorkContext(input.id ?? `wc:${contexts.size}`);
      contexts.set(context.id, context);
      return context;
    },
    get: (id) => contexts.get(id) ?? null,
    list: () => [...contexts.values()],
    update: (id, patchInput) => {
      const existing = contexts.get(id);
      if (!existing) throw new Error('WorkContext not found');
      const updated = {
        ...existing,
        ...patchInput,
        updatedAt: new Date().toISOString(),
      };
      contexts.set(id, updated);
      return updated;
    },
    linkContexts: required,
    associateSession: required,
    recordLifecycleEvent: (id, input) => {
      const existing = contexts.get(id);
      if (!existing) throw new Error('WorkContext not found');
      const updated = {
        ...existing,
        artifacts: [...existing.artifacts, ...(input.artifacts ?? [])],
        updatedAt: new Date().toISOString(),
      };
      contexts.set(id, updated);
      return updated;
    },
    getResumeSnapshot: required,
    listActiveWork: required,
    findSessionWorkContextIds: () => [],
  };
}

// In-memory store implementing the #765 seam with the SAME PULL-delivery side
// effect (list/get flip queued → delivered) so the headless flip is observable.
function createFakeStore(): ContextInboxStore & {
  raw: () => SessionInboxMessage[];
} {
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

  return {
    raw: () => [...messages.values()],
    createPacket(input: CreateContextPacketInput): ContextPacket {
      const id = createContextPacketId(`pre${packetSeq++}`);
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
      if (filter?.limit !== undefined) all = all.slice(0, filter.limit);
      return all;
    },
    createInboxMessage(input: CreateInboxMessageInput): SessionInboxMessage {
      const id = createInboxMessageId(`pre${messageSeq++}`);
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
    listInboxMessages(filter: ListInboxMessagesFilter): SessionInboxMessage[] {
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
      all = all.map((m) => deliverOnPull(m));
      if (filter.limit !== undefined) all = all.slice(0, filter.limit);
      return all;
    },
    getInboxMessage(id: string): SessionInboxMessage | null {
      const message = messages.get(id);
      if (!message) return null;
      return deliverOnPull(message);
    },
    updateInboxState(
      id: string,
      targetState: SessionInboxMessageState
    ): UpdateInboxStateResult {
      const message = messages.get(id);
      if (!message) return { ok: false, reason: 'not_found' };
      if (TERMINAL.has(message.state)) {
        return { ok: false, reason: 'terminal', currentState: message.state };
      }
      const updated: SessionInboxMessage = { ...message, state: targetState };
      messages.set(id, updated);
      return { ok: true, message: updated };
    },
  };
}

function runRelayctl(
  relayctlArgs: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [RELAYCTL_BIN, ...relayctlArgs],
      { encoding: 'utf-8', timeout: 15_000, env },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : 0;
        resolve({ code, stdout, stderr });
      }
    );
  });
}

function runPreturn(
  preturnArgs: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runRelayctl(['agent', 'preturn', ...preturnArgs], env);
}

let server: Server;
let baseUrl: string;
let store: ReturnType<typeof createFakeStore>;
let workContextStore: WorkContextStore;

beforeEach(async () => {
  store = createFakeStore();
  workContextStore = createFakeWorkContextStore([
    createFakeWorkContext(WORK_CONTEXT_ID),
  ]);
  const app = express();
  app.use(express.json());
  app.use(
    createContextInboxRouter({
      // Auth is handled upstream by requireCliGatewayAuth in production; the
      // router itself only enforces the capability header, which relayctl sends.
      requireAuth: (_req, _res, next) => next(),
      store,
      workContextStore,
    })
  );
  app.get('/sessions', (_req, res) => {
    res.json({
      sessions: [
        {
          id: 'node1:sess-preturn',
          type: 'terminal',
          displayName: 'Terminal 1',
          cwd: '/tmp/terminal',
          workContextId: WORK_CONTEXT_ID,
        },
        {
          id: 'node1:agent-a',
          type: 'agent',
          displayName: 'Agent A',
          status: 'running',
          cwd: '/tmp/agent',
        },
      ],
    });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe('relayctl agent preturn', () => {
  const SESSION_ID = 'node1:sess-preturn';

  function seedPendingInbox(): { messageId: string } {
    const packet = store.createPacket({
      kind: 'note',
      note: 'check the failing assertion in foo.test.ts',
      createdBy: 'human_1',
    });
    const message = store.createInboxMessage({
      targetSessionId: SESSION_ID,
      contextPacketIds: [packet.id],
      text: 'please look at this before your next turn',
      createdBy: 'human_1',
    });
    return { messageId: message.id };
  }

  it('renders pending inbox as markdown (default) and PULL-flips queued → delivered', async () => {
    const { messageId } = seedPendingInbox();
    expect(store.raw().find((m) => m.id === messageId)?.state).toBe('queued');

    const { code, stdout } = await runPreturn([], {
      ...process.env,
      RELAY_HUB_URL: baseUrl,
      RELAY_SESSION_ID: SESSION_ID,
    });

    expect(code).toBe(0);
    expect(stdout).toContain('Relay pending context');
    expect(stdout).toContain(SESSION_ID);
    expect(stdout).toContain('1 pending message');
    expect(stdout).toContain('please look at this before your next turn');
    expect(stdout).toContain('check the failing assertion in foo.test.ts');
    // PULL semantics: fetching delivered the message.
    expect(store.raw().find((m) => m.id === messageId)?.state).toBe(
      'delivered'
    );
  });

  it('does not ack/resolve — only delivers (rendering != resolution)', async () => {
    const { messageId } = seedPendingInbox();
    await runPreturn([], {
      ...process.env,
      RELAY_HUB_URL: baseUrl,
      RELAY_SESSION_ID: SESSION_ID,
    });
    // Never advanced past `delivered`.
    const state = store.raw().find((m) => m.id === messageId)?.state;
    expect(state).toBe('delivered');
    expect(state).not.toBe('acknowledged');
    expect(state).not.toBe('resolved');
  });

  it('renders machine-readable json with --format json', async () => {
    seedPendingInbox();
    const { code, stdout } = await runPreturn(['--format', 'json'], {
      ...process.env,
      RELAY_HUB_URL: baseUrl,
      RELAY_SESSION_ID: SESSION_ID,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      sessionId: string;
      pendingCount: number;
      pinnedContextCount: number;
      messages: Array<{ state: string }>;
      contextPackets: Array<{ kind: string }>;
      pinnedContextPackets: Array<{ kind: string }>;
    };
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.pendingCount).toBe(1);
    expect(parsed.pinnedContextCount).toBe(0);
    expect(parsed.messages[0]?.state).toBe('delivered');
    expect(parsed.contextPackets[0]?.kind).toBe('note');
    expect(parsed.pinnedContextPackets).toEqual([]);
  });

  it('renders WorkContext-pinned packets in preturn markdown even with no inbox message', async () => {
    const packet = store.createPacket({
      kind: 'note',
      note: 'review the durable WorkContext pin before answering',
      createdBy: 'reviewer_1',
    });
    workContextStore.update(WORK_CONTEXT_ID, {
      artifacts: [createPinnedPacketArtifact(packet.id)],
    });

    const { code, stdout } = await runPreturn([], {
      ...process.env,
      RELAY_HUB_URL: baseUrl,
      RELAY_SESSION_ID: SESSION_ID,
      RELAY_WORK_CONTEXT_ID: WORK_CONTEXT_ID,
    });

    expect(code).toBe(0);
    expect(stdout).toContain('No pending inbox messages.');
    expect(stdout).toContain('Pinned WorkContext context');
    expect(stdout).toContain(WORK_CONTEXT_ID);
    expect(stdout).toContain(
      'review the durable WorkContext pin before answering'
    );
  });

  it('includes WorkContext-pinned packets in preturn json', async () => {
    const packet = store.createPacket({
      kind: 'note',
      note: 'json pinned packet',
      createdBy: 'reviewer_1',
    });
    workContextStore.update(WORK_CONTEXT_ID, {
      artifacts: [createPinnedPacketArtifact(packet.id)],
    });

    const { code, stdout } = await runPreturn(['--format', 'json'], {
      ...process.env,
      RELAY_HUB_URL: baseUrl,
      RELAY_SESSION_ID: SESSION_ID,
      RELAY_WORK_CONTEXT_ID: WORK_CONTEXT_ID,
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      workContextId?: string;
      pendingCount: number;
      pinnedContextCount: number;
      pinnedContextPackets: Array<{ id: string; note?: string }>;
      contextPackets: Array<{ id: string }>;
    };
    expect(parsed.workContextId).toBe(WORK_CONTEXT_ID);
    expect(parsed.pendingCount).toBe(0);
    expect(parsed.pinnedContextCount).toBe(1);
    expect(parsed.pinnedContextPackets[0]?.id).toBe(packet.id);
    expect(parsed.pinnedContextPackets[0]?.note).toBe('json pinned packet');
    expect(
      parsed.contextPackets.some((candidate) => candidate.id === packet.id)
    ).toBe(true);
  });

  it('honours --session override outside the env-injected session', async () => {
    const { messageId } = seedPendingInbox();
    // No RELAY_SESSION_ID in env — proves the gateway/explicit path.
    const env = { ...process.env, RELAY_HUB_URL: baseUrl };
    delete env.RELAY_SESSION_ID;
    const { code, stdout } = await runPreturn(['--session', SESSION_ID], env);
    expect(code).toBe(0);
    expect(stdout).toContain(SESSION_ID);
    expect(store.raw().find((m) => m.id === messageId)?.state).toBe(
      'delivered'
    );
  });

  it('renders an empty-inbox message when nothing is pending', async () => {
    const { code, stdout } = await runPreturn([], {
      ...process.env,
      RELAY_HUB_URL: baseUrl,
      RELAY_SESSION_ID: 'node1:empty',
    });
    expect(code).toBe(0);
    expect(stdout).toContain('No pending inbox messages.');
  });

  it('fails clean when not running inside a Relay session (no env, no --session)', async () => {
    const env = { ...process.env };
    delete env.RELAY_HUB_URL;
    delete env.RELAY_SESSION_ID;
    const { code, stderr } = await runPreturn([], env);
    expect(code).toBe(1);
    expect(stderr).toContain('not running inside a relay session');
    expect(stderr).toContain('RELAY_HUB_URL');
  });

  it('rejects an unknown --format value', async () => {
    const { code, stderr } = await runPreturn(['--format', 'yaml'], {
      ...process.env,
      RELAY_HUB_URL: baseUrl,
      RELAY_SESSION_ID: SESSION_ID,
    });
    expect(code).toBe(1);
    expect(stderr).toContain("--format must be 'markdown' or 'json'");
  });
});

describe('relayctl terminal mailroom commands', () => {
  const SESSION_ID = 'node1:sess-preturn';

  function env() {
    return {
      ...process.env,
      RELAY_HUB_URL: baseUrl,
      RELAY_SOCKET: baseUrl,
      RELAY_NODE_ID: 'node1',
      RELAY_SESSION_ID: SESSION_ID,
      RELAY_WORK_CONTEXT_ID: WORK_CONTEXT_ID,
    };
  }

  it('prints structured identity with whoami --json', async () => {
    const { code, stdout } = await runRelayctl(['whoami', '--json'], env());
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      nodeId: string;
      sessionId: string;
      workContextId?: string;
      relaySocket?: string;
      cwd?: string;
      displayName?: string;
    };
    expect(parsed.nodeId).toBe('node1');
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.workContextId).toBe(WORK_CONTEXT_ID);
    expect(parsed.relaySocket).toBe(baseUrl);
    expect(parsed.cwd).toBe('/tmp/terminal');
    expect(parsed.displayName).toBe('Terminal 1');
  });

  it('lists agent sessions', async () => {
    const { code, stdout } = await runRelayctl(
      ['agents', 'list', '--json'],
      env()
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      agents: Array<{ id: string; type: string }>;
    };
    expect(parsed.agents).toEqual([
      expect.objectContaining({ id: 'node1:agent-a', type: 'agent' }),
    ]);
  });

  it('sends and reads inbox messages from the terminal CLI', async () => {
    const sent = await runRelayctl(
      ['msg', 'send', '--to', SESSION_ID, 'mailroom ping'],
      env()
    );
    expect(sent.code).toBe(0);
    const message = JSON.parse(sent.stdout) as { id: string; text: string };
    expect(message.text).toBe('mailroom ping');

    const read = await runRelayctl(['msg', 'read'], env());
    expect(read.code).toBe(0);
    expect(read.stdout).toContain(message.id);
    expect(read.stdout).toContain('mailroom ping');
  });

  it('preserves flag-like tokens inside message text after the recipient flag', async () => {
    const sent = await runRelayctl(
      [
        'msg',
        'send',
        '--to',
        SESSION_ID,
        'qa-flag-message',
        'literal',
        '--to',
        'SHOULD_STAY',
        'after',
      ],
      env()
    );

    expect(sent.code).toBe(0);
    const message = JSON.parse(sent.stdout) as {
      targetSessionId: string;
      text: string;
    };
    expect(message.targetSessionId).toBe(SESSION_ID);
    expect(message.text).toBe('qa-flag-message literal --to SHOULD_STAY after');
  });

  it('preserves flag-like tokens inside notify text after leading options', async () => {
    const notify = await runRelayctl(
      ['notify', '--kind', 'warning', 'literal', '--kind', 'SHOULD_STAY'],
      env()
    );

    expect(notify.code).toBe(0);
    const parsed = JSON.parse(notify.stdout) as {
      attentionEvent: { kind: string; text: string };
    };
    expect(parsed.attentionEvent.kind).toBe('warning');
    expect(parsed.attentionEvent.text).toBe('literal --kind SHOULD_STAY');
  });

  it('preserves recipient-looking tokens in message text instead of stripping payload', async () => {
    const sent = await runRelayctl(
      ['msg', 'send', '--to', SESSION_ID, 'keep', '--to', 'literal', 'after'],
      env()
    );
    expect(sent.code).toBe(0);
    const message = JSON.parse(sent.stdout) as { text: string };
    expect(message.text).toBe('keep --to literal after');
  });

  it('preserves recipient-looking tokens in message text after --', async () => {
    const sent = await runRelayctl(
      ['msg', 'send', '--to', SESSION_ID, '--', 'keep', '--to', 'literal', 'after'],
      env()
    );
    expect(sent.code).toBe(0);
    const message = JSON.parse(sent.stdout) as { text: string };
    expect(message.text).toBe('keep --to literal after');
  });

  it('publishes attention, decision, and artifact refs as pinned WorkContext context', async () => {
    const notify = await runRelayctl(
      ['notify', '--kind', 'needs_input', 'operator needed'],
      env()
    );
    const decision = await runRelayctl(
      ['decision', 'choose path A or B'],
      env()
    );
    const artifact = await runRelayctl(
      [
        'artifact',
        'publish',
        'report.txt',
        '--kind',
        'report',
        '--title',
        'Run --kind SHOULD_STAY report',
      ],
      env()
    );

    expect(notify.code).toBe(0);
    expect(decision.code).toBe(0);
    expect(artifact.code).toBe(0);
    expect(JSON.parse(notify.stdout).attentionEvent.kind).toBe('needs_input');
    expect(JSON.parse(decision.stdout).decision.state).toBe('pending');
    const parsedArtifact = JSON.parse(artifact.stdout) as {
      artifact: { path: string; title?: string };
    };
    expect(parsedArtifact.artifact.path).toMatch(/\/report\.txt$/);
    expect(parsedArtifact.artifact.title).toBe('Run --kind SHOULD_STAY report');

    const context = workContextStore.get(WORK_CONTEXT_ID);
    expect(context?.artifacts.length).toBe(3);
  });
});
