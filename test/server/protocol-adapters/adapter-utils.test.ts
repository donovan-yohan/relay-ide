import { describe, expect, it, vi } from 'vitest';
import {
  ABANDONED_APPROVAL_REASON,
  reconnectWithStoredConfig,
  resolveAbandonedApprovals,
  type AbandonedApprovalV2,
} from '../../../server/protocol-adapters/adapter-utils.js';
import type { AgentPatchV2 } from '../../../shared/agent-chat-protocol-v2.js';
import { ClaudeProtocolAdapter } from '../../../server/protocol-adapters/claude-adapter.js';
import { CodexNativeProtocolAdapter } from '../../../server/protocol-adapters/codex-native-adapter.js';
import { HermesProtocolAdapter } from '../../../server/protocol-adapters/hermes-adapter.js';
import { OpenCodeProtocolAdapter } from '../../../server/protocol-adapters/opencode-adapter.js';
import { PiAgentProtocolAdapter } from '../../../server/protocol-adapters/pi-agent-adapter.js';
import { PrimeAgentProtocolAdapter } from '../../../server/protocol-adapters/prime-agent-adapter.js';
import type { AdapterConfig } from '../../../server/protocol-adapter-v2.js';

const storedConfig: AdapterConfig = {
  cwd: '/tmp',
  port: 1,
  sessionId: 'relay-session',
  hookToken: 'hook-token',
  configDir: '/tmp',
};

