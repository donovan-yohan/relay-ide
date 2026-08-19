import { describe, expect, it, vi } from 'vitest';
import { reconnectWithStoredConfig } from '../../../server/protocol-adapters/adapter-utils.js';
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
