import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_ADAPTER_LAUNCH_CONTRACTS,
  PROVIDER_DESCRIPTORS,
  createAdapterV2,
} from '../../../server/protocol-adapters/index.js';
import { providerResumeId } from '../../../server/channel-agent-runtime.js';
import { LegacyProtocolAdapterV2Bridge } from '../../../server/protocol-adapters/legacy-v2-bridge.js';
import { OpenCodeProtocolAdapter } from '../../../server/protocol-adapters/opencode-adapter.js';
import {
  OpenCodeAttachedAdapter,
  probeOpenCodeAttachedApi,
} from '../../../server/protocol-adapters/opencode-attached-adapter.js';
import { openCodeStatusType } from '../../../server/protocol-adapters/opencode-shared.js';
import { mapChatEventToAgentPatchV2 } from '../../../shared/agent-chat-v1-compat.js';
import type { ChatEvent } from '../../../shared/chat-events.js';

interface OpenCodeEventLike {
  type: string;
  properties?: Record<string, unknown>;
}

/** Drive the adapter's real SSE event dispatcher and collect what it fires. */
function driveOpenCodeEvent(
  adapter: OpenCodeProtocolAdapter | OpenCodeAttachedAdapter,
  event: OpenCodeEventLike
): ChatEvent[] {
  const seen: ChatEvent[] = [];
  const off = adapter.on((chatEvent) => {
    seen.push(chatEvent);
  });
  (
    adapter as unknown as { mapOpenCodeEvent(event: OpenCodeEventLike): void }
  ).mapOpenCodeEvent(event);
  off();
  return seen;
}

describe('OpenCode V2 web adapter registration', () => {
  it('spawns the advertised command with the complete provider denylist enforced', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const spawnFn = vi.fn(() => child) as unknown as typeof spawn;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/global/health')) {
          return new Response('{}', { status: 200 });
        }
        if (url.endsWith('/session') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 'opencode-session' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/global/event')) {
          return new Response('', { status: 200 });
        }
        throw new Error(`unexpected OpenCode URL: ${url}`);
      });
    const adapter = new OpenCodeProtocolAdapter(spawnFn);
    try {
      await adapter.connect({
        cwd: '/tmp',
        port: 1,
        sessionId: 'relay-session',
        hookToken: 'x',
        configDir: '/tmp',
        extra: { command: 'unavailable-opencode-override' },
        processEnv: {
          CLAUDECODE: 'must-be-stripped',
          OPENCODE_SERVER_PASSWORD: 'must-be-stripped',
          OPENCODE_SERVER_USERNAME: 'must-be-stripped',
          RELAY_PROFILE_SAFE: 'preserved',
        },
      });

      const launchRequirement =
        CHANNEL_ADAPTER_LAUNCH_CONTRACTS.opencode.requirement;
      expect(launchRequirement.kind).toBe('command');
      if (launchRequirement.kind !== 'command') {
        throw new Error(
          'OpenCode must remain a command-backed channel adapter'
        );
      }
      expect(spawnFn).toHaveBeenCalledWith(
        launchRequirement.command,
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({ RELAY_PROFILE_SAFE: 'preserved' }),
        })
      );
      const childEnv = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[2]?.env as Record<string, string>;
      for (const key of CHANNEL_ADAPTER_LAUNCH_CONTRACTS.opencode
        .processEnvDenylist) {
        expect(childEnv).not.toHaveProperty(key);
      }
    } finally {
      await adapter.disconnect();
      fetchMock.mockRestore();
    }
  });

  it('registers opencode as a ProtocolAdapterV2 bridge while native mapping is ported', () => {
    const adapter = createAdapterV2('opencode');

    expect(adapter).toBeInstanceOf(LegacyProtocolAdapterV2Bridge);
    expect(adapter.agentType).toBe('opencode');
    expect(adapter.capabilities).toMatchObject({
      text: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      interrupt: true,
      telemetry: true,
      streaming: true,
    });
  });

  it('probes the attached adapter default HTTP health endpoint', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      await expect(probeOpenCodeAttachedApi(undefined, 125)).resolves.toEqual({
        available: true,
        endpoint: 'http://127.0.0.1:4096',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4096/global/health',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('registers opencode-attached as a ProtocolAdapterV2 bridge', () => {
    const adapter = createAdapterV2('opencode-attached');

    expect(adapter).toBeInstanceOf(LegacyProtocolAdapterV2Bridge);
    expect(adapter.agentType).toBe('opencode');
    expect(adapter.capabilities).toMatchObject({ streaming: true });
  });
});