describe('reconnectWithStoredConfig', () => {
  it('tears down and reconnects with the stored config', async () => {
    const order: string[] = [];
    const connect = vi.fn(async () => {
      order.push('connect');
    });

    await reconnectWithStoredConfig({
      config: storedConfig,
      disconnect: async () => {
        order.push('disconnect');
      },
      connect,
    });

    expect(order).toEqual(['disconnect', 'connect']);
    expect(connect).toHaveBeenCalledWith(storedConfig);
  });

  it('throws the default message when no config was stored', async () => {
    const disconnect = vi.fn();
    const connect = vi.fn();

    await expect(
      reconnectWithStoredConfig({ config: null, disconnect, connect })
    ).rejects.toThrow('Cannot reconnect before connect');
    expect(disconnect).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('throws the adapter-supplied message when one is given', async () => {
    await expect(
      reconnectWithStoredConfig({
        config: undefined,
        notConnectedMessage: 'Cannot reconnect before initial connect',
        disconnect: vi.fn(),
        connect: vi.fn(),
      })
    ).rejects.toThrow('Cannot reconnect before initial connect');
  });

  // pi-agent/prime-agent fold the provider session id into the config, and they
  // read it *before* teardown clears adapter state — so the hook must run first.
  it('applies the config transform before disconnect runs', async () => {
    const order: string[] = [];
    const connect = vi.fn(async () => {
      order.push('connect');
    });

    await reconnectWithStoredConfig({
      config: storedConfig,
      transformConfig: (config) => {
        order.push('transform');
        return { ...config, resumeSessionId: 'provider-session' };
      },
      disconnect: async () => {
        order.push('disconnect');
      },
      connect,
    });

    expect(order).toEqual(['transform', 'disconnect', 'connect']);
    expect(connect).toHaveBeenCalledWith({
      ...storedConfig,
      resumeSessionId: 'provider-session',
    });
  });

  it('leaves the stored config untouched when transforming', async () => {
    const config = { ...storedConfig };

    await reconnectWithStoredConfig({
      config,
      transformConfig: (stored) => ({
        ...stored,
        resumeSessionId: 'provider-session',
      }),
      disconnect: vi.fn(),
      connect: vi.fn(),
    });

    expect(config).toEqual(storedConfig);
  });

  it('propagates a connect failure to the caller', async () => {
    await expect(
      reconnectWithStoredConfig({
        config: storedConfig,
        disconnect: vi.fn(),
        connect: async () => {
          throw new Error('transport refused');
        },
      })
    ).rejects.toThrow('transport refused');
  });
});

describe('resolveAbandonedApprovals (#1407)', () => {
  const approval = (
    requestId: string,
    turnId = 'turn-1'
  ): AbandonedApprovalV2 => ({
    requestId,
    turnId,
    card: {
      id: `approval-${requestId}`,
      kind: 'permission',
      description: 'Agent wants to use Bash',
      target: 'rm -rf /',
    },
  });

  it('publishes a terminal card per approval, then one live-state drain', () => {
    const patches: AgentPatchV2[] = [];
    resolveAbandonedApprovals({
      sessionId: 'session-1',
      approvals: [approval('req-a'), approval('req-b', 'turn-2')],
      emitPatch: (patch) => patches.push(patch),
    });

    expect(patches.map((patch) => patch.type)).toEqual([
      'agent-item-updated-v2',
      'agent-item-updated-v2',
      'agent-live-state-updated-v2',
    ]);

    const first = patches[0];
    expect(first?.type === 'agent-item-updated-v2' && first.item).toMatchObject(
      {
        type: 'approval',
        id: 'approval-req-a',
        requestId: 'req-a',
        status: 'cancelled',
        respondedBy: 'timeout',
        decision: { kind: 'cancel' },
        error: ABANDONED_APPROVAL_REASON,
      }
    );
    expect(first?.type === 'agent-item-updated-v2' && first.turnId).toBe(
      'turn-1'
    );
    const second = patches[1];
    expect(second?.type === 'agent-item-updated-v2' && second.turnId).toBe(
      'turn-2'
    );

    const drain = patches[2];
    expect(drain?.type === 'agent-live-state-updated-v2' && drain.live).toEqual(
      {
        waitingOn: null,
        activeRequestIds: [],
      }
    );
  });

  // The transcript must never claim a resolution the wire refused to carry, so
  // the provider is released first and the card follows.
  it('releases the wire before publishing the card', () => {
    const order: string[] = [];
    resolveAbandonedApprovals({
      sessionId: 'session-1',
      approvals: [approval('req-a')],
      emitPatch: (patch) => order.push(patch.type),
      denyOnWire: ({ requestId }) => order.push(`deny:${requestId}`),
    });

    expect(order).toEqual([
      'deny:req-a',
      'agent-item-updated-v2',
      'agent-live-state-updated-v2',
    ]);
  });

  it('emits nothing at all when no approval was outstanding', () => {
    const emitPatch = vi.fn();
    resolveAbandonedApprovals({
      sessionId: 'session-1',
      approvals: [],
      emitPatch,
      denyOnWire: emitPatch,
    });
    expect(emitPatch).not.toHaveBeenCalled();
  });

  it('carries the caller-supplied reason instead of the disconnect default', () => {
    const patches: AgentPatchV2[] = [];
    resolveAbandonedApprovals({
      sessionId: 'session-1',
      approvals: [approval('req-a')],
      emitPatch: (patch) => patches.push(patch),
      reason: 'Approval cancelled: the turn ended before it was answered.',
    });
    const card = patches[0];
    expect(card?.type === 'agent-item-updated-v2' && card.item.error).toBe(
      'Approval cancelled: the turn ended before it was answered.'
    );
  });

  // Provider vocabulary is copied through untouched — the helper only owns how
  // the card ENDS.
  it('preserves the harness-shaped card fields', () => {
    const patches: AgentPatchV2[] = [];
    resolveAbandonedApprovals({
      sessionId: 'session-1',
      approvals: [
        {
          requestId: 'cmd-7',
          turnId: 'turn-1',
          card: {
            id: 'approval-cmd-7',
            kind: 'command',
            description: 'Run command: ls',
            target: 'ls',
            details: { kind: 'command', command: 'ls', cwd: '/tmp' },
            supported: {
              scopes: ['once'],
              amendmentTypes: [],
              canCancel: true,
            },
          },
        },
      ],
      emitPatch: (patch) => patches.push(patch),
    });
    const card = patches[0];
    expect(card?.type === 'agent-item-updated-v2' && card.item).toMatchObject({
      kind: 'command',
      details: { kind: 'command', command: 'ls', cwd: '/tmp' },
      supported: { scopes: ['once'], amendmentTypes: [], canCancel: true },
    });
  });
});

// The shared helper replaced six hand-written reconnect() bodies whose
// not-connected wording already disagreed. The wording is observable, so pin
// each adapter's exact string against the real adapter, not the helper.
describe('adapter reconnect-before-connect messages are unchanged', () => {
  const cases: Array<[string, { reconnect(): Promise<void> }, string]> = [
    ['claude', new ClaudeProtocolAdapter(), 'Cannot reconnect before connect'],
    [
      'codex-native',
      new CodexNativeProtocolAdapter(),
      'Cannot reconnect before connect',
    ],
    [
      'hermes',
      new HermesProtocolAdapter(),
      'Cannot reconnect before initial connect',
    ],
    [
      'opencode',
      new OpenCodeProtocolAdapter(),
      'Cannot reconnect before initial connect',
    ],
    [
      'pi-agent',
      new PiAgentProtocolAdapter(),
      'Cannot reconnect before connect',
    ],
    [
      'prime-agent',
      new PrimeAgentProtocolAdapter(),
      'Cannot reconnect before connect',
    ],
  ];

  for (const [name, adapter, message] of cases) {
    it(`${name} throws "${message}"`, async () => {
      await expect(adapter.reconnect()).rejects.toThrow(message);
    });
  }
});
