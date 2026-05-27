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

const TERMINAL = new Set<SessionInboxMessageState>(TERMINAL_INBOX_MESSAGE_STATES);

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
        ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
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

function runPreturn(
  preturnArgs: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [RELAYCTL_BIN, 'agent', 'preturn', ...preturnArgs],
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

let server: Server;
let baseUrl: string;
let store: ReturnType<typeof createFakeStore>;

beforeEach(async () => {
  store = createFakeStore();
  const app = express();
  app.use(express.json());
  app.use(
    createContextInboxRouter({
      // Auth is handled upstream by requireCliGatewayAuth in production; the
      // router itself only enforces the capability header, which relayctl sends.
      requireAuth: (_req, _res, next) => next(),
      store,
    })
  );
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
    expect(store.raw().find((m) => m.id === messageId)?.state).toBe('delivered');
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
      messages: Array<{ state: string }>;
      contextPackets: Array<{ kind: string }>;
    };
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.pendingCount).toBe(1);
    expect(parsed.messages[0]?.state).toBe('delivered');
    expect(parsed.contextPackets[0]?.kind).toBe('note');
  });

  it('honours --session override outside the env-injected session', async () => {
    const { messageId } = seedPendingInbox();
    // No RELAY_SESSION_ID in env — proves the gateway/explicit path.
    const env = { ...process.env, RELAY_HUB_URL: baseUrl };
    delete env.RELAY_SESSION_ID;
    const { code, stdout } = await runPreturn(['--session', SESSION_ID], env);
    expect(code).toBe(0);
    expect(stdout).toContain(SESSION_ID);
    expect(store.raw().find((m) => m.id === messageId)?.state).toBe('delivered');
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
