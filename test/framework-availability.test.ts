import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getFrameworkAvailability,
  getFrameworkChannelAvailability,
  getFrameworkClientInfo,
  resolveExecutablePath,
} from '../server/frameworks.js';
import type { AgentFramework } from '../server/types.js';
import {
  channelAdapterLaunchRequirement,
  v2Adapters,
} from '../server/protocol-adapters/index.js';

function framework(command: string, id = command): AgentFramework {
  return {
    id,
    displayName: id,
    command,
    continueArgs: [],
    yoloArgs: [],
    parserType: command,
    eventSource: 'parser',
    capabilities: {
      supportsHooks: false,
      supportsContinue: false,
      supportsYolo: false,
      supportsTelemetry: false,
      supportsAttachedRuntime: false,
    },
  };
}

function channelFramework(command: string, id = command): AgentFramework {
  const result = framework(command, id);
  result.capabilities.supportsChannelAgents = true;
  return result;
}

describe('framework CLI availability', () => {
  it('marks a framework installed when its command resolves on PATH', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fw-bin-'));
    const cliPath = path.join(tmpDir, 'agent-cli');
    fs.writeFileSync(cliPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    expect(resolveExecutablePath('agent-cli', { PATH: tmpDir })).toBe(cliPath);
    expect(
      getFrameworkAvailability(framework('agent-cli'), { PATH: tmpDir })
    ).toMatchObject({
      installed: true,
      path: cliPath,
    });
  });

  it('marks a framework unavailable when its command is missing', () => {
    expect(
      getFrameworkAvailability(framework('definitely-missing-relay-agent'), {
        PATH: '',
      })
    ).toEqual({
      installed: false,
      reason: 'definitely-missing-relay-agent CLI not found on PATH',
    });
  });

  it('includes custom future frameworks in the client list', () => {
    const result = getFrameworkClientInfo(
      {
        future: framework('future-agent', 'future'),
      },
      { PATH: '' }
    );

    expect(result.find((framework) => framework.id === 'future')).toMatchObject(
      {
        id: 'future',
        command: 'future-agent',
        availability: {
          installed: false,
          reason: 'future-agent CLI not found on PATH',
        },
      }
    );
  });

  it('marks a channel provider unavailable when its actual adapter command is missing', async () => {
    const result = await getFrameworkChannelAvailability(
      channelFramework('terminal-only-command', 'prime-agent'),
      { PATH: '' }
    );

    expect(result).toEqual({
      available: false,
      reason: 'prime-agent is not installed on this node (not found on PATH).',
      command: 'prime-agent',
    });
  });

  it('ignores terminal command overrides that the channel adapter does not consume', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-override-bin-')
    );
    const overridePath = path.join(tmpDir, 'override-agent');
    fs.writeFileSync(overridePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const prime = channelFramework('prime-agent', 'prime-agent');
    prime.commandOverride = 'override-agent';

    await expect(
      getFrameworkChannelAvailability(prime, { PATH: tmpDir })
    ).resolves.toEqual({
      available: false,
      reason: 'prime-agent is not installed on this node (not found on PATH).',
      command: 'prime-agent',
    });
  });

  it('marks a channel provider available when its actual adapter command resolves', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-channel-bin-'));
    const cliPath = path.join(tmpDir, 'prime-agent');
    fs.writeFileSync(cliPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    await expect(
      getFrameworkChannelAvailability(
        channelFramework('terminal-only-command', 'prime-agent'),
        { PATH: tmpDir }
      )
    ).resolves.toEqual({ available: true, command: 'prime-agent' });
  });

  it('declares a launch requirement for every registered channel adapter', () => {
    expect(
      Object.keys(v2Adapters).filter(
        (providerId) => !channelAdapterLaunchRequirement(providerId)
      )
    ).toEqual([]);
  });

  it('probes the attached OpenCode HTTP runtime without requiring a local CLI', async () => {
    const attached = channelFramework(
      'terminal-only-opencode-command',
      'opencode-attached'
    );
    const probes: Array<{ extra?: Record<string, unknown>; timeout?: number }> =
      [];

    await expect(
      getFrameworkChannelAvailability(
        attached,
        { PATH: '' },
        {
          gatewayProbeOverrides: {
            'opencode-attached': async (extra, timeout) => {
              probes.push({ ...(extra ? { extra } : {}), timeout });
              return { available: true, endpoint: 'http://127.0.0.1:4096' };
            },
          },
        }
      )
    ).resolves.toEqual({
      available: true,
      endpoint: 'http://127.0.0.1:4096',
    });
    expect(probes).toEqual([{ timeout: 500 }]);
  });

  it('probes the Hermes HTTP gateway without requiring a local Hermes CLI', async () => {
    const hermes = channelFramework('hermes', 'hermes');
    const probes: Array<{ endpoint?: string; timeout?: number }> = [];

    await expect(
      getFrameworkChannelAvailability(
        hermes,
        { PATH: '' },
        {
          gatewayProbeOverrides: {
            hermes: async (extra, timeout) => {
              probes.push({
                endpoint:
                  typeof extra?.['endpoint'] === 'string'
                    ? extra['endpoint']
                    : undefined,
                timeout,
              });
              return { available: true, endpoint: 'http://127.0.0.1:8642' };
            },
          },
        }
      )
    ).resolves.toEqual({
      available: true,
      endpoint: 'http://127.0.0.1:8642',
    });
    expect(probes).toEqual([{ endpoint: undefined, timeout: 500 }]);
  });
});