// The `streaming` bit means "this adapter emits live `agent-item-delta-v2`
// patches". Advertising it without the emission would repeat the hermes
// `telemetry` trap (event fired, no compat mapping, silently dropped), so both
// halves are asserted against the real code path rather than the literal.
describe('OpenCode streaming capability is backed by real deltas', () => {
  it('fires chat:text-delta from the web adapter and maps it to a V2 delta patch', () => {
    const adapter = new OpenCodeProtocolAdapter();
    const events = driveOpenCodeEvent(adapter, {
      type: 'message.part.updated',
      properties: {
        part: { type: 'text', id: 'part-1', messageID: 'msg-1', text: 'hel' },
        delta: 'hel',
      },
    });

    const delta = events.find((event) => event.type === 'chat:text-delta');
    expect(delta).toMatchObject({ type: 'chat:text-delta', delta: 'hel' });

    const patches = mapChatEventToAgentPatchV2(delta!);
    expect(patches.map((patch) => patch.type)).toContain('agent-item-delta-v2');
  });

  it('fires chat:text-delta from the attached adapter and maps it to a V2 delta patch', () => {
    const adapter = new OpenCodeAttachedAdapter();
    const events = driveOpenCodeEvent(adapter, {
      type: 'message.part.updated',
      properties: { delta: 'lo world' },
    });

    const delta = events.find((event) => event.type === 'chat:text-delta');
    expect(delta).toMatchObject({ type: 'chat:text-delta', delta: 'lo world' });

    const patches = mapChatEventToAgentPatchV2(delta!);
    expect(patches.map((patch) => patch.type)).toContain('agent-item-delta-v2');
  });
});

/**
 * Deferred `/abort` response so a test can interleave the server's own idle
 * with the abort ack the adapter is still waiting on.
 */
interface DeferredAbort {
  resolve: () => void;
}

/**
 * Offline attached adapter: `/global/health` answers 200 and `/event` hands
 * back an already-finished stream, so `connect()` completes without a server.
 * Events are collected AFTER connect, so the connect handshake stays out of the
 * assertions.
 */
async function connectedAttachedAdapter(options?: {
  permissionStatus?: number;
  abortStatus?: number;
  deferAbort?: DeferredAbort;
}): Promise<{
  adapter: OpenCodeAttachedAdapter;
  events: ChatEvent[];
  requests: string[];
  drive: (event: OpenCodeEventLike) => void;
  dispose: () => Promise<void>;
}> {
  const requests: string[] = [];
  let releaseAbort: (() => void) | undefined;
  const abortGate = options?.deferAbort
    ? new Promise<void>((resolve) => {
        releaseAbort = resolve;
      })
    : undefined;
  if (options?.deferAbort && releaseAbort) {
    options.deferAbort.resolve = releaseAbort;
  }

  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push(`${(init?.method ?? 'GET').toUpperCase()} ${url}`);
      if (url.endsWith('/global/health')) {
        return new Response('{}', { status: 200 });
      }
      if (url.endsWith('/event')) {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/abort')) {
        if (abortGate) await abortGate;
        return new Response('true', { status: options?.abortStatus ?? 200 });
      }
      if (url.includes('/permission/')) {
        return new Response('{}', { status: options?.permissionStatus ?? 200 });
      }
      return new Response('{}', { status: 200 });
    });

  const adapter = new OpenCodeAttachedAdapter();
  await adapter.connect({
    cwd: '/tmp',
    port: 1,
    sessionId: 'attached-session',
    hookToken: 'x',
    configDir: '/tmp',
    extra: { endpoint: 'http://127.0.0.1:14096' },
  });

  const events: ChatEvent[] = [];
  const off = adapter.on((event) => {
    events.push(event);
  });

  return {
    adapter,
    events,
    requests,
    drive: (event) =>
      (
        adapter as unknown as {
          mapOpenCodeEvent(event: OpenCodeEventLike): void;
        }
      ).mapOpenCodeEvent(event),
    dispose: async () => {
      off();
      await adapter.disconnect();
      fetchMock.mockRestore();
    },
  };
}

/**
 * Inverted pins for #1412. Every assertion here was impossible to state before
 * the fix: the attached adapter started turns and never ended them, so
 * `agent-turn-completed-v2` was unreachable in `completed`, `failed`, and
 * `interrupted` form alike and the conformance fixture had to gap invariant (a)
 * outright. Reverting any handler below turns one of these red.
 */
describe('OpenCodeAttachedAdapter turn lifecycle (#1412)', () => {
  it.each([
    ['bare string (tolerated)', 'idle'],
    ['nested object (real wire encoding)', { type: 'idle' }],
  ])('ends the turn on session.status idle — %s', async (_label, status) => {
    const rig = await connectedAttachedAdapter();
    try {
      await rig.adapter.sendMessage('turn-1', 'hi');
      rig.events.length = 0;

      rig.drive({ type: 'session.status', properties: { status } });

      expect(rig.events.map((event) => event.type)).toEqual([
        'chat:turn-completed',
        'chat:session-status',
      ]);
      expect(rig.events[0]).toMatchObject({
        type: 'chat:turn-completed',
        turnId: 'turn-1',
        reason: 'completed',
      });
    } finally {
      await rig.dispose();
    }
  });

  it('treats the busy status as active without ending the turn', async () => {
    const rig = await connectedAttachedAdapter();
    try {
      await rig.adapter.sendMessage('turn-1', 'hi');
      rig.events.length = 0;

      rig.drive({
        type: 'session.status',
        properties: { status: { type: 'busy' } },
      });

      expect(rig.events).toEqual([
        expect.objectContaining({
          type: 'chat:session-status',
          status: 'active',
        }),
      ]);
    } finally {
      await rig.dispose();
    }
  });

  it('binds session.error to the live turn and ends it as failed', async () => {
    const rig = await connectedAttachedAdapter();
    try {
      await rig.adapter.sendMessage('turn-1', 'hi');
      rig.events.length = 0;

      rig.drive({
        type: 'session.error',
        properties: { error: 'provider blew up' },
      });

      // The turnId is what lets the bridge attribute the failure; without it
      // the error floats at session level and the terminal carries no message.
      expect(rig.events[0]).toMatchObject({
        type: 'chat:error',
        turnId: 'turn-1',
        message: 'provider blew up',
      });
      expect(rig.events[1]).toMatchObject({
        type: 'chat:turn-completed',
        turnId: 'turn-1',
        reason: 'failed',
      });
    } finally {
      await rig.dispose();
    }
  });

  it('ends the turn as interrupted on the abort ack, and idle does not re-end it', async () => {
    const rig = await connectedAttachedAdapter();
    try {
      await rig.adapter.sendMessage('turn-1', 'hi');
      rig.events.length = 0;

      await rig.adapter.interrupt('turn-1');
      expect(rig.events).toEqual([
        expect.objectContaining({
          type: 'chat:turn-completed',
          turnId: 'turn-1',
          reason: 'interrupted',
        }),
      ]);

      rig.events.length = 0;
      rig.drive({
        type: 'session.status',
        properties: { status: { type: 'idle' } },
      });
      expect(rig.events.map((event) => event.type)).toEqual([
        'chat:session-status',
      ]);
    } finally {
      await rig.dispose();
    }
  });

  it('reports interrupted even when the server idles before the abort ack', async () => {
    const deferred: DeferredAbort = { resolve: () => {} };
    const rig = await connectedAttachedAdapter({ deferAbort: deferred });
    try {
      await rig.adapter.sendMessage('turn-1', 'hi');
      rig.events.length = 0;

      const interrupting = rig.adapter.interrupt('turn-1');
      // The abort POST is still in flight; the server settles first.
      rig.drive({
        type: 'session.status',
        properties: { status: { type: 'idle' } },
      });
      deferred.resolve();
      await interrupting;

      const terminals = rig.events.filter(
        (event) => event.type === 'chat:turn-completed'
      );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({
        turnId: 'turn-1',
        reason: 'interrupted',
      });
    } finally {
      await rig.dispose();
    }
  });

  it('leaves the turn open when the server refuses the abort', async () => {
    const rig = await connectedAttachedAdapter({ abortStatus: 500 });
    try {
      await rig.adapter.sendMessage('turn-1', 'hi');
      rig.events.length = 0;

      await rig.adapter.interrupt('turn-1');
      // No ack, so no evidence the run stopped: closing the turn here would
      // strand every later delta on a finished turn.
      expect(rig.events).toEqual([]);

      // The operator's intent survives, so the server's own idle still reports
      // the stop honestly — as interrupted, exactly once.
      rig.drive({
        type: 'session.status',
        properties: { status: { type: 'idle' } },
      });
      expect(rig.events[0]).toMatchObject({
        type: 'chat:turn-completed',
        turnId: 'turn-1',
        reason: 'interrupted',
      });
    } finally {
      await rig.dispose();
    }
  });

  it('announces an approval decision only when the server accepted it', async () => {
    const accepted = await connectedAttachedAdapter();
    try {
      await accepted.adapter.sendMessage('turn-1', 'hi');
      accepted.events.length = 0;
      await accepted.adapter.respondToApproval('per_1', 'allow');
      expect(accepted.events).toEqual([
        expect.objectContaining({
          type: 'chat:approval-response',
          requestId: 'per_1',
          decision: 'allow',
          turnId: 'turn-1',
        }),
      ]);
    } finally {
      await accepted.dispose();
    }

    const refused = await connectedAttachedAdapter({ permissionStatus: 500 });
    try {
      await refused.adapter.sendMessage('turn-1', 'hi');
      refused.events.length = 0;
      await refused.adapter.respondToApproval('per_1', 'allow');
      expect(refused.events).toEqual([]);
    } finally {
      await refused.dispose();
    }
  });

  it('binds an approval response to the turn that asked, even after idle closed it', async () => {
    const rig = await connectedAttachedAdapter();
    try {
      await rig.adapter.sendMessage('turn-1', 'hi');
      rig.drive({
        type: 'permission.asked',
        properties: {
          requestID: 'per_1',
          toolName: 'bash',
          description: 'Run pwd',
          target: 'pwd',
        },
      });
      // #1412 made idle end the turn, which clears `_currentTurnId`. A human
      // answering after that must still land on the card's own turn.
      rig.drive({
        type: 'session.status',
        properties: { status: { type: 'idle' } },
      });
      rig.events.length = 0;

      await rig.adapter.respondToApproval('per_1', 'allow');

      expect(rig.events).toEqual([
        expect.objectContaining({
          type: 'chat:approval-response',
          requestId: 'per_1',
          turnId: 'turn-1',
        }),
      ]);
    } finally {
      await rig.dispose();
    }
  });
});

/**
 * One provider, one decoder. `session.status` arrives as a bare string OR as
 * the nested `{ type }` object the real server sends, and both OpenCode lanes
 * read the same stream — so the decoding lives in `opencode-shared.ts` rather
 * than in a copy per lane. The copy is what #1412 was: the attached lane
 * compared the bare string only, so the real encoding mapped to nothing and its
 * turns never ended.
 */
describe('OpenCode session.status decoding is shared by both lanes', () => {
  it('decodes both wire encodings and refuses to guess at anything else', () => {
    expect(openCodeStatusType('idle')).toBe('idle');
    expect(openCodeStatusType({ type: 'idle' })).toBe('idle');
    expect(openCodeStatusType({ type: 7 })).toBeUndefined();
    expect(openCodeStatusType(undefined)).toBeUndefined();
    expect(openCodeStatusType(null)).toBeUndefined();
  });

  it.each([
    ['bare string', 'idle'],
    ['nested object (real wire encoding)', { type: 'idle' }],
  ])('maps idle to a session-status on both lanes — %s', (_label, status) => {
    const event = { type: 'session.status', properties: { status } };
    for (const adapter of [
      new OpenCodeProtocolAdapter(),
      new OpenCodeAttachedAdapter(),
    ]) {
      const statuses = driveOpenCodeEvent(adapter, event).filter(
        (chatEvent) => chatEvent.type === 'chat:session-status'
      );
      expect(statuses).toEqual([expect.objectContaining({ status: 'idle' })]);
    }
  });
});

/**
 * Resume honesty (#1409). Neither OpenCode lane can restore a prior
 * conversation on the routes it speaks, so all three rungs of the ladder —
 * descriptor key, capability flag, adapter method — have to say the same thing.
 * A silent no-op `resumeSession` used to say the opposite to any caller that
 * reached it.
 */
describe('OpenCode resume honesty (#1409)', () => {
  it('declares no resume state key, so the binder re-orients a respawned runtime', () => {
    for (const id of ['opencode', 'opencode-attached'] as const) {
      expect(PROVIDER_DESCRIPTORS[id].resumeStateKey).toBeNull();
      expect(PROVIDER_DESCRIPTORS[id].bridgedCapabilities.resume).toBe(false);
      // No blob shape can produce a resume id, so `hasProviderResumeState` in
      // `channel-agent-binder` is false and the fresh runtime is oriented from
      // cursor 0 (#1408) rather than starved by the durable delivered cursor.
      expect(
        providerResumeId(id, {
          openCodeSessionId: 'ses_1',
          lastDeliveredSeq: 12,
        })
      ).toBeUndefined();
    }
  });

  it('refuses resumeSession instead of silently pretending to resume', async () => {
    await expect(
      new OpenCodeProtocolAdapter().resumeSession('ses_1')
    ).rejects.toThrow(/no rebind route/);
    await expect(
      new OpenCodeAttachedAdapter().resumeSession('ses_1')
    ).rejects.toThrow(/no route to rebind/);
  });

  it('refuses resume at the V2 bridge for both registered lanes', async () => {
    for (const id of ['opencode', 'opencode-attached'] as const) {
      await expect(createAdapterV2(id).resumeSession('ses_1')).rejects.toThrow(
        /does not support resume/
      );
    }
  });
});
